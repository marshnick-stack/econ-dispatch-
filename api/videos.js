import { Redis } from '@upstash/redis';

const VIDEOS_KEY = 'teacher:videos';

function getRedis() {
  return new Redis({
    url: process.env.STORAGE_KV_REST_API_URL || process.env.KV_REST_API_URL,
    token: process.env.STORAGE_KV_REST_API_TOKEN || process.env.KV_REST_API_TOKEN,
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // GET — fetch all videos (students + teacher)
  if (req.method === 'GET') {
    try {
      const redis = getRedis();
      const videos = await redis.get(VIDEOS_KEY);
      const list = videos ? (typeof videos === 'string' ? JSON.parse(videos) : videos) : [];
      return res.status(200).json({ videos: list });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // POST — add or delete a video (teacher only, requires password)
  if (req.method === 'POST') {
    const body = req.body || {};
    // Support both nested {action, video: {url,title,...}} and flat {action, url, title,...}
    const action = body.action;
    const password = body.password;
    const id = body.id;
    const video = body.video || {
      url: body.url,
      title: body.title,
      section: body.section,
      topic: body.topic,
      note: body.note
    };
    const teacherPassword = process.env.TEACHER_PASSWORD;

    if (!teacherPassword || password !== teacherPassword) {
      return res.status(401).json({ error: 'Incorrect password.' });
    }

    // Extract URL — iOS Shortcuts sometimes merges the key name with the value
    // e.g. sends "url https://..." as a key instead of url: "https://..."
    let extractedUrl = body.url;
    if (!extractedUrl) {
      // Find any key that starts with 'url' and contains 'http'
      const urlKey = Object.keys(body).find(k => k.startsWith('url') && k.includes('http'));
      if (urlKey) extractedUrl = urlKey.replace(/^url\s*/, '');
    }
    body.url = extractedUrl;

    try {
      const redis = getRedis();
      const existing = await redis.get(VIDEOS_KEY);
      let list = existing ? (typeof existing === 'string' ? JSON.parse(existing) : existing) : [];

      if (action === 'add') {
        if (!video || !video.url || !video.title) {
          return res.status(400).json({ error: 'Missing title or URL.' });
        }
        list.push({
          id: Date.now(),
          url: video.url,
          title: video.title,
          section: video.section || 'micro',
          topic: video.topic || 'Unsorted',
          note: video.note || '',
          addedDate: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
        });
        await redis.set(VIDEOS_KEY, JSON.stringify(list));
        return res.status(200).json({ ok: true, videos: list });
      }

      if (action === 'delete') {
        list = list.filter(v => v.id !== id);
        await redis.set(VIDEOS_KEY, JSON.stringify(list));
        return res.status(200).json({ ok: true, videos: list });
      }

      return res.status(400).json({ error: 'Unknown action.' });

    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed.' });
}
