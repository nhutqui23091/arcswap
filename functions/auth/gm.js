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

import { maybeAwardWelcome, reconcileLegacyWelcome } from './_welcome.js';
import { recordReferral } from './_referral.js';
import { computeStars } from './_stars.js';
import { computeStreak } from './_streak.js';

const ARC_RPC = 'https://rpc.testnet.arc.network';
// OneliqCheckIn contract — a valid check-in is a successful call to it
// (contracts/OneliqCheckIn.sol). Lowercased for case-insensitive compares.
const ONELIQ_CHECKIN = '0x368a0e854ec69ec10b50d20fcafc1baf8b7eff10';

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

  let state        = await getState(kv, addr);
  const today      = utcToday();
  const dailyCount = parseInt(await kv.get('gm:daily:' + today) || '0', 10);

  let saidGm = false, discordId = null, discordName = null;
  try {
    const profileRaw = await kv.get('profile:' + addr);
    if (profileRaw) {
      const p = JSON.parse(profileRaw);
      saidGm      = p.said_gm || false;
      discordId   = p.discord_id || null;
      discordName = p.discord_global_name || p.discord_username || null;
    }
  } catch {}

  // Backfill wallets that earned Welcome under the old 3-task rule: complete
  // the new X tasks and grant the Early Oneliq role once.
  state = await reconcileLegacyWelcome(env, kv, addr, state, discordId);

  // Ensure this wallet has a short referral code (for /portal?ref=<code>).
  state = await ensureRefCode(kv, addr, state);

  // Live on-chain tx count drives the "100 Transactions" badge progress bar.
  const txCount = await getArcTxCount(addr);

  // Star Points — computed deterministically (see _stars.js). Denormalize the
  // total, the two profile-side facts it depends on (discord_done, said_gm),
  // and the Discord name onto the gm record so the leaderboard can rank — and
  // recompute fresh stars — from a single key scan without re-reading profiles.
  const discordDone = !!discordId;
  const stars = computeStars(state, { discord_id: discordId, said_gm: saidGm });
  if (state.stars !== stars
      || state.discord_done !== discordDone
      || state.said_gm !== saidGm
      || (discordName && state.discord_name !== discordName)) {
    state = {
      ...state, stars, discord_done: discordDone, said_gm: saidGm,
      ...(discordName ? { discord_name: discordName } : {}),
    };
    await kv.put('gm:' + addr, JSON.stringify(state));
  }

  return jsonRes({
    ...state,
    already_checked_in: state.last_checkin === today,
    daily_count: dailyCount,
    said_gm: saidGm,
    tx_count: txCount,
    stars,
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

  // Persist the wallet's X/Twitter handle so the invite leaderboard can show a
  // username instead of a raw address. Trust-based, sanitised, can be cleared.
  if (body.action === 'set_x') {
    const handle = String(body.handle || '').trim().replace(/^@/, '').slice(0, 30).replace(/[^A-Za-z0-9_]/g, '');
    if ((state.x_handle || '') !== handle) {
      await kv.put('gm:' + addr, JSON.stringify({ ...state, x_handle: handle }));
    }
    return jsonRes({ ok: true, x_handle: handle });
  }

  // Portal referral: bind referrer once, bump their count, maybe award badge.
  if (body.action === 'referral') {
    await recordReferral(kv, addr, body.ref || '');
    const updated = await getState(kv, addr);
    return jsonRes({ ...updated, already_checked_in: state.last_checkin === today });
  }

  // Trust-based onboarding actions (no tx required): X follow, like, retweet.
  // X exposes no API to verify these, so completion is recorded on trust.
  const TRUST_FLAGS = {
    x_follow: 'x_follow_done',
    like: 'like_done', retweet: 'retweet_done', reply: 'reply_done',                 // launch tweet
    like2: 'like2_done', retweet2: 'retweet2_done', reply2: 'reply2_done',            // latest tweet
    like3: 'like3_done', retweet3: 'retweet3_done', reply3: 'reply3_done',            // new tweet
  };
  if (TRUST_FLAGS[body.action]) {
    const updated = { ...state, [TRUST_FLAGS[body.action]]: true };
    await kv.put('gm:' + addr, JSON.stringify(updated));
    // Completing this task may have been the 5th — try to award Welcome + role.
    const w = await maybeAwardWelcome(env, kv, addr);
    return jsonRes({
      ...updated,
      badges: w.badges,
      already_checked_in: state.last_checkin === today,
      welcome_awarded: w.awarded,
      role_assigned: w.roleAssigned,
    });
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

  // -- Streak logic (freeze-budget, recomputed from full history) --
  // `history` is the source of truth; computeStreak() replays it
  // deterministically (freeze-budget rule) so a single bad write can never
  // permanently truncate a streak — the next check-in always rebuilds it.
  const history        = [...(state.history || []).slice(-89), today];
  const prevLast       = state.last_checkin;
  const { streak, freezes_left: freezes, longest } = computeStreak(history);
  const totalCheckins  = (state.total_checkins || 0) + 1;

  // freeze_used is cosmetic (shown in the response): true when a gap was
  // bridged by freezes on this check-in.
  const dayIdx = d => Math.floor(Date.parse(d + 'T00:00:00Z') / 86400000);
  const freezeUsed = !!prevLast && /^\d{4}-\d{2}-\d{2}$/.test(prevLast)
    && (dayIdx(today) - dayIdx(prevLast)) > 1 && streak > 1;

  // -- Badge logic --
  // Welcome is awarded by the onboarding-task flow (see _welcome.js), not by
  // checking in. Check-ins only drive the streak and on-chain milestones.
  const badges = [...(state.badges || [])];

  if (streak >= 7 && !badges.includes('streak7')) {
    badges.push('streak7');
  }
  if (!badges.includes('tx100')) {
    const txCount = await getArcTxCount(addr);
    if (txCount >= 100) badges.push('tx100');
  }

  // IMPORTANT: spread the existing state first so a check-in never drops the
  // trust flags (like_done/retweet_done), denormalized fields (discord_done,
  // said_gm, stars, x_handle, discord_name) or referral data (referrals,
  // referral_count, ref_code). Only the check-in/streak fields are overwritten.
  const newState = {
    ...state,
    last_checkin:   today,
    last_tx_hash:   txHash,
    streak,
    freezes_left:   freezes,
    longest_streak: Math.max(state.longest_streak || 0, longest),
    points:         (state.points || 0) + streak,
    history,
    total_checkins: totalCheckins,
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
      if (tx.to?.toLowerCase() !== ONELIQ_CHECKIN) {
        return { ok: false, error: 'Check-in must call the OneliqCheckIn contract.' };
      }

      // Confirm the call actually succeeded (didn't revert, e.g. already
      // checked in). The receipt can lag the tx by a block, so retry on miss.
      const rcRes = await fetch(ARC_RPC, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method:  'eth_getTransactionReceipt',
          params:  [txHash],
        }),
      });
      const receipt = (await rcRes.json()).result;
      if (!receipt) continue; // not mined yet, retry
      if (receipt.status !== '0x1') {
        return { ok: false, error: 'Check-in transaction failed on-chain.' };
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

// Assign a short, URL-friendly referral code once and store a reverse lookup
// (refcode:${code} -> address) so /portal?ref=<code> can resolve the referrer.
async function ensureRefCode(kv, addr, state) {
  if (state.ref_code) return state;
  let code = '';
  for (let i = 0; i < 6; i++) {
    code = genRefCode();
    const taken = await kv.get('refcode:' + code);
    if (!taken || taken === addr) break;
  }
  const next = { ...state, ref_code: code };
  await kv.put('gm:' + addr, JSON.stringify(next));
  await kv.put('refcode:' + code, addr);
  return next;
}

function genRefCode() {
  const cs = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const buf = new Uint8Array(9);
  crypto.getRandomValues(buf);
  let s = '';
  for (const b of buf) s += cs[b % cs.length];
  return s;
}

async function getState(kv, addr) {
  try {
    const raw = await kv.get('gm:' + addr);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Legacy records predate the total_checkins counter; derive it from the
      // check-in history so their per-check-in stars are always counted. (The
      // history array is capped at ~90; any wallet past that already has an
      // authoritative total_checkins, so this only ever fills in old records.)
      if (typeof parsed.total_checkins !== 'number' && Array.isArray(parsed.history)) {
        parsed.total_checkins = parsed.history.length;
      }
      return { ...defaultState(), ...parsed };
    }
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
    referred_by:    null,
    referral_credited: false,
    referrals:      [],
    referral_count: 0,
    ref_code:       null,
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
