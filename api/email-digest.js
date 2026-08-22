// Emails today's digest via Resend.
//
// Two ways in:
//   1. Vercel Cron — GET with `Authorization: Bearer $CRON_SECRET`
//      (weekday mornings Shanghai time; see the schedule in vercel.json)
//   2. Manually    — POST/GET with ?password=$TEACHER_PASSWORD
//      (the "Email it to me" button on the site)
//
// It never emails a digest that fails validation — see the poisoned-cache note
// in api/_lib/digest-core.js. A broken morning email every day until noticed is
// worse than no email.

import { getDigest, getRedis, shanghaiNow, shanghaiDateString } from './_lib/digest-core.js';

const SECTIONS = [
  { key: 'micro',  label: 'Micro',  emoji: '📊' },
  { key: 'macro',  label: 'Macro',  emoji: '📈' },
  { key: 'global', label: 'Global', emoji: '🌍' },
];

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function isAuthorised(req) {
  const auth = req.headers?.authorization || '';
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && auth === `Bearer ${cronSecret}`) return 'cron';

  const password = req.query?.password || req.body?.password;
  if (process.env.TEACHER_PASSWORD && password === process.env.TEACHER_PASSWORD) return 'manual';

  return null;
}

function renderStory(s) {
  const url = esc(s.url);
  const bits = [];
  if (s.summary) {
    bits.push(`<p style="margin:0 0 10px;font-size:15px;line-height:1.55;color:#2b2b2b;">${esc(s.summary)}</p>`);
  }
  if (s.igcse_link) {
    bits.push(`<p style="margin:0 0 6px;font-size:13px;line-height:1.5;color:#5a5a5a;"><strong style="color:#1a1a1a;">IGCSE&nbsp;0455:</strong> ${esc(s.igcse_link)}</p>`);
  }
  if (s.ib_link) {
    bits.push(`<p style="margin:0 0 6px;font-size:13px;line-height:1.5;color:#5a5a5a;"><strong style="color:#1a1a1a;">IB:</strong> ${esc(s.ib_link)}</p>`);
  }
  return `
    <tr><td style="padding:0 0 4px;">
      <a href="${url}" style="font-family:Georgia,'Times New Roman',serif;font-size:19px;font-weight:700;color:#1a1a1a;text-decoration:none;line-height:1.3;">${esc(s.headline)}</a>
    </td></tr>
    <tr><td style="padding:8px 0 0;">
      ${bits.join('')}
      <p style="margin:10px 0 0;font-size:12px;"><a href="${url}" style="color:#8a6d1f;text-decoration:none;letter-spacing:.5px;">READ THE ARTICLE &rarr;</a></p>
    </td></tr>`;
}

export function renderEmail(digest, dateLabel) {
  const sections = SECTIONS.map(({ key, label, emoji }) => {
    const stories = Array.isArray(digest[key]) ? digest[key] : [];
    if (!stories.length) return '';
    return `
      <tr><td style="padding:26px 0 10px;border-top:1px solid #e0dbd0;">
        <span style="font-family:Georgia,serif;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#8a6d1f;">${emoji}&nbsp;&nbsp;${label}</span>
      </td></tr>
      ${stories.map(renderStory).join('')}`;
  }).join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<title>Econ Dispatch</title>
</head>
<body style="margin:0;padding:0;background:#faf7f0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf7f0;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #e0dbd0;padding:30px 32px;">
      <tr><td style="padding-bottom:4px;">
        <h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:27px;letter-spacing:1px;color:#1a1a1a;">Econ Dispatch</h1>
      </td></tr>
      <tr><td style="padding-bottom:18px;">
        <span style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#8a8070;">${esc(dateLabel)}</span>
      </td></tr>
      ${sections}
      <tr><td style="padding:28px 0 0;border-top:1px solid #e0dbd0;">
        <p style="margin:0;font-size:11px;color:#8a8070;line-height:1.6;">
          Three stories, one per section, from the last 48 hours.<br>
          <a href="https://econ-dispatch.vercel.app" style="color:#8a6d1f;text-decoration:none;">Open the full dispatch &rarr;</a>
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

export function renderPlainText(digest, dateLabel) {
  const lines = [`ECON DISPATCH — ${dateLabel}`, ''];
  for (const { key, label } of SECTIONS) {
    const stories = Array.isArray(digest[key]) ? digest[key] : [];
    if (!stories.length) continue;
    lines.push(label.toUpperCase());
    for (const s of stories) {
      lines.push(`  ${s.headline}`);
      if (s.summary) lines.push(`  ${s.summary}`);
      if (s.igcse_link) lines.push(`  IGCSE 0455: ${s.igcse_link}`);
      if (s.ib_link) lines.push(`  IB: ${s.ib_link}`);
      lines.push(`  ${s.url}`);
      lines.push('');
    }
  }
  lines.push('https://econ-dispatch.vercel.app');
  return lines.join('\n');
}

export default async function handler(req, res) {
  const via = isAuthorised(req);
  if (!via) return res.status(401).json({ error: 'Unauthorised' });

  const to = process.env.DIGEST_TO_EMAIL;
  const from = process.env.DIGEST_FROM_EMAIL || 'Econ Dispatch <dispatch@getaheadsup.com>';
  const resendKey = process.env.RESEND_API_KEY;

  if (!resendKey) return res.status(500).json({ error: 'RESEND_API_KEY not configured.' });
  if (!to) return res.status(500).json({ error: 'DIGEST_TO_EMAIL not configured.' });

  const now = shanghaiNow();
  const dateKey = shanghaiDateString(now);
  const redis = getRedis();
  const sentKey = `emailed:${dateKey}`;

  // Don't send twice in a day from the cron (Vercel can retry). A manual press
  // always sends — that is the point of pressing it.
  if (via === 'cron' && redis) {
    try {
      const already = await redis.get(sentKey);
      if (already) {
        return res.status(200).json({ ok: true, skipped: 'already emailed today', date: dateKey });
      }
    } catch { /* if Redis is down, prefer sending over not sending */ }
  }

  // Leave headroom inside the 60s function limit for the Resend call.
  const result = await getDigest({ timeoutMs: 48000 });
  if (!result.ok) {
    return res.status(result.status || 500).json({ error: result.error, emailed: false });
  }

  const dateLabel = now.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `Econ Dispatch — ${dateLabel}`,
      html: renderEmail(result.digest, dateLabel),
      text: renderPlainText(result.digest, dateLabel),
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    return res.status(502).json({ error: err.message || `Resend error ${resp.status}`, emailed: false });
  }

  const sent = await resp.json().catch(() => ({}));

  if (redis) {
    try {
      const secondsUntilMidnight = (24 - now.getUTCHours()) * 3600
        - now.getUTCMinutes() * 60 - now.getUTCSeconds();
      await redis.set(sentKey, new Date().toISOString(), { ex: Math.max(60, secondsUntilMidnight) });
    } catch { /* non-fatal */ }
  }

  return res.status(200).json({
    ok: true, emailed: true, to, via,
    cachedDigest: result.cached, id: sent.id || null,
  });
}
