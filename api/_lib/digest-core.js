// Shared digest generation. Used by api/digest.js (the website button) and
// api/email-digest.js (the weekday cron + "email it to me" button), so there is
// exactly one code path and one cache.
//
// Files under api/_lib/ are NOT routed as endpoints by Vercel (leading underscore).

import { Redis } from '@upstash/redis';

// claude-sonnet-5 pricing is $2.00/$10.00 per 1M tokens (input/output) as introductory
// pricing through 2026-08-31 — after that it reverts to the standard $3.00/$15.00.
export const ANTHROPIC_MODEL = 'claude-sonnet-5';

export function shanghaiNow() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000);
}

export function shanghaiDateString(now = shanghaiNow()) {
  return now.toISOString().split('T')[0];
}

export function getRedis() {
  const url = process.env.STORAGE_KV_REST_API_URL || process.env.KV_REST_API_URL;
  const token = process.env.STORAGE_KV_REST_API_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    return new Redis({ url, token });
  } catch {
    return null;
  }
}

// ── Validation ────────────────────────────────────────────────────────────
// The 17 March 2026 incident: a failed web search returned prose ("I'm unable to
// access web search functionality...") which was cached as that day's digest and
// served all day. Nothing downstream could tell it apart from a real digest.
// Everything below exists so that can never be cached OR emailed again.

const FAILURE_PHRASES = [
  'unable to access',
  'cannot access',
  "i'm unable",
  'i am unable',
  'no search results',
  'web search functionality',
  'as an ai',
];

