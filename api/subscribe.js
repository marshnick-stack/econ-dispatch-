// Step 1 of sign-up: take an address and send it a confirmation link.
// Nothing is added to the subscriber list here — see api/confirm.js.

import {
  getRedis, normaliseEmail, isValidEmail, newToken, siteUrl,
  underRateLimit, clientIp, SUBSCRIBERS_KEY, MAX_SUBSCRIBERS,
} from './_lib/subscribers.js';

const PENDING_TTL_SECONDS = 24 * 60 * 60;

function confirmEmail(confirmUrl) {
  return `<!doctype html>
<html><body style="margin:0;background:#faf7f0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf7f0;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border:1px solid #e0dbd0;padding:32px;">
      <tr><td>
        <h1 style="margin:0 0 16px;font-family:Georgia,serif;font-size:24px;color:#1a1a1a;">One more click</h1>
        <p style="margin:0 0 20px;font-family:Georgia,serif;font-size:15px;line-height:1.6;color:#3a3a3a;">
          Confirm this address and you'll get The Econ Dispatch each weekday morning &mdash;
          three economics stories, one each from micro, macro and global, with the
          IGCSE and IB syllabus links spelled out.
        </p>
        <p style="margin:0 0 24px;">
          <a href="${confirmUrl}" style="display:inline-block;background:#1a1a1a;color:#faf7f0;font-family:Georgia,serif;font-size:15px;padding:13px 26px;text-decoration:none;">Confirm my subscription</a>
        </p>
        <p style="margin:0;font-family:Georgia,serif;font-size:12px;line-height:1.6;color:#8a8070;">
          The link works for 24 hours. If you didn't ask for this, ignore this
          email &mdash; nothing will be sent to you and the address is discarded.
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const body = req.body || {};

  // Honeypot: a field hidden from people but filled in by scripted form-fillers.
  // Answer 200 so the bot has nothing to learn from the response.
  if (body.website) {
    return res.status(200).json({ ok: true, message: 'Check your inbox for a confirmation link.' });
  }

  const email = normaliseEmail(body.email);
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "That doesn't look like an email address." });
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return res.status(500).json({ error: 'Email is not configured on the server.' });
  if (!process.env.SUBSCRIBE_SECRET) {
    return res.status(500).json({ error: 'SUBSCRIBE_SECRET is not configured on the server.' });
  }

  const redis = getRedis();
  if (!redis) return res.status(500).json({ error: 'The subscriber list is unavailable right now.' });

  if (!(await underRateLimit(redis, clientIp(req)))) {
    return res.status(429).json({ error: 'Too many sign-ups from here just now. Try again in an hour.' });
  }

  try {
    // Already on the list: say so plainly rather than sending another email.
    if (await redis.sismember(SUBSCRIBERS_KEY, email)) {
      return res.status(200).json({ ok: true, message: "You're already subscribed — nothing more to do." });
    }

    const count = await redis.scard(SUBSCRIBERS_KEY);
    if (count >= MAX_SUBSCRIBERS) {
      return res.status(503).json({
        error: 'The list is full at the moment. Try again in a few days.',
      });
    }

    const token = newToken();
    await redis.set(`pending:${token}`, email, { ex: PENDING_TTL_SECONDS });

    const from = process.env.DIGEST_FROM_EMAIL || 'Econ Dispatch <dispatch@getaheadsup.com>';
    const confirmUrl = `${siteUrl()}/api/confirm?token=${token}`;

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [email],
        subject: 'Confirm your Econ Dispatch subscription',
        html: confirmEmail(confirmUrl),
        text: `Confirm your Econ Dispatch subscription by opening this link:\n\n${confirmUrl}\n\n`
            + `The link works for 24 hours. If you didn't ask for this, ignore this email.`,
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      console.error('Resend error on confirmation email:', err);
      return res.status(502).json({ error: 'Could not send the confirmation email. Try again shortly.' });
    }

    return res.status(200).json({ ok: true, message: 'Check your inbox for a confirmation link.' });

  } catch (err) {
    console.error('subscribe failed:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Try again shortly.' });
  }
}
