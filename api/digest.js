import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured on server.' });
  }

  // Use Shanghai date (UTC+8)
  const shanghaiDate = new Date(Date.now() + 8 * 60 * 60 * 1000)
    .toISOString().split('T')[0]; // e.g. "2026-03-09"
  const cacheKey = `digest:${shanghaiDate}`;

  // ── Check cache first ──────────────────────────────────────
  try {
    const cached = await kv.get(cacheKey);
    if (cached) {
      return res.status(200).json({ text: cached, cached: true });
    }
  } catch (kvErr) {
    // If KV is unavailable, fall through to API call
    console.warn('KV read failed, falling through to API:', kvErr.message);
  }

  // ── No cache — fetch from Anthropic ───────────────────────
  const today = new Date(Date.now() + 8 * 60 * 60 * 1000)
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  const prompt = `You are an economics news researcher. Today is ${today}.

Search the web for today's top economics news. Then respond with ONLY a raw JSON object — no explanation, no markdown, no code fences, no citations, no extra text before or after.

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
        model: 'claude-sonnet-4-20250514',
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
      const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
      const secondsUntilMidnight = (24 - now.getHours()) * 3600 - now.getMinutes() * 60 - now.getSeconds();
      await kv.set(cacheKey, textBlocks, { ex: secondsUntilMidnight });
    } catch (kvErr) {
      console.warn('KV write failed:', kvErr.message);
    }

    return res.status(200).json({ text: textBlocks, cached: false });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