export function parseDigest(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const clean = text.replace(/```json|```/g, '').replace(/<[^>]+>/g, '').trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/** Returns { ok: true, digest } or { ok: false, reason }. */
export function validateDigest(text) {
  const lower = (text || '').toLowerCase();
  for (const phrase of FAILURE_PHRASES) {
    // Only treat it as a failure if it appears OUTSIDE the JSON body — a story
    // summary could legitimately contain similar wording.
    const firstBrace = lower.indexOf('{');
    const idx = lower.indexOf(phrase);
    if (idx !== -1 && (firstBrace === -1 || idx < firstBrace)) {
      return { ok: false, reason: `model refused or errored: "${phrase}"` };
    }
  }

  const digest = parseDigest(text);
  if (!digest) return { ok: false, reason: 'no parseable JSON in response' };

  for (const section of ['micro', 'macro', 'global']) {
    const stories = digest[section];
    if (!Array.isArray(stories) || stories.length === 0) {
      return { ok: false, reason: `section "${section}" missing or empty` };
    }
    for (const s of stories) {
      if (!s || typeof s.headline !== 'string' || !s.headline.trim()) {
        return { ok: false, reason: `story in "${section}" has no headline` };
      }
      if (typeof s.url !== 'string' || !/^https:\/\/\S+$/.test(s.url.trim())) {
        return { ok: false, reason: `story in "${section}" has no valid https url` };
      }
    }
  }

  return { ok: true, digest };
}

// ── Repeat protection ─────────────────────────────────────────────────────
// Today's macro and global stories were yesterday's. The model is asked for the
// biggest story in each section, and the biggest story is often the same one for
// days — it has no memory of what it already sent. At one story per section, a
// repeat is not a blemish, it is the whole section.
//
// The obvious fix — listing recent headlines in the prompt and saying "avoid
// these" — was tried and measured. It works, but it makes the model search under
// a dozen avoidance constraints, and that pushed a ~33s run to 50s+, timing out
// two runs in three against Vercel's 60s ceiling. Intermittently missing the
// morning email is far worse than occasionally repeating a story.
//
// So the model does the part it is good at (find the top few stories, fast, with
// no extra constraints) and the code does the part code is good at: pick the
// first candidate in each section that has not been used recently. Deterministic,
// free, and it adds no latency at all.

const RECENT_KEY = 'recent:stories';
// 4 days, not 7. Every excluded headline is another constraint the web search has
// to satisfy, and that costs real time: an unconstrained run takes ~33s, a run
// against a week of exclusions was measured at 50s — close enough to the 60s
// function ceiling to put the morning email at risk. Four days covers the actual
// complaint (today repeating yesterday) with room to spare.
const RECENT_DAYS = 4;
const SECTIONS = ['micro', 'macro', 'global'];

/** Compare by host+path: ignores http/https, www, trailing slash, and tracking query strings. */
function urlFingerprint(u) {
  try {
    const parsed = new URL(String(u).trim());
    return (parsed.hostname.replace(/^www\./, '') + parsed.pathname.replace(/\/+$/, '')).toLowerCase();
  } catch {
    return String(u ?? '').trim().toLowerCase();
  }
}

async function getRecentStories(redis) {
  if (!redis) return [];
  try {
    const raw = await redis.get(RECENT_KEY);
    const list = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
    if (!Array.isArray(list)) return [];
    const cutoff = Date.now() - RECENT_DAYS * 86400000;
    return list.filter(s => s && typeof s.ts === 'number' && s.ts > cutoff);
  } catch (err) {
    console.warn('Could not read recent stories:', err.message);
    return [];
  }
}

async function rememberStories(redis, digest, dateLabel) {
  if (!redis) return;
  try {
    const previous = await getRecentStories(redis);
    const added = [];
    for (const section of SECTIONS) {
      for (const s of digest[section] || []) {
        added.push({ section, headline: s.headline, url: s.url, date: dateLabel, ts: Date.now() });
      }
    }
    await redis.set(RECENT_KEY, JSON.stringify([...previous, ...added]));
  } catch (err) {
    // Non-fatal: a digest that sends beats a digest lost to bookkeeping.
    console.warn('Could not record stories for repeat-checking:', err.message);
  }
}

// ── Generation ────────────────────────────────────────────────────────────

const CANDIDATES_PER_SECTION = 2;

// Bounds worst-case latency. Too low and the model cannot find enough distinct
// stories and the response fails validation; 8 leaves room for a few searches
// per section plus retries on a thin result.
const MAX_SEARCHES = 8;

function buildPrompt(recent) {
  // A short list of what has run recently. This is the layer that catches the same
  // EVENT reported by a different outlet — a case no URL comparison can see, since
  // the URLs genuinely differ. It was too slow to afford when adaptive thinking was
  // on; with thinking disabled there is room for it.
  const avoid = recent.length
    ? `

RECENTLY COVERED — do not report these events again, even from a different outlet
or with a new development. Choose a different story:
${recent.slice(-9).map(s => `- ${s.headline}`).join('\n')}`
    : '';

  return `You are an economics news researcher. Search the web for the latest economics news from the past 24 hours. Then respond with ONLY a raw JSON object — no explanation, no markdown, no code fences, no citations, no extra text before or after.

The JSON must have exactly this shape:
{"micro":[{"headline":"...","summary":"...","url":"https://...","igcse_link":"...","igcse":true,"ib_link":"...","ib":true}],"macro":[...same shape...],"global":[...same shape...]}

Rules:
- micro = ONE firm, market or product: prices, competition, costs, consumer behaviour
- macro = ONE economy as a whole: inflation, interest rates, GDP, unemployment, central banks, fiscal/monetary policy
- global = BETWEEN economies: trade, tariffs, exchange rates, globalisation, IMF/World Bank, development
- Sort by the level the story operates at, not by its subject matter. A tariff dispute
  is global even though it affects prices; a national jobs report is macro even though
  it concerns wages; a single company's results are micro even if the firm is huge.
- Give exactly ${CANDIDATES_PER_SECTION} stories per section, from the past 48 hours, ordered most significant first
- The ${CANDIDATES_PER_SECTION} stories in a section must be about genuinely different events, not the same event from different outlets
- url: the direct URL of the news article you found (must be a real, working https:// link)
- igcse_link: one sentence linking to IGCSE Economics 0455 (e.g. price elasticity, market failure)
- ib_link: one sentence linking to IB Economics (e.g. Unit 2 Microeconomics, Unit 3 Macroeconomics, Unit 4 The Global Economy)
- Keep all string values under 200 characters
- Do NOT include any citations, source tags, or markup inside the JSON strings
- Return ONLY the JSON. Nothing else.${avoid}`;
}

/**
 * Narrow each section's candidates down to the single story that runs today:
 * the most significant one not used in the last RECENT_DAYS.
 *
 * Returns { digest, repeated } where `repeated` counts sections in which every
 * candidate had already been sent, so the freshest available was used anyway.
 * Running a repeat always beats running an empty section.
 */
function pickFreshStories(candidates, recent) {
  const seen = new Set(recent.map(s => urlFingerprint(s.url)));
  const digest = {};
  let repeated = 0;

  for (const section of SECTIONS) {
    const options = Array.isArray(candidates[section]) ? candidates[section] : [];
    const fresh = options.find(s => !seen.has(urlFingerprint(s.url)));

    if (fresh) {
      digest[section] = [fresh];
      // Guard against the same story appearing in two sections of one digest.
      seen.add(urlFingerprint(fresh.url));
    } else if (options.length) {
      digest[section] = [options[0]];
      repeated++;
    } else {
      digest[section] = [];
    }
  }

  return { digest, repeated };
}

/**
 * Get today's digest, from cache if present, otherwise from Anthropic.
 * Broken responses are never cached.
 *
 * @param {object} opts
 * @param {number} opts.timeoutMs  abort the Anthropic call after this long
 * @returns {Promise<{ok: boolean, text?: string, digest?: object, cached?: boolean, status?: number, error?: string}>}
 */
export async function getDigest({ timeoutMs = 55000 } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, status: 500, error: 'API key not configured on server.' };

  const now = shanghaiNow();
  const cacheKey = `digest:${shanghaiDateString(now)}`;
  const redis = getRedis();

  // ── Cache ───────────────────────────────────────────────────────────────
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const text = typeof cached === 'string' ? cached : JSON.stringify(cached);
        const check = validateDigest(text);
        if (check.ok) {
          return { ok: true, text, digest: check.digest, cached: true };
        }
        // Poisoned entry from an older deploy — bin it and regenerate.
        console.warn('Discarding invalid cached digest:', check.reason);
        await redis.del(cacheKey).catch(() => {});
      }
    } catch (kvErr) {
      console.warn('Redis read failed, falling through to API:', kvErr.message);
    }
  }

  // ── Generate ────────────────────────────────────────────────────────────
  // A single call, with the whole budget. No retry: the picker below removes
  // repeats without needing one, and a second generation would not fit inside
  // Vercel's 60s ceiling anyway.
  const recent = await getRecentStories(redis);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs - 3000);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 4000,
        // Sonnet 5 runs ADAPTIVE THINKING when `thinking` is omitted — it is not
        // off by default. This task is retrieval and formatting, not reasoning,
        // and the thinking pass was costing enough latency to blow the 60s
        // function ceiling as soon as we asked for more than one story a section.
        thinking: { type: 'disabled' },
        output_config: { effort: 'medium' },
        // web_search_20250305 (not the newer _20260209 variant, which runs an extra
        // server-side dynamic-filtering/code-execution pass and was too slow to
        // finish inside Vercel's 60s function limit).
        //
        // max_uses caps the number of search rounds, which is what actually drives
        // latency here. Without it, asking for 2 stories per section instead of 1
        // took a 38s run to 54s and blew the 60s function ceiling every time.
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_SEARCHES }],
        messages: [{ role: 'user', content: buildPrompt(recent) }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return {
        ok: false,
        status: response.status,
        error: err.error?.message || 'Anthropic API error ' + response.status,
      };
    }

    const data = await response.json();
    const raw = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');

    const check = validateDigest(raw);
    if (!check.ok) {
      // Do NOT cache. This is the whole point.
      console.error('Refusing to cache invalid digest:', check.reason);
      return { ok: false, status: 502, error: `Digest failed validation (${check.reason}). Nothing was cached — try again.` };
    }

    // Several candidates per section come back; exactly one per section goes out.
    const { digest, repeated } = pickFreshStories(check.digest, recent);
    if (repeated) {
      console.warn(`${repeated} section(s) had no unused candidate; used the freshest available.`);
    }

    // Cache the PICKED digest, not the raw candidate list, so a cache hit serves
    // the same three stories the first visitor saw rather than re-picking later.
    const text = JSON.stringify(digest);

    if (redis) {
      try {
        const secondsUntilMidnight = (24 - now.getUTCHours()) * 3600
          - now.getUTCMinutes() * 60
          - now.getUTCSeconds();
        await redis.set(cacheKey, text, { ex: secondsUntilMidnight });
      } catch (kvErr) {
        console.warn('Redis write failed:', kvErr.message);
      }
    }

    // Recorded only once the digest is definitely being used, so a discarded
    // attempt never blocks its own stories from appearing tomorrow.
    await rememberStories(redis, digest, shanghaiDateString(now));

    return { ok: true, text, digest, cached: false, repeated: repeated || undefined };

  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, status: 504, error: 'Digest generation is taking longer than usual. Please try again in a moment.' };
    }
    return { ok: false, status: 500, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}
