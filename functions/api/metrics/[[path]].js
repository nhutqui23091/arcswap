/**
 * Oneliq metrics — Cloudflare Pages Function.
 *
 * Endpoints (all under /api/metrics/*):
 *   POST /track       Increment counters + store event in ring buffer.
 *                     Public (no auth) but validated + origin-allowlisted.
 *                     Fire-and-forget from client; never blocks UX.
 *   GET  /summary     30-day aggregate stats (totalTx, by event, by chain).
 *                     Reads ONE pre-aggregated key. Edge-cached 120s.
 *   GET  /recent      Last N events (default 20) for the activity feed.
 *                     Reads ONE ring-buffer key. Edge-cached 60s.
 *   GET  /health      Health probe (204, no upstream work).
 *
 * ─── Architecture: compute-on-write ─────────────────────────────────────
 *
 * Prior version computed rollups on /summary by fan-out reading 7 events
 * × 30 days + 7 events × 8 chains + lifetime totals + a kv.list — about
 * 273 reads + 1 list per call. With status pages polling every 5 minutes
 * from multiple regions, that easily blew the 100k/day KV-read free cap.
 *
 * New version pre-aggregates into ONE rollup key on every /track:
 *
 *   metric:summary:v1   { lifetime, byDay, byChainToday, fpToday, todayKey }
 *   metric:recent:v1    [ event, event, ..., 50 entries newest-first ]
 *
 * /summary reads `metric:summary:v1` (1 read) and shapes the response.
 * /recent  reads `metric:recent:v1`  (1 read) and slices.
 *
 * Cold-start (cache key missing) → fall back to fan-out compute once,
 * then store the result. Daily reconciliation cron (in workers/kv-backup)
 * recomputes the cache from raw counters to fix any race-condition drift.
 *
 * ─── Storage schema ─────────────────────────────────────────────────────
 *
 * Raw audit trail (kept for reconciliation, never read in hot path):
 *   metric:event:<ts>:<rand>                         → JSON event (7-day TTL)
 *   metric:count:<YYYY-MM-DD>:<event>                → "N"  (per-day total)
 *   metric:count:<YYYY-MM-DD>:<event>:<chain>        → "N"  (per-day per-chain)
 *   metric:total:<event>                             → "N"  (lifetime)
 *   metric:user:<YYYY-MM-DD>:<hashed-fingerprint>    → "1"  (unique-user marker, 35-day TTL)
 *
 * Hot-path pre-aggregates (read on every /summary, /recent):
 *   metric:summary:v1    → JSON rollup { version, computedAt, todayKey,
 *                                       lifetime, byDay, byChainToday,
 *                                       fpToday }
 *   metric:recent:v1     → JSON array of last 50 events, newest-first
 *
 * ─── Race conditions ────────────────────────────────────────────────────
 *
 * Two concurrent /track calls can race the rollup update (read JSON →
 * modify → write JSON) and lose one increment. Acceptable for analytics —
 * the daily reconcile from raw counters (which are 4 separate keys, less
 * contended) fixes any drift within 24h.
 */

const ALLOWED_ORIGINS = [
  'https://oneliq.xyz',
  'https://www.oneliq.xyz',
  'https://arcswap.pages.dev',
  'https://status.oneliq.xyz',
  // Transition window — old domains kept ~1 week for browsers caching old HTML.
  // Safe to remove after 2026-06-09.
  'https://arcswap.net',
  'https://www.arcswap.net',
  'https://status.arcswap.net',
];

// Event types we accept. Anything else → 400.
const EVENT_TYPES = [
  'trade',         // swap on Uniswap V2 router (Arc)
  'deposit',       // Circle Gateway deposit
  'spend',         // cross-chain Spend via Gateway
  'bridge',        // CCTP V2 burn (Fast or Standard)
  'agent-create',  // user created a new agent
  'agent-exec',    // agent execution succeeded (server-side write)
  'failure',       // any transaction failure caught at client
  'gm-checkin',    // daily GM check-in on Arc Testnet
];
const EVENT_ALLOWLIST = new Set(EVENT_TYPES);

