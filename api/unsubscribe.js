// Removal from the list. Linked at the bottom of every dispatch.
//
// Two ways in, both required:
//   GET  — a person clicking the link, gets a page back
//   POST — Gmail/Apple Mail's own "Unsubscribe" button, via the
//          List-Unsubscribe-Post header. No confirmation step is allowed here:
//          one request means gone.
//
// This deletes the address rather than flagging it. Under PIPL the unsubscribe
// link is the deletion route people are entitled to, so it has to actually delete.

import { getRedis, unsubscribeToken, page, SUBSCRIBERS_KEY } from './_lib/subscribers.js';

function send(res, { status, html }) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(status).send(html);
}

export default async function handler(req, res) {
  const token = String(req.query?.token || req.body?.token || '');
  const oneClick = req.method === 'POST';

  const redis = getRedis();

  if (!token || !redis) {
    if (oneClick) return res.status(400).json({ error: 'Bad request.' });
    return send(res, page({
      status: 400,
      title: 'Link not valid',
      heading: 'That link looks incomplete',
      body: '<p>Copy the whole unsubscribe link from the email, including everything after the question mark.</p>',
    }));
  }

  try {
    const email = await redis.get(`unsub:${token}`);

    if (!email) {
      // Already gone, or never there. Either way the outcome the person wants is
      // the outcome they have, so say so rather than showing an error.
      if (oneClick) return res.status(200).json({ ok: true });
      return send(res, page({
        title: 'Unsubscribed',
        heading: "You're unsubscribed",
        body: '<p>This address is not on the list. Nothing further will be sent to it.</p>',
      }));
    }

    await redis.srem(SUBSCRIBERS_KEY, email);
    await redis.del(`unsub:${token}`);

    if (oneClick) return res.status(200).json({ ok: true });

    return send(res, page({
      title: 'Unsubscribed',
      heading: "You're unsubscribed",
      body: '<p>Your address has been deleted from the list. No more dispatches will arrive.</p>'
          + '<p style="font-size:13px;color:#6a6a6a;">Changed your mind? You can sign up again any time.</p>',
    }));

  } catch (err) {
    console.error('unsubscribe failed:', err.message);
    if (oneClick) return res.status(500).json({ error: 'Try again.' });
    return send(res, page({
      status: 500,
      title: 'Try again shortly',
      heading: 'Something went wrong',
      body: '<p>Please try the link again in a few minutes — or reply to the email and it will be removed by hand.</p>',
    }));
  }
}
