export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; EconDispatch/1.0)',
        'Accept': 'text/html'
      },
      signal: AbortSignal.timeout(5000)
    });

    const html = await response.text();

    // Extract og:image
    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);

    if (ogMatch && ogMatch[1]) {
      let imageUrl = ogMatch[1];
      // Make relative URLs absolute
      if (imageUrl.startsWith('/')) {
        const base = new URL(url);
        imageUrl = `${base.protocol}//${base.host}${imageUrl}`;
      }
      return res.status(200).json({ image: imageUrl });
    }

    // Fallback: try twitter:image
    const twitterMatch = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);

    if (twitterMatch && twitterMatch[1]) {
      return res.status(200).json({ image: twitterMatch[1] });
    }

    return res.status(200).json({ image: null });

  } catch (err) {
    return res.status(200).json({ image: null });
  }
}
