/**
 * Shared helper: Star Points — Oneliq Portal's single engagement score.
 *
 * Stars are computed DETERMINISTICALLY from a wallet's gm state + Discord
 * profile, never incremented. That means every code path that returns gm
 * state can recompute the same total with no risk of double-counting across
 * the idempotent onboarding / referral / check-in flows.
 *
 * Sources of truth:
 *   gm:${addr}        -> x_follow_done, like_done, retweet_done, badges[],
 *                        referral_count, total_checkins
 *   profile:${addr}   -> discord_id (Discord linked), said_gm (#gm-gn message)
 *
 * Keep STAR_VALUES in sync with the "+N" tags shown next to each task in
 * portal.html and the FAQ "How are Star Points calculated?" answer.
 */

export const STAR_VALUES = {
  // Onboarding tasks (one-time)
  x_follow: 20, // Follow Oneliq on X
  discord:  20, // Join Oneliq Discord
  like:      5, // Like the launch tweet
  retweet:   5, // Retweet the launch tweet
  reply:     5, // Reply to the launch tweet
  gm:        5, // Say GM in #gm-gn

  // Bonus tasks (one-time; do NOT count toward the Welcome badge)
  like2:     5, // Like the latest tweet
  retweet2:  5, // Retweet the latest tweet
  reply2:    5, // Reply to the latest tweet
  like3:     5, // Like the new tweet
  retweet3:  5, // Retweet the new tweet
  reply3:    5, // Reply to the new tweet

  // Badges (one-time bonus on top of the tasks that unlock them)
  badge: {
    welcome:  50,
    streak7:  40,
    tx100:   150,
    referral:200, // Connector
    og:       75,
  },

  // Recurring / scaling
  referral: 30, // per invited friend who reaches the Welcome badge
  checkin:   3, // per daily check-in
};

/**
 * Compute a wallet's total Star Points.
 * @param {object} gm       gm:${addr} state (may be partial)
 * @param {object} profile  profile:${addr} (optional; for discord + said_gm)
 */
export function computeStars(gm = {}, profile = {}) {
  let stars = 0;

  // -- Onboarding tasks --
  if (gm.x_follow_done)    stars += STAR_VALUES.x_follow;
  if (profile?.discord_id) stars += STAR_VALUES.discord;
  if (gm.like_done)        stars += STAR_VALUES.like;
  if (gm.retweet_done)     stars += STAR_VALUES.retweet;
  if (gm.reply_done)       stars += STAR_VALUES.reply;
  if (profile?.said_gm)    stars += STAR_VALUES.gm;

  // -- Bonus tasks --
  if (gm.like2_done)       stars += STAR_VALUES.like2;
  if (gm.retweet2_done)    stars += STAR_VALUES.retweet2;
  if (gm.reply2_done)      stars += STAR_VALUES.reply2;
  if (gm.like3_done)       stars += STAR_VALUES.like3;
  if (gm.retweet3_done)    stars += STAR_VALUES.retweet3;
  if (gm.reply3_done)      stars += STAR_VALUES.reply3;

  // -- Badges --
  const badges = Array.isArray(gm.badges) ? gm.badges : [];
  for (const b of badges) {
    if (STAR_VALUES.badge[b]) stars += STAR_VALUES.badge[b];
  }

  // -- Referrals (each friend who earned Welcome) --
  const refCount = Math.max(0, gm.referral_count || 0);
  stars += refCount * STAR_VALUES.referral;

  // -- Daily check-ins --
  const checkins = Math.max(0, gm.total_checkins || 0);
  stars += checkins * STAR_VALUES.checkin;

  return stars;
}
