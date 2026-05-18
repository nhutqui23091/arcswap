/**
 * ArcSwap metrics — Cloudflare Pages Function.
 *
 * Endpoints (all under /api/metrics/*):
 *   POST /track       Increment counters + store event in ring buffer.
 *                     Public (no auth) but validated + origin-allowlisted.
 *                     Fire-and-forget from client; never blocks UX.
 *   GET  /summary     30-day aggregate stats (totalTx, by event, by chain).
 *                     Cached at edge 30s.
 *   GET  /recent      Last N events (default 20) for the activity feed.
 *                     Cached at edge 15s.
 *   GET  /health      Health probe (204, no upstream work).
 *
 * Storage: shares the existing AGENT_KV binding with a `metric:` key prefix
 * to avoid spinning up a new KV namespace. Schema:
 *
 *   metric:event:<ts>:<rand>      → JSON { event, chain, amount, txHash, surface, ts }
 *                                  (TTL 7 days — the ring buffer for /recent)
 *   metric:count:<YYYY-MM-DD>:<event>          → "N"     (per-day total)
 *   metric:count:<YYYY-MM-DD>:<event>:<chain>  → "N"     (per-day per-chain)
 *   metric:total:<event>          → "N"     (lifetime total)
 *   metric:user:<YYYY-MM-DD>:<hashed-fingerprint> → "1"  (unique-user marker)
 *
 * Counter writes are best-effort eventually-consistent (KV has no INCR), so
 * concurrent writes can drop +1 occasionally. That's acceptable for
 * analytics — the ring buffer (events) is the source of truth.
 */

const ALLOWED_ORIGINS = [
  'https://arcswap.net',
  'https://www.arcswap.net',
  'https://arcswap.pages.dev',
  'https://status.arcswap.net',
];

// Event types we accept. Anything else → 400.
const EVENT_ALLOWLIST = new Set([
  'trade',         // swap on Uniswap V2 router (Arc)
  'deposit',       // Circle Gateway deposit
  'spend',         // cross-chain Spend via Gateway
  'bridge',        // CCTP V2 burn (Fast or Standard)
  'agent-create',  // user created a new agent
  'agent-exec',    // agent execution succeeded (server-side write)
  'failure',       // any transaction failure caught at client
]);

// Chain keys allowlist — matches assets/arc-core.js CHAINS keys
const CHAIN_ALLOWLIST = new Set([
  'arc','sepolia','baseSepolia','arbitrumSepolia','optimismSepolia',
  'avalancheFuji','polygonAmoy','unichainSepolia',
]);

function isAllowed(origin) {
  return !origin
    || ALLOWED_ORIGINS.includes(origin)
    || origin.endsWith('.arcswap.pages.dev')
    || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function cors(origin, extra = {}) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Cache-Control': 'no-store',
    ...extra,
  };
}

function utcDate(ts) {
  const d = new Date(ts || Date.now());
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth()+1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
}

async function incr(kv, key) {
  // Read-modify-write — eventually consistent. Acceptable race window for analytics.
  const cur = parseInt((await kv.get(key)) || '0', 10);
  await kv.put(key, String(cur + 1));
}

// Hash IP+UA → 8 hex chars; used as a daily uniqueness marker without storing PII.
async function fingerprint(request) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ua = request.headers.get('User-Agent') || '';
  const buf = new TextEncoder().encode(ip + '|' + ua);
  const h = await crypto.subtle.digest('SHA-256', buf);
  const hex = Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 12);
}

