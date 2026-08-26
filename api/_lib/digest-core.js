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
// Without this, the digest repeats itself. The model is asked for "the biggest
// macro story", and the biggest macro story is often the same one for three days
// running — it has no memory of what it sent yesterday. At one story per section
// a repeat is not a blemish, it is the whole section.
//
// Two layers, because neither alone is enough:
//   1. the recent headlines go into the prompt, so the model avoids the same
//      EVENT even when a different outlet's article would have a different URL;
//   2. returned URLs are checked against recent ones in code, because a prompt
//      instruction is a request and this needs a guarantee.

const RECENT_KEY = 'recent:stories';
const RECENT_DAYS = 7;
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

/** Stories in `digest` whose URL was already used in the last RECENT_DAYS. */
function findRepeats(digest, recent) {
  const seen = new Map(recent.map(s => [urlFingerprint(s.url), s]));
  const repeats = [];
  for (const section of SECTIONS) {
    for (const s of digest[section] || []) {
      const hit = seen.get(urlFingerprint(s.url));
      if (hit) repeats.push({ section, headline: s.headline, lastSent: hit.date });
    }
  }
  return repeats;
}

// ── Generation ────────────────────────────────────────────────────────────

function buildPrompt(recent, { insist = false } = {}) {
  let exclusions = '';

  if (recent.length) {
    const lines = recent
      .slice(-30)
      .map(s => `- [${s.section}] ${s.headline}`)
      .join('\n');

    exclusions = `

ALREADY SENT IN THE LAST ${RECENT_DAYS} DAYS — do not use any of these again:
${lines}

Do not return any of the stories above, and do not return a different article
about the same underlying event. If the biggest story in a section is one you
have already covered, choose the next most significant story instead. A slightly
smaller genuinely new story is always better than repeating one.`;
  }

  if (insist) {
    exclusions += `

IMPORTANT: your previous attempt returned a story that had already been sent.
Choose different stories. Search for developments from the last 24 hours
specifically, rather than the biggest story of the week.`;
  }

  return `You are an economics news researcher. Search the web for the latest economics news from the past 24 hours. Then respond with ONLY a raw JSON object — no explanation, no markdown, no code fences, no citations, no extra text before or after.

The JSON must have exactly this shape:
{"micro":[{"headline":"...","summary":"...","url":"https://...","igcse_link":"...","igcse":true,"ib_link":"...","ib":true}],"macro":[...1 story same shape...],"global":[...1 story same shape...]}

Rules:
- micro = individual markets, firms, prices, competition, wages, consumer behaviour
- macro = inflation, interest rates, GDP, unemployment, fiscal/monetary policy, central banks
- global = international trade, exchange rates, globalisation, IMF/World Bank, development
- Each section must have exactly 1 story from the past 48 hours
- url: the direct URL of the news article you found (must be a real, working https:// link)
- igcse_link: one sentence linking to IGCSE Economics 0455 (e.g. price elasticity, market failure)
- ib_link: one sentence linking to IB Economics (e.g. Unit 2 Microeconomics, Unit 3 Macroeconomics, Unit 4 The Global Economy)
- Keep all string values under 200 characters
- Do NOT include any citations, source tags, or markup inside the JSON strings
- Return ONLY the JSON. Nothing else.${exclusions}`;
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
  // One retry is budgeted for the case where the model returns a story already
  // sent. Both attempts share `timeoutMs`, so a retry can never push the function
  // past Vercel's 60s ceiling — the first attempt is capped at 60% of the budget
  // to leave room for a second, and the retry is skipped if too little time remains.
  const deadline = Date.now() + timeoutMs;
  const recent = await getRecentStories(redis);

  async function attempt(insist, budgetMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
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
          // web_search_20250305 (not the newer _20260209 variant, which runs an extra
          // server-side dynamic-filtering/code-execution pass and was too slow to
          // finish inside Vercel's 60s function limit)
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: [{ role: 'user', content: buildPrompt(recent, { insist }) }],
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return { ok: false, status: response.status, error: err.error?.message || 'Anthropic API error ' + response.status };
      }

      const data = await response.json();
      const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const check = validateDigest(text);
      if (!check.ok) {
        // Do NOT cache. This is the whole point.
        console.error('Refusing to cache invalid digest:', check.reason);
        return { ok: false, status: 502, error: `Digest failed validation (${check.reason}). Nothing was cached — try again.` };
      }
      return { ok: true, text, digest: check.digest };
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    // The first attempt gets essentially the whole budget. An earlier version
    // reserved 40% of it for a possible retry and that starved the normal case:
    // a healthy run takes ~33s, so a 60%-of-55s cap timed out almost every time.
    // The exclusion list in the prompt is what actually prevents repeats; the
    // retry is only a safety net, and a safety net must not cost a 504.
    let result = await attempt(false, timeoutMs - 3000);
    if (!result.ok) return result;

    let repeats = findRepeats(result.digest, recent);
    if (repeats.length) {
      const remaining = deadline - Date.now();
      console.warn(`Repeated ${repeats.length} story/stories:`,
        repeats.map(r => `${r.section} (last sent ${r.lastSent})`).join(', '));

      // Only worth trying if a whole second generation genuinely fits. Usually it
      // does not, and that is fine — the repeat is reported, and the story is
      // recorded so tomorrow's prompt excludes it.
      if (remaining > 25000) {
        const second = await attempt(true, remaining - 2000);
        if (second.ok) {
          const stillRepeated = findRepeats(second.digest, recent);
          // Keep the retry only if it actually improved matters.
          if (stillRepeated.length < repeats.length) {
            result = second;
            repeats = stillRepeated;
          }
        }
        // A failed retry is not fatal — the first attempt was valid, just stale.
      } else {
        console.warn('Not enough time left to retry; sending the digest as-is.');
      }
    }

    if (redis) {
      try {
        const secondsUntilMidnight = (24 - now.getUTCHours()) * 3600
          - now.getUTCMinutes() * 60
          - now.getUTCSeconds();
        await redis.set(cacheKey, result.text, { ex: secondsUntilMidnight });
      } catch (kvErr) {
        console.warn('Redis write failed:', kvErr.message);
      }
    }

    // Recorded only once the digest is definitely being used, so a discarded
    // attempt never blocks its own stories from appearing tomorrow.
    await rememberStories(redis, result.digest, shanghaiDateString(now));

    return { ok: true, text: result.text, digest: result.digest, cached: false, repeated: repeats.length || undefined };

  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, status: 504, error: 'Digest generation is taking longer than usual. Please try again in a moment.' };
    }
    return { ok: false, status: 500, error: err.message };
  }
  // No clearTimeout here: each attempt() owns and clears its own timer.
}
