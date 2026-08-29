// Website "Fetch Today's Digest" button.
// All generation, caching and validation lives in api/_lib/digest-core.js so the
// email endpoint uses the identical code path and the identical cache.
//
// This endpoint is open to anyone — the site is public and the button has to
// work without a password. Two things bound what that can cost:
//   1. the per-IP ceiling below, which stops a script hammering the endpoint
//   2. the daily generation ceiling inside getDigest(), which is the real cost
//      bound — a cached response is free, so only actual generations are capped
// The cron path passes `trusted: true` and is exempt from (2).

import { getDigest, getRedis } from './_lib/digest-core.js';

// Generous on purpose: a whole school can sit behind one NAT address, and
// almost all of these requests are free cache reads. This is a runaway-script
// guard, not a usage limit.
const FETCHES_PER_IP_PER_HOUR = 60;

function clientIp(req) {
  const fwd = req.headers?.['x-forwarded-for'];
  return fwd ? String(fwd).split(',')[0].trim() : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const redis = getRedis();
  const ip = clientIp(req);

  if (redis && ip) {
    try {
      const key = `fetches:${ip}`;
      const n = await redis.incr(key);
      if (n === 1) await redis.expire(key, 3600);
      if (n > FETCHES_PER_IP_PER_HOUR) {
        return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
      }
    } catch {
      // Never turn a real visitor away because Redis hiccuped. The generation
      // ceiling inside getDigest() still applies, and it fails closed.
    }
  }

  const result = await getDigest({ timeoutMs: 55000 });

  if (!result.ok) {
    return res.status(result.status || 500).json({ error: result.error });
  }

  return res.status(200).json({ text: result.text, cached: result.cached });
}
