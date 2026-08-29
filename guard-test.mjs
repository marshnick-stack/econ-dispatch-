// Proves the generation ceiling actually blocks. Stubs both Upstash's REST API
// and the Anthropic endpoint — no network, no spend.

process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.STORAGE_KV_REST_API_URL = 'https://stub.upstash.io';
process.env.STORAGE_KV_REST_API_TOKEN = 'stub-token';
process.env.MAX_GENERATIONS_PER_DAY = '3';

let store = new Map();
let anthropicCalls = 0;
let redisEnabled = true;

const STORY = (n) => ({
  headline: `Story ${n}`, summary: 'x', url: `https://example.com/${n}`,
  igcse_link: 'x', igcse: true, ib_link: 'x', ib: true,
});

function runCommand(cmd) {
  const [op, key, ...rest] = cmd;
  switch (String(op).toLowerCase()) {
    case 'get':    return store.get(key) ?? null;
    case 'set':    store.set(key, rest[0]); return 'OK';
    case 'del':    { const had = store.delete(key); return had ? 1 : 0; }
    case 'incr':   { const v = Number(store.get(key) || 0) + 1; store.set(key, String(v)); return v; }
    case 'expire': return 1;
    case 'lrange': return store.get(key) || [];
    case 'rpush':  { const l = store.get(key) || []; l.push(...rest); store.set(key, l); return l.length; }
    case 'ltrim':  return 'OK';
    default:       return null;
  }
}

globalThis.fetch = async (url, opts) => {
  const u = String(url);

  if (u.includes('upstash.io')) {
    if (!redisEnabled) throw new Error('simulated Redis outage');
    const body = JSON.parse(opts.body);
    // The client auto-pipelines: even a single command arrives at /pipeline as
    // [["incr","key"]] and expects an array of {result} back. It reads .text().
    const payload = Array.isArray(body[0])
      ? body.map(c => ({ result: runCommand(c) }))
      : { result: runCommand(body) };
    const serialised = JSON.stringify(payload);
    return {
      ok: true, status: 200, headers: new Headers(),
      text: async () => serialised,
      json: async () => JSON.parse(serialised),
    };
  }

  if (u.includes('api.anthropic.com')) {
    anthropicCalls++;
    const digest = {
      micro:  [STORY(`m${anthropicCalls}`), STORY(`m${anthropicCalls}b`)],
      macro:  [STORY(`M${anthropicCalls}`), STORY(`M${anthropicCalls}b`)],
      global: [STORY(`g${anthropicCalls}`), STORY(`g${anthropicCalls}b`)],
    };
    return {
      ok: true, status: 200, headers: new Headers(),
      json: async () => ({
        content: [{ type: 'text', text: JSON.stringify(digest) }],
        usage: { input_tokens: 48000, output_tokens: 1500, server_tool_use: { web_search_requests: 4 } },
      }),
    };
  }
  throw new Error('unexpected fetch: ' + u);
};

const { getDigest } = await import('./api/_lib/digest-core.js');

let fails = 0;
const ok = (name, cond, extra = '') => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? '  ' + extra : ''));
  if (!cond) fails++;
};
const reset = () => { store = new Map(); anthropicCalls = 0; redisEnabled = true; };

// ── 1. Untrusted caller is capped ──────────────────────────────────────
console.log('untrusted caller, MAX_GENERATIONS_PER_DAY=3');
reset();
const results = [];
for (let i = 0; i < 5; i++) {
  store.delete([...store.keys()].find(k => k.startsWith('digest:')) || '');  // force cache miss each time
  results.push(await getDigest({ timeoutMs: 5000 }));
}
ok('first 3 attempts succeed', results.slice(0, 3).every(r => r.ok), results.slice(0,3).map(r=>r.ok).join(','));
ok('4th is refused', !results[3].ok && results[3].status === 429, `status=${results[3].status}`);
ok('5th is refused', !results[4].ok && results[4].status === 429, `status=${results[4].status}`);
ok('Anthropic called exactly 3 times', anthropicCalls === 3, `calls=${anthropicCalls}`);

// ── 2. Cached reads are free and uncapped ──────────────────────────────
console.log('cached reads');
reset();
await getDigest({ timeoutMs: 5000 });          // one generation, fills cache
const before = anthropicCalls;
const cachedRuns = [];
for (let i = 0; i < 10; i++) cachedRuns.push(await getDigest({ timeoutMs: 5000 }));
ok('10 further reads all succeed', cachedRuns.every(r => r.ok && r.cached));
ok('no extra Anthropic calls', anthropicCalls === before, `calls=${anthropicCalls}`);

// ── 3. The cron is exempt ──────────────────────────────────────────────
console.log('trusted caller (the cron)');
reset();
const trustedRuns = [];
for (let i = 0; i < 6; i++) {
  store.delete([...store.keys()].find(k => k.startsWith('digest:')) || '');
  trustedRuns.push(await getDigest({ timeoutMs: 5000, trusted: true }));
}
ok('all 6 succeed despite the ceiling', trustedRuns.every(r => r.ok), trustedRuns.map(r=>r.ok).join(','));

// ── 4. Redis down = fail closed, not fail expensive ────────────────────
console.log('Redis outage');
reset();
redisEnabled = false;
const down = await getDigest({ timeoutMs: 5000 });
ok('untrusted caller refused', !down.ok && down.status === 503, `status=${down.status}`);
ok('Anthropic NOT called', anthropicCalls === 0, `calls=${anthropicCalls}`);

redisEnabled = false;
const downTrusted = await getDigest({ timeoutMs: 5000, trusted: true });
ok('cron still generates', downTrusted.ok, `ok=${downTrusted.ok}`);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
