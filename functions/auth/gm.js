/**
 * Cloudflare Pages Function: /auth/gm
 * GET  ?address=0x...                       -> current GM state
 * POST { address, signature, date, nonce }  -> daily check-in
 * POST { action:'x_follow', address }       -> mark X follow done (trust-based)
 *
 * Uses PROFILE_KV (same namespace as Discord profile).
 * KV key: gm:${address_lowercase}
 */
export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsOk();
  if (request.method === 'GET')     return handleGet(request, env);
  if (request.method === 'POST')    return handlePost(request, env);
  return jsonRes({ error: 'Method not allowed' }, 405);
}

// ── GET ───────────────────────────────────────────────────────────────────────
async function handleGet(request, env) {
  const url  = new URL(request.url);
  const addr = (url.searchParams.get('address') || '').toLowerCase();
  if (!isAddr(addr)) return jsonRes({ error: 'Invalid address' }, 400);

  const kv = env.PROFILE_KV;
  if (!kv) return jsonRes({ error: 'KV not configured' }, 503);

  const state      = await getState(kv, addr);
  const today      = utcToday();
  const dailyCount = parseInt(await kv.get('gm:daily:' + today) || '0', 10);

  return jsonRes({
    ...state,
    already_checked_in: state.last_checkin === today,
    daily_count: dailyCount,
  });
}

// ── POST ──────────────────────────────────────────────────────────────────────
async function handlePost(request, env) {
  const kv = env.PROFILE_KV;
  if (!kv) return jsonRes({ error: 'KV not configured' }, 503);

  let body;
  try { body = await request.json(); }
  catch { return jsonRes({ error: 'Invalid JSON body' }, 400); }

  const addr = ((body.address || '')).toLowerCase();
  if (!isAddr(addr)) return jsonRes({ error: 'Invalid address' }, 400);

  const today = utcToday();
  const state = await getState(kv, addr);

  // Trust-based action: mark X follow as done
  if (body.action === 'x_follow') {
    const updated = { ...state, x_follow_done: true };
    await kv.put('gm:' + addr, JSON.stringify(updated));
    return jsonRes({ ...updated, already_checked_in: state.last_checkin === today });
  }

  // Regular check-in: validate signature and date
  const { signature, date, nonce } = body;
  if (!signature || typeof signature !== 'string' || !/^0x[0-9a-f]{100,}/i.test(signature)) {
    return jsonRes({ error: 'Invalid signature' }, 400);
  }
  if (date !== today) return jsonRes({ error: 'Date mismatch. Use today UTC date.' }, 400);

  if (state.last_checkin === today) {
    return jsonRes({ ...state, already_checked_in: true, message: 'Already checked in today.' });
  }

  // Streak logic
  const yesterday  = utcOffset(-1);
  const twoDaysAgo = utcOffset(-2);

  let streak     = state.streak || 0;
  let freezes    = typeof state.freezes_left === 'number' ? state.freezes_left : 3;
  let freezeUsed = false;

  if (!state.last_checkin) {
    streak = 1;
  } else if (state.last_checkin === yesterday) {
    streak += 1;
  } else if (state.last_checkin === twoDaysAgo && freezes > 0) {
    streak += 1;
    freezes -= 1;
    freezeUsed = true;
  } else {
    streak = 1;
  }

  // Bonus freeze at milestone days
  if ([7, 30, 100].includes(streak) && freezes < 5) {
    freezes = Math.min(freezes + 1, 5);
  }

  const history  = [...(state.history || []).slice(-89), today];
  const newState = {
    last_checkin:  today,
    streak,
    freezes_left:  freezes,
    points:        (state.points || 0) + streak,
    history,
    x_follow_done: state.x_follow_done || false,
  };

  await kv.put('gm:' + addr, JSON.stringify(newState));

  // Increment daily global count (non-atomic, acceptable for streak MVP)
  const dayKey = 'gm:daily:' + today;
  const cnt    = parseInt(await kv.get(dayKey) || '0', 10);
  await kv.put(dayKey, String(cnt + 1), { expirationTtl: 86400 * 3 });

  return jsonRes({
    ...newState,
    already_checked_in: false,
    freeze_used: freezeUsed,
    daily_count: cnt + 1,
  });
}

// ── helpers ───────────────────────────────────────────────────────────────────
async function getState(kv, addr) {
  try {
    const raw = await kv.get('gm:' + addr);
    if (raw) return { ...defaultState(), ...JSON.parse(raw) };
  } catch {}
  return defaultState();
}

function defaultState() {
  return { last_checkin: null, streak: 0, freezes_left: 3, points: 0, history: [], x_follow_done: false };
}

function utcToday() { return new Date().toISOString().slice(0, 10); }

function utcOffset(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isAddr(s) { return /^0x[0-9a-f]{40}$/.test(s); }

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function corsOk() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
