/**
 * Cloudflare Pages Function: /auth/admin/rebuild-referrals
 *
 * One-time repair migration. An earlier check-in bug rebuilt the gm record
 * from scratch and wiped `referrals` / `referral_count` (see
 * functions/auth/gm.js). This recomputes each referrer's credited-invite
 * count from the referees that still carry `referred_by` + the Welcome badge,
 * and re-awards the Connector badge where earned.
 *
 * Limitation: a referee whose own record was also wiped by the bug (i.e. they
 * checked in after being referred) lost their `referred_by`, so that single
 * link is unrecoverable. This restores every link that still survives.
 *
 * Auth: X-Debug-Key header must match env.DEBUG_KEY (same gate as the agent
 * debug endpoints). GET = dry-run preview (no writes). POST = apply.
 * Idempotent — safe to run more than once.
 *
 * Operator workflow:
 *   1. Cloudflare Pages → Settings → Variables → add DEBUG_KEY (any value)
 *   2. curl -H "X-Debug-Key: <value>" https://oneliq.xyz/auth/admin/rebuild-referrals      (preview)
 *   3. curl -X POST -H "X-Debug-Key: <value>" https://oneliq.xyz/auth/admin/rebuild-referrals  (apply)
 *   4. Delete DEBUG_KEY env var — endpoint goes back to 503
 */

import { computeStars } from '../_stars.js';
import { REFERRAL_GOAL } from '../_referral.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
  if (request.method !== 'GET' && request.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const provided = request.headers.get('X-Debug-Key') || '';
  if (!env.DEBUG_KEY) return json(503, { error: 'disabled', message: 'Set DEBUG_KEY env var on Cloudflare Pages to enable this endpoint (delete after use).' });
  if (provided !== env.DEBUG_KEY) return json(401, { error: 'unauthorized' });

  const kv = env.PROFILE_KV;
  if (!kv) return json(503, { error: 'KV not configured' });

  const apply = request.method === 'POST';

  // 1. Load every gm record (skip the gm:daily:* counters).
  const records = new Map();
  let cursor;
  do {
    const list = await kv.list({ prefix: 'gm:', cursor, limit: 1000 });
    for (const k of list.keys) {
      if (k.name.startsWith('gm:daily:')) continue;
      const addr = k.name.slice(3);
      if (!/^0x[0-9a-f]{40}$/.test(addr)) continue;
      try { records.set(addr, JSON.parse(await kv.get(k.name) || '{}')); } catch {}
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);

  // 2. Build referrer -> Set(referees) from referees that qualify (have a
  //    referred_by and earned Welcome = completed onboarding).
  const byReferrer = new Map();
  for (const [addr, st] of records) {
    const referrer = (st.referred_by || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(referrer) || referrer === addr) continue;
    const badges = Array.isArray(st.badges) ? st.badges : [];
    if (!badges.includes('welcome')) continue;
    if (!byReferrer.has(referrer)) byReferrer.set(referrer, new Set());
    byReferrer.get(referrer).add(addr);
  }

  // 3. Write the true referrals/count back onto each referrer.
  const changes = [];
  for (const [referrer, set] of byReferrer) {
    const referees = [...set].sort();
    let st = records.get(referrer);
    if (!st) { try { st = JSON.parse(await kv.get('gm:' + referrer) || '{}'); } catch { st = {}; } }

    const before = st.referral_count || 0;
    const badges = Array.isArray(st.badges) ? [...st.badges] : [];
    let connector = false;
    if (referees.length >= REFERRAL_GOAL && !badges.includes('referral')) { badges.push('referral'); connector = true; }

    if (before === referees.length && !connector && arraysEqual(st.referrals, referees)) continue; // already correct

    const next = { ...st, referrals: referees, referral_count: referees.length, badges };
    next.stars = computeStars(next, { discord_id: next.discord_done, said_gm: next.said_gm });
    changes.push({ referrer, before, after: referees.length, connector_awarded: connector });
    if (apply) await kv.put('gm:' + referrer, JSON.stringify(next));
  }

  // 4. Make sure qualifying referees are flagged credited (so a future Welcome
  //    flow can't double-count them).
  let refereesFlagged = 0;
  if (apply) {
    for (const set of byReferrer.values()) {
      for (const referee of set) {
        const st = records.get(referee);
        if (st && !st.referral_credited) {
          await kv.put('gm:' + referee, JSON.stringify({ ...st, referral_credited: true }));
          refereesFlagged++;
        }
      }
    }
    // Drop the cached leaderboard so corrected counts show right away.
    try { await kv.delete('lb:cache:v2'); } catch {}
  }

  return json(200, {
    applied: apply,
    scanned: records.size,
    referrers_with_invites: byReferrer.size,
    referrers_changed: changes.length,
    referees_flagged: refereesFlagged,
    changes,
    note: apply ? 'Applied. Leaderboard cache cleared.' : 'Dry run — re-send as POST to apply.',
  });
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  const sa = [...a].sort();
  return sa.every((v, i) => v === b[i]);
}

function cors() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Debug-Key',
  };
}

function json(status, data) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() },
  });
}
