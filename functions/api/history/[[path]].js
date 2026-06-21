/**
 * Oneliq history sync — Cloudflare Pages Function.
 *
 * Trade/Balance receipts are ALSO kept in each browser's localStorage
 * (`arc.trade.activity.v1`), but that's per-browser and never followed the
 * wallet across browsers/devices. These endpoints mirror those receipts to KV
 * keyed by wallet address so the History page can show the same feed everywhere.
 *
 * Endpoints (all under /api/history/*):
 *   POST /push   Append (or merge-by-hash) one receipt for an address.
 *                Public + origin-allowlisted; fire-and-forget from the client.
 *   GET  /list?address=0x..   Return that address's receipts, newest-first.
 *
 * Storage (AGENT_KV):
 *   history:<addr-lowercase>  → JSON array of rows, newest-first, capped HISTORY_MAX
 *                               row = { kind, chain, hash, status, text, at }
 *
 * Idempotency: a /push whose `hash` matches an existing row UPDATES that row
 * (status/text) instead of duplicating it — so a trade's pending→done update
 * collapses into one receipt. The original `at` (and thus the client-side id)
 * is preserved so the History page dedupes server vs local cleanly.
 */

const ALLOWED_ORIGINS = [
  'https://oneliq.xyz',
  'https://www.oneliq.xyz',
  'https://arcswap.pages.dev',
  'https://status.oneliq.xyz',
];

const HISTORY_MAX = 100;      // rows kept per wallet
const TEXT_MAX    = 200;      // chars of free-form receipt text
const KIND_MAX    = 32;
const STATUS_MAX  = 24;
const HASH_MAX    = 80;       // 0x + 64 hex normally; allow a little slack

function isAllowed(origin) {
  return !origin
    || ALLOWED_ORIGINS.includes(origin)
    || origin.endsWith('.arcswap.pages.dev')
    || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function cors(origin, extra = {}) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
    ...extra,
  };
}

function json(body, origin, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}

function bad(msg, origin, status = 400) {
  return json({ error: msg }, origin, status);
}

function normAddr(a) {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : null;
}

function str(v, max) {
  if (typeof v !== 'string') return '';
  return v.length > max ? v.slice(0, max) : v;
}

// Sanitize one incoming receipt into the stored shape.
function cleanRow(body) {
  const hashRaw = typeof body.hash === 'string' ? body.hash : '';
  const hash = /^0x[0-9a-fA-F]{1,}$/.test(hashRaw) ? hashRaw.slice(0, HASH_MAX) : '';
  let at = Number(body.at);
  if (!Number.isFinite(at) || at <= 0 || at > Date.now() + 86_400_000) at = Date.now();
  return {
    kind:   str(body.kind, KIND_MAX),
    chain:  str(body.chain, KIND_MAX),
    hash,
    status: str(body.status, STATUS_MAX) || 'done',
    text:   str(body.text, TEXT_MAX),
    at,
  };
}

async function handlePush(request, env, origin) {
  let body;
  try { body = await request.json(); } catch { return bad('invalid JSON', origin); }
  const addr = normAddr(body?.address);
  if (!addr) return bad('bad address', origin);

  const row = cleanRow(body);
  const key = `history:${addr}`;

  let rows = [];
  try { rows = JSON.parse((await env.AGENT_KV.get(key)) || '[]'); } catch { rows = []; }
  if (!Array.isArray(rows)) rows = [];

  // Merge-by-hash: update an existing receipt instead of duplicating it.
  const idx = row.hash ? rows.findIndex(r => r && r.hash && r.hash === row.hash) : -1;
  if (idx >= 0) {
    const prev = rows[idx];
    rows[idx] = {
      kind:   row.kind   || prev.kind,
      chain:  row.chain  || prev.chain,
      hash:   prev.hash,
      status: row.status || prev.status,
      text:   row.text   || prev.text,
      at:     prev.at    || row.at,   // keep original timestamp → stable id
    };
  } else {
    rows.unshift(row);
  }

  rows.sort((a, b) => (b.at || 0) - (a.at || 0));
  if (rows.length > HISTORY_MAX) rows = rows.slice(0, HISTORY_MAX);

  await env.AGENT_KV.put(key, JSON.stringify(rows));
  return json({ ok: true, count: rows.length }, origin);
}

async function handleList(url, env, origin) {
  const addr = normAddr(url.searchParams.get('address'));
  if (!addr) return bad('bad address', origin);
  let rows = [];
  try { rows = JSON.parse((await env.AGENT_KV.get(`history:${addr}`)) || '[]'); } catch { rows = []; }
  if (!Array.isArray(rows)) rows = [];
  return json({ rows }, origin);
}

export async function onRequest(context) {
  const { request, env } = context;
  const origin = request.headers.get('Origin') || '';
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors(origin) });
  }
  if (!isAllowed(origin)) return bad('forbidden origin', origin, 403);
  if (!env.AGENT_KV) return bad('history storage unconfigured', origin, 503);

  // Path after /api/history/
  const sub = url.pathname.replace(/^\/api\/history\/?/, '').replace(/\/+$/, '');

  if (request.method === 'POST' && sub === 'push') return handlePush(request, env, origin);
  if (request.method === 'GET'  && sub === 'list') return handleList(url, env, origin);
  return bad('not found', origin, 404);
}