// Chain keys allowlist — matches assets/arc-core.js CHAINS keys
const CHAIN_KEYS = [
  'arc','sepolia','baseSepolia','arbitrumSepolia','optimismSepolia',
  'avalancheFuji','polygonAmoy','unichainSepolia',
];
const CHAIN_ALLOWLIST = new Set(CHAIN_KEYS);

// Rollup config
const SUMMARY_KEY = 'metric:summary:v1';
const RECENT_KEY  = 'metric:recent:v1';
const RECENT_MAX  = 50;          // ring buffer size
const SERIES_DAYS = 30;          // 30-day rolling window

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

// Query Arc Testnet explorer (Blockscout v2) for distinct wallet addresses with
// any on-chain activity today. This is the ground-truth active-user count —
// independent of whether client-side ARC.track() fired or included an address.
// Result is cached in KV for 5 minutes to avoid hammering the explorer.
async function fetchOnChainActiveUsers(kv) {
  const today = utcDate();
  const cacheKey = `metric:onchain:${today}`;
  try { const c = await kv.get(cacheKey); if (c !== null) return parseInt(c, 10) || 0; } catch {}

  try {
    const todayStart = new Date(today + 'T00:00:00Z').getTime();
    const addrs = new Set();
    let params = new URLSearchParams({ filter: 'validated', limit: '50', sort: 'desc' });

    // Paginate up to 5 pages (250 txs) — enough for typical daily activity.
    for (let page = 0; page < 5; page++) {
      const res = await fetch(`https://testnet.arcscan.app/api/v2/transactions?${params}`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) break;
      const data = await res.json();
      const items = Array.isArray(data.items) ? data.items : [];
      let doneForDay = false;
      for (const tx of items) {
        const ts = tx.timestamp ? new Date(tx.timestamp).getTime() : 0;
        if (ts < todayStart) { doneForDay = true; break; }
        const addr = tx.from?.hash || tx.from;
        if (typeof addr === 'string' && addr.startsWith('0x')) addrs.add(addr.toLowerCase());
      }
      if (doneForDay || !data.next_page_params || Object.keys(data.next_page_params || {}).length === 0) break;
      params = new URLSearchParams(data.next_page_params);
    }

    const count = addrs.size;
    // Only cache non-zero results so a failed/empty first call doesn't freeze the count.
    if (count > 0) await kv.put(cacheKey, String(count), { expirationTtl: 300 });
    return count;
  } catch (e) {
    console.warn('[metrics] fetchOnChainActiveUsers failed:', e?.message);
    return 0;
  }
}

// Hash IP+UA+address → 12 hex chars; daily uniqueness marker without storing PII.
// Including wallet address means two different wallets behind the same NAT/IP
// are counted as distinct active users.
async function fingerprint(request, addr) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ua = request.headers.get('User-Agent') || '';
  const a  = typeof addr === 'string' && /^0x[0-9a-f]{40}$/i.test(addr) ? addr.toLowerCase() : '';
  const buf = new TextEncoder().encode(ip + '|' + ua + '|' + a);
  const h = await crypto.subtle.digest('SHA-256', buf);
  const hex = Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 12);
}

function bad(msg, origin, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}

/* ────────────────────────────────────────────────────────────────────────
   ROLLUP CACHE — single source of truth for /summary
   ────────────────────────────────────────────────────────────────────────
   Shape (always v1; bump version + change key suffix if you change shape):
     {
       version:    1,
       computedAt: ISO timestamp,
       todayKey:   "YYYY-MM-DD",       // UTC day this rollup considers "today"
       lifetime:   { [event]: count },
       byDay:      { [day]: { [event]: count } },   // up to SERIES_DAYS entries
       byChainToday: { [chain]: { [event]: count } },
       fpToday:    { [fingerprintHex]: 1 }          // map for O(1) membership
     }
   ──────────────────────────────────────────────────────────────────────── */

function emptyRollup(today) {
  const r = { version: 1, computedAt: new Date().toISOString(), todayKey: today, lifetime: {}, byDay: {}, byChainToday: {}, fpToday: {} };
  for (const e of EVENT_TYPES) r.lifetime[e] = 0;
  return r;
}

