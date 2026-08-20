import { Redis } from '@upstash/redis';

const MOONSHOT_MODEL = 'kimi-k2.6';
const WEB_SEARCH_TOOLS = [
  { type: 'builtin_function', function: { name: '$web_search' } }
];
const MAX_TOOL_TURNS = 6; // guards against a runaway tool-call loop

async function callMoonshot(apiKey, messages) {
  const response = await fetch('https://api.moonshot.cn/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: MOONSHOT_MODEL,
      max_tokens: 4000,
      messages,
      tools: WEB_SEARCH_TOOLS,
      // kimi-k2.6 only executes $web_search reliably with thinking mode on
      thinking: { type: 'enabled' }
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const message = err.error?.message || `Moonshot API error ${response.status}`;
    const httpError = new Error(message);
    httpError.status = response.status;
    throw httpError;
  }

  return response.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const apiKey = process.env.MOONSHOT_API_KEY;
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

  // ── No cache — fetch from Moonshot ────────────────────────
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

  const messages = [{ role: 'user', content: prompt }];

  try {
    let finalText = '';

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const data = await callMoonshot(apiKey, messages);
      const choice = data.choices[0];
      const message = choice.message;

      if (choice.finish_reason === 'tool_calls' && message.tool_calls?.length) {
        messages.push(message);
        for (const toolCall of message.tool_calls) {
          // $web_search is executed by Moonshot itself — just echo the arguments back.
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: toolCall.function.arguments
          });
        }
        continue;
      }

      finalText = message.content || '';
      break;
    }

    // ── Save to cache, expires at midnight Shanghai time ─────
    try {
      if (redis) {
        const secondsUntilMidnight = (24 - shanghaiNow.getUTCHours()) * 3600
          - shanghaiNow.getUTCMinutes() * 60
          - shanghaiNow.getUTCSeconds();
        await redis.set(cacheKey, finalText, { ex: secondsUntilMidnight });
      }
    } catch (kvErr) {
      console.warn('Redis write failed:', kvErr.message);
    }

    return res.status(200).json({ text: finalText, cached: false });

  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
}
