// The subscriber list for the daily dispatch.
//
// Redis keys:
//   subscribers       — SET of confirmed addresses
//   pending:<token>   — an address awaiting confirmation, expires after 24h
//   unsub:<token>     — token → address, so an unsubscribe link needs no email in the URL
//   signups:<ip>      — sign-up attempts from one IP this hour
//
// Sign-up is double opt-in: nothing reaches `subscribers` until someone clicks a
// link in an email sent to that address. This is not politeness — it is the only
// thing stopping a stranger adding an address they don't own, which is how a
// sending domain gets spam-flagged.
//
// Files under api/_lib/ are NOT routed as endpoints by Vercel (leading underscore).

import crypto from 'node:crypto';
import { getRedis } from './digest-core.js';

export { getRedis };

export const SUBSCRIBERS_KEY = 'subscribers';

// Resend's free tier allows 100 emails per DAY. One send per subscriber per
// weekday means that daily cap binds long before the 3,000/month one. The cap
// below leaves headroom for confirmation emails and the teacher's own copy.
// Raise it via the MAX_SUBSCRIBERS env var after upgrading the Resend plan.
export const MAX_SUBSCRIBERS = Number(process.env.MAX_SUBSCRIBERS) || 90;

const SIGNUPS_PER_IP_PER_HOUR = 5;

// Every reader-facing link in an email goes through here, so this is the one
// place that decides which domain subscribers are sent to. The fallback is the
// custom domain, not *.vercel.app, because vercel.app is DNS-blocked in
// mainland China — if SITE_URL ever goes missing, failing over to a domain most
// of these readers cannot open is the worst possible default.
export function siteUrl() {
  return (process.env.SITE_URL || 'https://event.getaheadsup.com').replace(/\/+$/, '');
}

export function normaliseEmail(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

// Deliberately permissive. The confirmation email is the real test of whether an
// address exists — a regex only catches typing accidents.
export function isValidEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email);
}

function secret() {
  const s = process.env.SUBSCRIBE_SECRET;
  if (!s) throw new Error('SUBSCRIBE_SECRET is not configured.');
  return s;
}

// Deterministic, so it can be recomputed at send time instead of stored twice,
// and unguessable, so nobody can unsubscribe anyone else.
export function unsubscribeToken(email) {
  return crypto
    .createHmac('sha256', secret())
    .update(normaliseEmail(email))
    .digest('hex')
    .slice(0, 32);
}

export function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

export function unsubscribeUrl(email) {
  return `${siteUrl()}/api/unsubscribe?token=${unsubscribeToken(email)}`;
}

/** True if this IP has room for another sign-up attempt this hour. */
export async function underRateLimit(redis, ip) {
  if (!redis || !ip) return true;
  try {
    const key = `signups:${ip}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 3600);
    return count <= SIGNUPS_PER_IP_PER_HOUR;
  } catch {
    return true; // never block a real person because Redis hiccuped
  }
}

export function clientIp(req) {
  const fwd = req.headers?.['x-forwarded-for'];
  if (!fwd) return null;
  return String(fwd).split(',')[0].trim();
}

/** Every address that should receive the dispatch: the owner plus confirmed subscribers. */
export async function getRecipients(redis) {
  const list = [];
  const owner = normaliseEmail(process.env.DIGEST_TO_EMAIL || '');
  if (owner) list.push(owner);

  if (redis) {
    try {
      const subs = await redis.smembers(SUBSCRIBERS_KEY);
      for (const s of subs || []) {
        const email = normaliseEmail(s);
        if (email) list.push(email);
      }
    } catch (err) {
      console.warn('Could not read subscriber list:', err.message);
    }
  }

  return [...new Set(list)];
}

/** A minimal styled page, for the confirm and unsubscribe links people click. */
export function page({ title, heading, body, status = 200 }) {
  return {
    status,
    html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body { margin:0; background:#faf7f0; color:#1a1a1a;
         font-family:Georgia,'Times New Roman',serif;
         display:flex; align-items:center; justify-content:center;
         min-height:100vh; padding:24px; }
  .card { background:#fff; border:1px solid #e0dbd0; max-width:460px;
          padding:40px 36px; text-align:center; }
  h1 { margin:0 0 14px; font-size:26px; letter-spacing:.5px; }
  p { margin:0 0 10px; font-size:16px; line-height:1.6; color:#3a3a3a; }
  a { color:#8a6d1f; }
</style>
</head>
<body><div class="card"><h1>${heading}</h1>${body}
<p style="margin-top:22px;font-size:13px;">
  <a href="${siteUrl()}">Open The Econ Dispatch &rarr;</a></p>
</div></body></html>`,
  };
}