/**
 * Apply one /track increment to the in-memory rollup. Mutates `r`.
 * Handles UTC day rollover: when `r.todayKey` doesn't match `day`, the
 * existing today's byChain/fingerprint state is reset (it's archived in
 * byDay implicitly via per-event counts).
 */
function applyIncrement(r, day, event, chain, fp) {
  // Day rollover: reset today-only state. byDay accumulates across days,
  // so we don't touch it here — yesterday's counts stay where they are.
  if (r.todayKey !== day) {
    r.todayKey = day;
    r.byChainToday = {};
    r.fpToday = {};
  }
  // Drop byDay entries older than SERIES_DAYS to keep the cache small.
  const cutoff = new Date(day + 'T00:00:00Z');
  cutoff.setUTCDate(cutoff.getUTCDate() - (SERIES_DAYS - 1));
  const cutoffKey = utcDate(cutoff.getTime());
  for (const d of Object.keys(r.byDay)) {
    if (d < cutoffKey) delete r.byDay[d];
  }
  // Increment buckets
  r.lifetime[event] = (r.lifetime[event] || 0) + 1;
  r.byDay[day] = r.byDay[day] || {};
  r.byDay[day][event] = (r.byDay[day][event] || 0) + 1;
  if (chain) {
    r.byChainToday[chain] = r.byChainToday[chain] || {};
    r.byChainToday[chain][event] = (r.byChainToday[chain][event] || 0) + 1;
  }
  if (fp) r.fpToday[fp] = 1;
  r.computedAt = new Date().toISOString();
}

/**
 * Best-effort rollup update. Reads cache, applies one increment, writes back.
 * Race-tolerant: concurrent writers may lose ≤1 increment per race — daily
 * reconcile cron repairs drift. Never throws (analytics must not block UX).
 */
async function updateRollupCache(kv, day, event, chain, fp) {
  try {
    let r;
    try { r = JSON.parse((await kv.get(SUMMARY_KEY)) || 'null'); } catch { r = null; }
    if (!r || r.version !== 1) r = emptyRollup(day);
    applyIncrement(r, day, event, chain, fp);
    await kv.put(SUMMARY_KEY, JSON.stringify(r));
  } catch (e) {
    // Don't break /track if rollup write fails — raw counters are still authoritative.
    console.warn('[metrics] rollup update failed:', e?.message);
  }
}

/**
 * Best-effort ring-buffer update. Reads recent JSON, prepends, trims to
 * RECENT_MAX, writes back. Same race characteristics as rollup.
 */
async function pushRecentRing(kv, eventData) {
  try {
    let ring;
    try { ring = JSON.parse((await kv.get(RECENT_KEY)) || '[]'); } catch { ring = []; }
    if (!Array.isArray(ring)) ring = [];
    ring.unshift(eventData);
    if (ring.length > RECENT_MAX) ring.length = RECENT_MAX;
    await kv.put(RECENT_KEY, JSON.stringify(ring));
  } catch (e) {
    console.warn('[metrics] ring update failed:', e?.message);
  }
}

/**
 * Cold-start fallback: rebuild the rollup from raw counters with the full
 * fan-out scan. Used only when the cache key is missing or the version
 * tag doesn't match. Caller stores the result back to SUMMARY_KEY.
 *
 * NOTE: fingerprints can't be recovered from raw counters (we only stored
 * a marker key per fp, no count). On cold rebuild we estimate today's
 * active users by listing `metric:user:<today>:` once and storing the
 * count as an opaque seed — subsequent /track calls will incrementally
 * add new fingerprints. This means activeUsers may be off on rebuild day
 * by a tiny amount; daily reconcile cleans it up.
 */
