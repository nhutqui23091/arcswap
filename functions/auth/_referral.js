/**
 * Shared helper: record a Portal referral and award the "Connector" badge.
 *
 * Trust-based, like the other onboarding tasks — there is no reward, so the
 * referral count is purely a vanity/engagement metric. When a wallet opens the
 * Portal with ?ref=<referrer>, the frontend POSTs { action:'referral' } once.
 *
 * Storage (PROFILE_KV, key gm:${addr}):
 *   referred_by      - the wallet that referred this one (set once, immutable)
 *   referrals        - array of wallets this one has referred (deduped)
 *   referral_count   - referrals.length
 * The Connector badge is awarded to the REFERRER at REFERRAL_GOAL invites.
 */

export const REFERRAL_GOAL = 3;

export async function recordReferral(kv, refereeAddr, referrerAddr) {
  const referee  = (refereeAddr  || '').toLowerCase();
  const referrer = (referrerAddr || '').toLowerCase();

  // Reject self-referrals and malformed referrer addresses.
  if (!/^0x[0-9a-f]{40}$/.test(referrer) || referee === referrer) {
    return { recorded: false, reason: 'invalid' };
  }

  // -- Referee side: bind referred_by once. --
  let refereeState = {};
  try { const raw = await kv.get('gm:' + referee); if (raw) refereeState = JSON.parse(raw); } catch {}
  if (refereeState.referred_by) {
    return { recorded: false, reason: 'already' };
  }
  refereeState.referred_by = referrer;
  await kv.put('gm:' + referee, JSON.stringify(refereeState));

  // -- Referrer side: append to their referrals list + maybe award badge. --
  let referrerState = {};
  try { const raw = await kv.get('gm:' + referrer); if (raw) referrerState = JSON.parse(raw); } catch {}

  const list = Array.isArray(referrerState.referrals) ? referrerState.referrals : [];
  if (!list.includes(referee)) list.push(referee);
  referrerState.referrals      = list;
  referrerState.referral_count = list.length;

  const badges = Array.isArray(referrerState.badges) ? referrerState.badges : [];
  let badgeAwarded = false;
  if (list.length >= REFERRAL_GOAL && !badges.includes('referral')) {
    badges.push('referral');
    referrerState.badges = badges;
    badgeAwarded = true;
  }

  await kv.put('gm:' + referrer, JSON.stringify(referrerState));

  return { recorded: true, referrerCount: list.length, badgeAwarded };
}
