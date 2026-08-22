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

// ── Generation ────────────────────────────────────────────────────────────

const PROMPT = `You are an economics news researcher. Search the web for the latest economics news from the past 24 hours. Then respond with ONLY a raw JSON object — no explanation, no markdown, no code fences, no citations, no extra text before or after.

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
- Return ONLY the JSON. Nothing else.`;

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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

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
        messages: [{ role: 'user', content: PROMPT }],
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
    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const check = validateDigest(text);
    if (!check.ok) {
      // Do NOT cache. This is the whole point.
      console.error('Refusing to cache invalid digest:', check.reason);
      return { ok: false, status: 502, error: `Digest failed validation (${check.reason}). Nothing was cached — try again.` };
    }

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

    return { ok: true, text, digest: check.digest, cached: false };

  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, status: 504, error: 'Digest generation is taking longer than usual. Please try again in a moment.' };
    }
    return { ok: false, status: 500, error: err.message };
  } finally {
    clearTimeout(timeout);
  }
}