async function rebuildRollupFromCounters(kv) {
  const today = utcDate();
  const r = emptyRollup(today);

  // Lifetime totals
  await Promise.all(EVENT_TYPES.map(async e => {
    r.lifetime[e] = parseInt((await kv.get(`metric:total:${e}`)) || '0', 10);
  }));

  // 30-day series per event
  const days = [];
  const d0 = new Date();
  for (let i = SERIES_DAYS - 1; i >= 0; i--) {
    const d = new Date(d0); d.setUTCDate(d0.getUTCDate() - i);
    days.push(utcDate(d.getTime()));
  }
  await Promise.all(days.map(async day => {
    const bucket = {};
    await Promise.all(EVENT_TYPES.map(async e => {
      const v = parseInt((await kv.get(`metric:count:${day}:${e}`)) || '0', 10);
      if (v > 0) bucket[e] = v;
    }));
    if (Object.keys(bucket).length > 0) r.byDay[day] = bucket;
  }));

  // byChainToday — only "today" matters for the byChain shape we expose
  await Promise.all(CHAIN_KEYS.map(async c => {
    const byEvent = {};
    await Promise.all(EVENT_TYPES.map(async e => {
      const v = parseInt((await kv.get(`metric:count:${today}:${e}:${c}`)) || '0', 10);
      if (v > 0) byEvent[e] = v;
    }));
    if (Object.keys(byEvent).length > 0) r.byChainToday[c] = byEvent;
  }));

  // fpToday — seed from listing user markers for today. This is the only
  // kv.list() we ever do for metrics, and it runs ONCE per rebuild.
  try {
    const userList = await kv.list({ prefix: `metric:user:${today}:`, limit: 1000 });
    for (const k of userList.keys) {
      const m = k.name.match(/^metric:user:[^:]+:(.+)$/);
      if (m) r.fpToday[m[1]] = 1;
    }
  } catch (e) {
    console.warn('[metrics] rebuild fp list failed:', e?.message);
  }

  r.computedAt = new Date().toISOString();
  return r;
}

/**
 * Shape a rollup into the public /summary response. Pure function — does
 * not touch KV. Same response shape as the legacy fan-out version, for
 * backward compatibility with the status page.
 */
