import { Redis } from '@upstash/redis';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured on server.' });
  }

  // Use Shanghai date (UTC+8)
  const shanghaiNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const shanghaiDate = shanghaiNow.toISOString().split('T')[0]; // e.g. "2026-03-09"
  const cacheKey = `digest:${shanghaiDate}`;

  // ── Check cache first ──────────────────────────────────────
  let redis;
  try {
    const redisUrl = process.env.STORAGE_KV_REST_API_URL || process.env.KV_REST_API_URL;
    const redisToken = process.env.STORAGE_KV_REST_API_TOKEN || process.env.KV_REST_API_TOKEN;
    if (redisUrl && redisToken) {
      redis = new Redis({ url: redisUrl, token: redisToken });
      const cached = await redis.get(cacheKey);
      if (cached) {
        const text = typeof cached === 'string' ? cached : JSON.stringify(cached);
        return res.status(200).json({ text, cached: true });
      }
    }
  } catch (kvErr) {
    console.warn('Redis read failed, falling through to API:', kvErr.message);
    redis = null;
  }

  // ── No cache — fetch from Anthropic ───────────────────────
  const today = shanghaiNow.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric'
  });

  const prompt = `You are an economics news researcher. Search the web for the latest economics news from the past 24 hours. Then respond with ONLY a raw JSON object — no explanation, no markdown, no code fences, no citations, no extra text before or after.

The JSON must have exactly this shape:
{"micro":[{"headline":"...","summary":"...","url":"https://...","igcse_link":"...","igcse":true,"ib_link":"...","ib":true},{"headline":"...","summary":"...","url":"https://...","igcse_link":"...","igcse":true,"ib_link":"...","ib":true},{"headline":"...","summary":"...","url":"https://...","igcse_link":"...","igcse":true,"ib_link":"...","ib":true}],"macro":[...3 stories same shape...],"global":[...3 stories same shape...]}

Rules:
- micro = individual markets, firms, prices, competition, wages, consumer behaviour
- macro = inflation, interest rates, GDP, unemployment, fiscal/monetary policy, central banks
- global = international trade, exchange rates, globalisation, IMF/World Bank, development
- Each section must have exactly 3 stories from the past 48 hours
- url: the direct URL of the news article you found (must be a real, working https:// link)
- igcse_link: one sentence linking to IGCSE Economics 0455 (e.g. price elasticity, market failure)
- ib_link: one sentence linking to IB Economics (e.g. Unit 2 Microeconomics, Unit 3 Macroeconomics, Unit 4 The Global Economy)
- Keep all string values under 200 characters
- Do NOT include any citations, source tags, or markup inside the JSON strings
- Return ONLY the JSON. Nothing else.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 4000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.error?.message || 'Anthropic API error ' + response.status });
    }

    const data = await response.json();
    const textBlocks = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');


    // ── Save to cache, expires at midnight Shanghai time ─────
    try {
      if (redis) {
        const secondsUntilMidnight = (24 - shanghaiNow.getUTCHours()) * 3600
          - shanghaiNow.getUTCMinutes() * 60
          - shanghaiNow.getUTCSeconds();
        await redis.set(cacheKey, textBlocks, { ex: secondsUntilMidnight });
      }
    } catch (kvErr) {
      console.warn('Redis write failed:', kvErr.message);
    }

    return res.status(200).json({ text: textBlocks, cached: false });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
