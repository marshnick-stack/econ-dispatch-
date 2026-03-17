import { Redis } from '@upstash/redis';

export default async function handler(req, res) {
  const password = req.query.password || req.body?.password;
  if (password !== process.env.TEACHER_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  const shanghaiNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const shanghaiDate = shanghaiNow.toISOString().split('T')[0];
  const cacheKey = `digest:${shanghaiDate}`;

  try {
    const redis = new Redis({
      url: process.env.STORAGE_KV_REST_API_URL || process.env.KV_REST_API_URL,
      token: process.env.STORAGE_KV_REST_API_TOKEN || process.env.KV_REST_API_TOKEN,
    });
    await redis.del(cacheKey);
    return res.status(200).json({ ok: true, deleted: cacheKey });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