function shapeSummary(r) {
  const today = utcDate();

  // Build 30-day sliding window of dates, oldest → newest.
  const days = [];
  const d0 = new Date();
  for (let i = SERIES_DAYS - 1; i >= 0; i--) {
    const d = new Date(d0); d.setUTCDate(d0.getUTCDate() - i);
    days.push(utcDate(d.getTime()));
  }

  const totals  = { ...r.lifetime };
  for (const e of EVENT_TYPES) if (totals[e] == null) totals[e] = 0;

  const last30  = {};
  const series  = {};
  const last24h = {};
  for (const e of EVENT_TYPES) last30[e] = 0;
  for (const day of days) {
    const bucket = r.byDay[day] || {};
    let dayTotal = 0;
    for (const e of EVENT_TYPES) {
      const v = bucket[e] || 0;
      last30[e] += v;
      dayTotal += v;
      if (day === today) last24h[e] = v;
    }
    series[day] = dayTotal;
  }
  for (const e of EVENT_TYPES) if (last24h[e] == null) last24h[e] = 0;

  // byChain: today's per-chain totals (sum across events) — matches legacy shape.
  const byChain = {};
  for (const c of CHAIN_KEYS) {
    let n = 0;
    const byEvent = r.byChainToday[c] || {};
    for (const e of EVENT_TYPES) n += byEvent[e] || 0;
    byChain[c] = n;
  }

  const activeUsers = Object.keys(r.fpToday || {}).length;
  const grandTotal  = Object.values(totals).reduce((a, b) => a + b, 0);
  const todayTotal  = series[today] || 0;

  return {
    ready: true,
    totals, last30, last24h, byChain,
    activeUsers, grandTotal, todayTotal,
    series,
    asOf: new Date().toISOString(),
  };
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

    // Optional per-source breakdown for cross-chain spend events.
    // Stored verbatim in the ring buffer; ignored by rollup counters.
    let sources = null;
    if (Array.isArray(body.sources) && body.sources.length > 0) {
      sources = body.sources
        .filter(s => s && typeof s === 'object' && typeof s.chainKey === 'string')
        .map(s => ({ chainKey: String(s.chainKey).slice(0, 32), amount: s.amount != null ? String(s.amount).slice(0, 20) : null }))
        .slice(0, 20);
      if (!sources.length) sources = null;
    }

    const day = utcDate(ts);
    const rand = Math.random().toString(36).slice(2, 10);
    const eventKey = `metric:event:${ts}:${rand}`;
    // Validate and normalise wallet address when provided. Stored in the event
    // and in a dedicated per-wallet KV key so /summary can count distinct
    // active wallets via kv.list — fully race-free unlike the fpToday JSON blob.
    const walletAddr = typeof body.address === 'string' && /^0x[0-9a-f]{40}$/i.test(body.address)
      ? body.address.toLowerCase() : null;
    const clientVer = typeof body._cv === 'string' ? body._cv.slice(0, 16) : null;
    const eventData = { event, chain, amount, txHash, surface, ts, ...(sources ? { sources } : {}), ...(walletAddr ? { address: walletAddr } : {}), ...(clientVer ? { _cv: clientVer } : {}) };
    const fp = await fingerprint(request, walletAddr);

    // Raw audit-trail writes — kept for reconciliation. Best-effort, parallel.
    // metric:wallet:${day}:${addr} is written per unique wallet; /summary reads
    // the count via kv.list so concurrent writes never race (one key per wallet).
    await Promise.all([
      kv.put(eventKey, JSON.stringify(eventData), { expirationTtl: 7 * 24 * 60 * 60 }),
      incr(kv, `metric:count:${day}:${event}`),
      incr(kv, `metric:count:${day}:${event}:${chain}`),
      incr(kv, `metric:total:${event}`),
      kv.put(`metric:user:${day}:${fp}`, '1', { expirationTtl: 35 * 24 * 60 * 60 }),
      ...(walletAddr ? [kv.put(`metric:wallet:${day}:${walletAddr}`, '1', { expirationTtl: 35 * 24 * 60 * 60 })] : []),
    ]);

    // Hot-path pre-aggregates — what /summary and /recent actually read.
    // Parallel because they touch different keys.
    await Promise.all([
      updateRollupCache(kv, day, event, chain, fp),
      pushRecentRing(kv, eventData),
    ]);

    console.log('[metrics/track]', JSON.stringify({
      event, chain,
      hasAddress: !!walletAddr,
      addrPrefix: walletAddr ? walletAddr.slice(0, 8) : null,
      fpPrefix: fp.slice(0, 8),
      walletKeyWritten: !!walletAddr,
      day,
    }));

    return new Response(null, { status: 204, headers: cors(origin) });
  }

  // ─── GET /summary ────────────────────────────────────────────────────────
  if (route === 'summary' && request.method === 'GET') {
    let r;
    try { r = JSON.parse((await kv.get(SUMMARY_KEY)) || 'null'); } catch { r = null; }

    if (!r || r.version !== 1) {
      // Cold start (key missing or version mismatch) → rebuild ONCE.
      // This is the only path that does fan-out reads. Subsequent calls
      // are 1 read each until the key is evicted (KV has no TTL eviction;
      // only manual delete or version bump triggers a rebuild).
      r = await rebuildRollupFromCounters(kv);
      await kv.put(SUMMARY_KEY, JSON.stringify(r));
    }

    const summary = shapeSummary(r);

    // Count active users from atomic individual KV keys instead of the fpToday
    // JSON blob (which suffers concurrent-write corruption when many swaps race).
    //
    // Two sources, both use separate-key puts (no read-modify-write, no race):
    //   metric:wallet:{day}:{addr}  — written when address is known (post-fix events)
    //   metric:user:{day}:{fp}      — written for every /track regardless of address
    //
    // Taking max() handles both pre-fix events (wallet keys missing, user keys present)
    // and post-fix events (both present, wallet count is subset of user count or equal).
    try {
      const today = utcDate();
      const [wl, ul, onChain] = await Promise.all([
        kv.list({ prefix: `metric:wallet:${today}:`, limit: 10000 }),
        kv.list({ prefix: `metric:user:${today}:`,   limit: 10000 }),
        fetchOnChainActiveUsers(kv),
      ]);
      // on-chain count is ground truth; KV counts are fallback when explorer is unreachable.
      const count = Math.max(wl.keys.length, ul.keys.length, onChain);
      if (count > 0) summary.activeUsers = count;
    } catch {}

    return new Response(JSON.stringify(summary), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...cors(origin),
        // no-store: kv.list runs every request so active users count is always fresh.
        // cors() already sets no-store as default; this line keeps the intent explicit.
        'Cache-Control': 'no-store',
      },
    });
  }

  // ─── GET /recent ─────────────────────────────────────────────────────────
  if (route === 'recent' && request.method === 'GET') {
    const n = Math.max(1, Math.min(RECENT_MAX, parseInt(url.searchParams.get('n') || '20', 10)));

    let ring;
    try { ring = JSON.parse((await kv.get(RECENT_KEY)) || 'null'); } catch { ring = null; }

    if (!Array.isArray(ring)) {
      // Cold start: seed ring buffer from kv.list. ONE TIME — every
      // subsequent /track will keep it warm via pushRecentRing.
      try {
        const list = await kv.list({ prefix: 'metric:event:', limit: 200 });
        const keys = list.keys.map(k => k.name).sort((a, b) => {
          const ta = parseInt(a.split(':')[2], 10);
          const tb = parseInt(b.split(':')[2], 10);
          return tb - ta;
        }).slice(0, RECENT_MAX);
        const events = [];
        await Promise.all(keys.map(async k => {
          const raw = await kv.get(k);
          if (raw) { try { events.push(JSON.parse(raw)); } catch {} }
        }));
        events.sort((a, b) => b.ts - a.ts);
        ring = events;
        await kv.put(RECENT_KEY, JSON.stringify(ring));
      } catch (e) {
        ring = [];
      }
    }

    return new Response(JSON.stringify({ ready: true, events: ring.slice(0, n) }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...cors(origin),
        // 60s edge cache — activity feed should feel near-live.
        // NOTE: must come AFTER cors() spread (no-store default).
        'Cache-Control': 'public, max-age=60, s-maxage=60',
      },
    });
  }

  // ─── GET /debug ──────────────────────────────────────────────────────────
  if (route === 'debug' && request.method === 'GET') {
    const today = utcDate();
    const [wl, ul, summaryRaw, recentRaw, onChain] = await Promise.all([
      kv.list({ prefix: `metric:wallet:${today}:`, limit: 100 }),
      kv.list({ prefix: `metric:user:${today}:`,   limit: 100 }),
      kv.get(SUMMARY_KEY),
      kv.get(RECENT_KEY),
      fetchOnChainActiveUsers(kv),
    ]);
    let summary = null;
    try { summary = JSON.parse(summaryRaw); } catch {}
    let recentSample = [];
    try {
      const ring = JSON.parse(recentRaw);
      recentSample = (Array.isArray(ring) ? ring.slice(0, 5) : []).map(e => ({
        event: e.event, chain: e.chain, hasAddress: !!e.address,
        addrPrefix: e.address ? e.address.slice(0, 8) : null,
        client_version: e._cv || 'pre-9.9.2',
        ts: e.ts,
      }));
    } catch {}
    return new Response(JSON.stringify({
      today,
      onchain_active_users: onChain,
      wallet_keys: wl.keys.length,
      user_fp_keys: ul.keys.length,
      active_users_computed: Math.max(wl.keys.length, ul.keys.length, onChain),
      active_users_blob: Object.keys(summary?.fpToday || {}).length,
      wallet_sample: wl.keys.slice(0, 10).map(k => k.name.replace(`metric:wallet:${today}:`, '')),
      user_fp_sample: ul.keys.slice(0, 10).map(k => k.name.slice(-8)),
      rollup_todayKey: summary?.todayKey,
      rollup_computedAt: summary?.computedAt,
      recent_events_sample: recentSample,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...cors(origin), 'Cache-Control': 'no-store' },
    });
  }

  return bad('not_found', origin, 404);
}

// Re-export the hot-path helpers so the agent endpoint (which also
// generates events server-side) can use them without duplicating logic.
// NOTE: Pages Functions can't share modules across routes easily, so
// `functions/api/agent/[[path]].js` reimplements the same write pattern
// inline. Keep these two files in sync if you change the rollup shape.
export { updateRollupCache, pushRecentRing, utcDate as _utcDate };
