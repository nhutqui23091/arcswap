/**
 * Cloudflare Pages Function: /auth/gm
 * GET  ?address=0x...                   -> current GM state (includes badges)
 * POST { address, txHash, date }        -> daily check-in (verifies real Arc tx)
 * POST { action:'x_follow', address }   -> mark X follow done (trust-based)
 *
 * Uses PROFILE_KV (same namespace as Discord profile).
 * KV key: gm:${address_lowercase}
 *
 * Arc Testnet RPC: https://rpc.testnet.arc.network (chainId 5042002)
 */

const ARC_RPC = 'https://rpc.testnet.arc.network';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsOk();
  if (request.method === 'GET')     return handleGet(request, env);
  if (request.method === 'POST')    return handlePost(request, env, context);
  return jsonRes({ error: 'Method not allowed' }, 405);
}

// -- GET --
async function handleGet(request, env) {
  const url  = new URL(request.url);
  const addr = (url.searchParams.get('address') || '').toLowerCase();
  if (!isAddr(addr)) return jsonRes({ error: 'Invalid address' }, 400);

  const kv = env.PROFILE_KV;
  if (!kv) return jsonRes({ error: 'KV not configured' }, 503);

  const state      = await getState(kv, addr);
  const today      = utcToday();
  const dailyCount = parseInt(await kv.get('gm:daily:' + today) || '0', 10);

  let saidGm = false;
  try {
    const profileRaw = await kv.get('profile:' + addr);
    if (profileRaw) saidGm = JSON.parse(profileRaw).said_gm || false;
  } catch {}

  return jsonRes({
    ...state,
    already_checked_in: state.last_checkin === today,
    daily_count: dailyCount,
    said_gm: saidGm,
  });
}

// -- POST --
async function handlePost(request, env, context) {
  const kv = env.PROFILE_KV;
  if (!kv) return jsonRes({ error: 'KV not configured' }, 503);

  let body;
  try { body = await request.json(); }
  catch { return jsonRes({ error: 'Invalid JSON body' }, 400); }

  const addr = ((body.address || '')).toLowerCase();
  if (!isAddr(addr)) return jsonRes({ error: 'Invalid address' }, 400);

  const today = utcToday();
  const state = await getState(kv, addr);

  // Trust-based action: mark X follow as done (no tx required)
  if (body.action === 'x_follow') {
    const updated = { ...state, x_follow_done: true };
    await kv.put('gm:' + addr, JSON.stringify(updated));
    return jsonRes({ ...updated, already_checked_in: state.last_checkin === today });
  }

  // Daily check-in: verify real Arc Testnet transaction
  const { txHash, date } = body;

  if (!txHash || !/^0x[0-9a-f]{64}$/i.test(txHash)) {
    return jsonRes({ error: 'Invalid transaction hash. Expected 0x + 64 hex chars.' }, 400);
  }
  if (date !== today) {
    return jsonRes({ error: 'Date mismatch. Use today UTC date (' + today + ').' }, 400);
  }

  // Rate-limit: one check-in per wallet per day
  if (state.last_checkin === today) {
    return jsonRes({ ...state, already_checked_in: true, message: 'Already checked in today.' });
  }

  // Verify the transaction exists on Arc Testnet and was sent by this wallet
  const verify = await verifyArcTx(txHash, addr);
  if (!verify.ok) {
    return jsonRes({ error: verify.error }, 400);
  }

  // -- Streak logic --
  const yesterday  = utcOffset(-1);
  const twoDaysAgo = utcOffset(-2);

  let streak     = state.streak || 0;
  let freezes    = typeof state.freezes_left === 'number' ? state.freezes_left : 3;
  let freezeUsed = false;

  const isFirstCheckin = !state.last_checkin;

  if (isFirstCheckin) {
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

  // Bonus freeze at milestone days (capped at 5)
  if ([7, 30, 100].includes(streak) && freezes < 5) {
    freezes = Math.min(freezes + 1, 5);
  }

  const history        = [...(state.history || []).slice(-89), today];
  const totalCheckins  = (state.total_checkins || 0) + 1;

  // -- Badge logic --
  const badges = [...(state.badges || [])];

  // Welcome: requires at least 1 check-in + Discord linked + said GM in #gm-gn
  let discordLinked = false; let saidGm = false;
  try {
    const profileRaw = await kv.get('profile:' + addr);
    if (profileRaw) { const p = JSON.parse(profileRaw); discordLinked = !!p.discord_id; saidGm = p.said_gm || false; }
  } catch {}
  if (totalCheckins >= 1 && discordLinked && saidGm && !badges.includes('welcome')) {
    badges.push('welcome');
  }
  if (streak >= 7 && !badges.includes('streak7')) {
    badges.push('streak7');
  }
  if (!badges.includes('tx100')) {
    const txCount = await getArcTxCount(addr);
    if (txCount >= 100) badges.push('tx100');
  }

  const newState = {
    last_checkin:   today,
    last_tx_hash:   txHash,
    streak,
    freezes_left:   freezes,
    points:         (state.points || 0) + streak,
    history,
    total_checkins: totalCheckins,
    x_follow_done:  state.x_follow_done || false,
    badges,
  };

  await kv.put('gm:' + addr, JSON.stringify(newState));

  // Increment daily global count (non-atomic, acceptable for streak MVP)
  const dayKey = 'gm:daily:' + today;
  const cnt    = parseInt(await kv.get(dayKey) || '0', 10);
  await kv.put(dayKey, String(cnt + 1), { expirationTtl: 86400 * 3 });

  // Track GM check-in in metrics. Uses context.waitUntil() so CF doesn't
  // kill the fetch after the response is returned.
  try {
    const base = new URL(request.url).origin;
    context.waitUntil(
      fetch(base + '/api/metrics/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'gm-checkin', chain: 'arc', address: addr, txHash }),
      }).catch(() => {})
    );
  } catch {}

  return jsonRes({
    ...newState,
    already_checked_in: false,
    freeze_used: freezeUsed,
    daily_count: cnt + 1,
  });
}

