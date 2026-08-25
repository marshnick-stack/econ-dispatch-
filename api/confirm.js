// Step 2 of sign-up: the link in the confirmation email lands here.
// This is the only place an address is added to the subscriber list.

import {
  getRedis, unsubscribeToken, page,
  SUBSCRIBERS_KEY, MAX_SUBSCRIBERS,
} from './_lib/subscribers.js';

function send(res, { status, html }) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(status).send(html);
}

export default async function handler(req, res) {
  const token = String(req.query?.token || '');

  if (!token) {
    return send(res, page({
      status: 400,
      title: 'Link not valid',
      heading: 'That link looks incomplete',
      body: '<p>Try copying the whole link from the email, including everything after the question mark.</p>',
    }));
  }

  const redis = getRedis();
  if (!redis) {
    return send(res, page({
      status: 500,
      title: 'Try again shortly',
      heading: 'Something went wrong',
      body: '<p>The subscriber list is unavailable right now. Please try the link again in a few minutes.</p>',
    }));
  }

  try {
    const email = await redis.get(`pending:${token}`);

    // Expired, already used, or invented.
    if (!email) {
      return send(res, page({
        status: 404,
        title: 'Link expired',
        heading: 'That link has expired',
        body: '<p>Confirmation links last 24 hours. Sign up again on the site and a fresh one will arrive.</p>',
      }));
    }

    // Re-check the cap here too: plenty of people can be mid-confirmation at once,
    // and the count at sign-up time may be stale by now.
    const count = await redis.scard(SUBSCRIBERS_KEY);
    const alreadyOn = await redis.sismember(SUBSCRIBERS_KEY, email);
    if (!alreadyOn && count >= MAX_SUBSCRIBERS) {
      return send(res, page({
        status: 503,
        title: 'List full',
        heading: 'The list is full',
        body: '<p>More people signed up than there are places. Nothing has been charged or lost — try again in a few days.</p>',
      }));
    }

    await redis.sadd(SUBSCRIBERS_KEY, email);
    // Reverse lookup so the unsubscribe link carries a token, not an address.
    await redis.set(`unsub:${unsubscribeToken(email)}`, email);
    await redis.del(`pending:${token}`);

    return send(res, page({
      title: "You're subscribed",
      heading: "You're on the list",
      body: '<p>The Econ Dispatch will arrive each weekday morning, Shanghai time.</p>'
          + '<p style="font-size:13px;color:#6a6a6a;">Every issue has an unsubscribe link at the bottom. '
          + 'One click and your address is deleted.</p>',
    }));

  } catch (err) {
    console.error('confirm failed:', err.message);
    return send(res, page({
      status: 500,
      title: 'Try again shortly',
      heading: 'Something went wrong',
      body: '<p>Please try the link again in a few minutes.</p>',
    }));
  }
}