function bad(msg, origin, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const origin = request.headers.get('Origin') || '';

  // Origin gate
  if (origin && !isAllowed(origin)) {
    return new Response('Forbidden: origin not allowed', { status: 403 });
  }

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // Route: extract path after /api/metrics/
  const m = url.pathname.match(/^\/api\/metrics\/(.*)$/);
  if (!m) return bad('not_found', origin, 404);
  const route = m[1].replace(/\/+$/, '');

  // Health probe — works even without KV
  if (route === 'health') {
    return new Response(null, { status: 204, headers: cors(origin) });
  }

  const kv = env.AGENT_KV;
  if (!kv) {
    // No KV bound → return empty data so status page falls back gracefully
    if (route === 'summary') return new Response(JSON.stringify({ ready: false }), { status: 200, headers: { 'Content-Type': 'application/json', ...cors(origin) } });
    if (route === 'recent')  return new Response(JSON.stringify({ ready: false, events: [] }), { status: 200, headers: { 'Content-Type': 'application/json', ...cors(origin) } });
    return bad('storage_not_ready', origin, 503);
  }

  // ─── POST /track ─────────────────────────────────────────────────────────
  if (route === 'track' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return bad('invalid_json', origin); }
    if (!body || typeof body !== 'object') return bad('invalid_body', origin);

    const event = String(body.event || '').slice(0, 32);
    const chain = String(body.chain || '').slice(0, 32);
    const surface = body.surface ? String(body.surface).slice(0, 32) : null;
    const amountRaw = body.amount;
    const txHash = body.txHash ? String(body.txHash).slice(0, 128) : null;
    const ts = Date.now(); // Server-side timestamp — ignore client ts to prevent forgery

    if (!EVENT_ALLOWLIST.has(event))   return bad('invalid_event', origin);
    if (!CHAIN_ALLOWLIST.has(chain))   return bad('invalid_chain', origin);
    const amount = (amountRaw === null || amountRaw === undefined) ? null
                 : Number.isFinite(+amountRaw) && +amountRaw >= 0 && +amountRaw <= 1e9 ? +amountRaw
                 : null;
    if (txHash && !/^0x[0-9a-fA-F]{1,128}$/.test(txHash)) return bad('invalid_tx_hash', origin);

    const day = utcDate(ts);
    const rand = Math.random().toString(36).slice(2, 10);
    const eventKey = `metric:event:${ts}:${rand}`;
    const eventData = { event, chain, amount, txHash, surface, ts };

    // Write event with 7-day TTL (the ring buffer)
    await kv.put(eventKey, JSON.stringify(eventData), { expirationTtl: 7 * 24 * 60 * 60 });

    // Counter writes — best-effort, run in parallel
    const fp = await fingerprint(request);
    await Promise.all([
      incr(kv, `metric:count:${day}:${event}`),
      incr(kv, `metric:count:${day}:${event}:${chain}`),
      incr(kv, `metric:total:${event}`),
      // Unique-user marker for the day (no expiry — used for "active users" rollups)
      kv.put(`metric:user:${day}:${fp}`, '1', { expirationTtl: 35 * 24 * 60 * 60 }),
    ]);

    return new Response(null, { status: 204, headers: cors(origin) });
  }

  // ─── GET /summary ────────────────────────────────────────────────────────
  if (route === 'summary' && request.method === 'GET') {
    const events = ['trade','deposit','spend','bridge','agent-create','agent-exec','failure'];
    const chains = ['arc','sepolia','baseSepolia','arbitrumSepolia','optimismSepolia','avalancheFuji','polygonAmoy','unichainSepolia'];

    // Lifetime totals (1 read per event)
    const totals = {};
    await Promise.all(events.map(async e => {
      totals[e] = parseInt((await kv.get(`metric:total:${e}`)) || '0', 10);
    }));

    // Last 30 days — daily series for the chart + 30d aggregates
    const today = new Date();
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today); d.setUTCDate(today.getUTCDate() - i);
      days.push(utcDate(d));
    }
    const series = {};   // { 'YYYY-MM-DD': totalTx }
    const last30 = {};   // { event: count }
    const last24h = {};  // { event: count } — today's counters
    const byChain = {};  // { chain: count }

    // Build day-by-day rollup
    await Promise.all(days.map(async day => {
      let dayTotal = 0;
      await Promise.all(events.map(async e => {
        const v = parseInt((await kv.get(`metric:count:${day}:${e}`)) || '0', 10);
        dayTotal += v;
        last30[e] = (last30[e] || 0) + v;
        if (day === days[days.length - 1]) last24h[e] = v;
      }));
      series[day] = dayTotal;
    }));

    // Per-chain rollup for today
    const todayKey = days[days.length - 1];
    await Promise.all(chains.map(async c => {
      let n = 0;
      await Promise.all(events.map(async e => {
        n += parseInt((await kv.get(`metric:count:${todayKey}:${e}:${c}`)) || '0', 10);
      }));
      byChain[c] = n;
    }));

    // Active users today (list keys with prefix — caps at 1000 entries)
    let activeUsers = 0;
    try {
      const userList = await kv.list({ prefix: `metric:user:${todayKey}:`, limit: 1000 });
      activeUsers = userList.keys.length;
    } catch (e) {
      activeUsers = 0;
    }

    const grandTotal = Object.values(totals).reduce((a, b) => a + b, 0);
    const todayTotal = series[todayKey] || 0;

    return new Response(JSON.stringify({
      ready: true,
      totals,
      last30,
      last24h,
      byChain,
      activeUsers,
      grandTotal,
      todayTotal,
      series, // { 'YYYY-MM-DD': total } — 30 entries
      asOf: new Date().toISOString(),
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Edge-cache 2 minutes — multiple status page visitors share one
        // origin KV read. Status page polls every 2 minutes anyway, so
        // most polls will hit a fresh edge cache and never touch origin.
        'Cache-Control': 'public, max-age=120, s-maxage=120',
        ...cors(origin),
      },
    });
  }

  // ─── GET /recent ─────────────────────────────────────────────────────────
  if (route === 'recent' && request.method === 'GET') {
    const n = Math.max(1, Math.min(50, parseInt(url.searchParams.get('n') || '20', 10)));
    // KV list keys in lexicographic order. Our event keys are `metric:event:<ts>:...`
    // where ts is base-10 ms. To get newest first, list all + sort desc by ts.
    // For testnet scale this is fine; for production wire a Durable Object.
    const list = await kv.list({ prefix: 'metric:event:', limit: Math.min(1000, n * 5) });
    const keys = list.keys.map(k => k.name).sort((a, b) => {
      const ta = parseInt(a.split(':')[2], 10);
      const tb = parseInt(b.split(':')[2], 10);
      return tb - ta;
    }).slice(0, n);

    const events = [];
    await Promise.all(keys.map(async k => {
      const raw = await kv.get(k);
      if (raw) {
        try { events.push(JSON.parse(raw)); } catch {}
      }
    }));
    events.sort((a, b) => b.ts - a.ts);

    return new Response(JSON.stringify({ ready: true, events }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Edge-cache 60s for the activity feed. Trades won't appear
        // INSTANTLY but within 60s, which is acceptable for a status page.
        'Cache-Control': 'public, max-age=60, s-maxage=60',
        ...cors(origin),
      },
    });
  }

  return bad('not_found', origin, 404);
}