// -- Arc Testnet tx verification (retries up to ~10 s) --
async function verifyArcTx(txHash, expectedFrom) {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await sleep(2000);
    try {
      const res = await fetch(ARC_RPC, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method:  'eth_getTransactionByHash',
          params:  [txHash],
        }),
      });
      const json = await res.json();
      const tx   = json.result;

      if (!tx) continue; // not found yet, retry

      if (tx.from?.toLowerCase() !== expectedFrom) {
        return { ok: false, error: 'Transaction sender does not match wallet address.' };
      }
      return { ok: true };

    } catch (e) {
      console.warn('[gm] verifyArcTx attempt', attempt, e?.message);
    }
  }
  return {
    ok: false,
    error: 'Transaction not found on Arc Testnet after retries. Ensure you are on Arc Testnet (chainId 5042002) and try again.',
  };
}

// -- helpers --
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getArcTxCount(address) {
  try {
    const res = await fetch(ARC_RPC, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method:  'eth_getTransactionCount',
        params:  [address, 'latest'],
      }),
    });
    const json = await res.json();
    if (json.result) return parseInt(json.result, 16);
  } catch(e) {
    console.warn('[gm] getArcTxCount:', e?.message);
  }
  return 0;
}

async function getState(kv, addr) {
  try {
    const raw = await kv.get('gm:' + addr);
    if (raw) return { ...defaultState(), ...JSON.parse(raw) };
  } catch {}
  return defaultState();
}

function defaultState() {
  return {
    last_checkin:   null,
    last_tx_hash:   null,
    streak:         0,
    freezes_left:   3,
    points:         0,
    history:        [],
    total_checkins: 0,
    x_follow_done:  false,
    badges:         [],
  };
}

function utcToday() { return new Date().toISOString().slice(0, 10); }

function utcOffset(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isAddr(s)  { return /^0x[0-9a-f]{40}$/.test(s); }

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
