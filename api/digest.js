// Website "Fetch Today's Digest" button.
// All generation, caching and validation lives in api/_lib/digest-core.js so the
// email endpoint uses the identical code path and the identical cache.

import { getDigest } from './_lib/digest-core.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const result = await getDigest({ timeoutMs: 55000 });

  if (!result.ok) {
    return res.status(result.status || 500).json({ error: result.error });
  }

  return res.status(200).json({ text: result.text, cached: result.cached });
}
