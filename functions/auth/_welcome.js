/**
 * Shared helper: award the "Welcome to Oneliq" badge once a wallet has
 * completed all five onboarding tasks, and grant the Early Oneliq Discord
 * role on award.
 *
 * The five tasks:
 *   1. Follow Oneliq on X      -> gm:${addr}.x_follow_done   (trust-based)
 *   2. Like the GM tweet       -> gm:${addr}.like_done       (trust-based)
 *   3. Retweet the GM tweet    -> gm:${addr}.retweet_done    (trust-based)
 *   4. Join Oneliq Discord     -> profile:${addr}.discord_id (OAuth link)
 *   5. Say GM in #gm-gn         -> profile:${addr}.said_gm    (bot-verified)
 *
 * Role grant uses the same Discord bot as og-verify. Required env vars:
 *   ONELIQ_GUILD_ID        - Discord server (guild) ID
 *   ONELIQ_EARLY_ROLE_ID   - Role ID for "Early Oneliq"
 *   DISCORD_BOT_TOKEN      - Bot token with Manage Roles permission
 * The bot's highest role must sit ABOVE the Early Oneliq role in the
 * server's role list, or Discord rejects the assignment (403).
 *
 * Graceful degrade: if the role env vars are missing or Discord rejects
 * the call, the badge is still awarded and roleAssigned is returned false.
 */

export async function maybeAwardWelcome(env, kv, addr) {
  const gmRaw = await kv.get('gm:' + addr);
  let gm = {};
  try { if (gmRaw) gm = JSON.parse(gmRaw); } catch {}

  const badges = Array.isArray(gm.badges) ? gm.badges : [];
  if (badges.includes('welcome')) {
    return { awarded: false, badges, roleAssigned: false };
  }

  const profRaw = await kv.get('profile:' + addr);
  let prof = {};
  try { if (profRaw) prof = JSON.parse(profRaw); } catch {}

  const allDone =
    !!gm.x_follow_done &&
    !!gm.like_done &&
    !!gm.retweet_done &&
    !!prof.discord_id &&
    !!prof.said_gm;

  if (!allDone) {
    return { awarded: false, badges, roleAssigned: false };
  }

  const newBadges = [...badges, 'welcome'];
  await kv.put('gm:' + addr, JSON.stringify({ ...gm, badges: newBadges }));

  let roleAssigned = false;
  try { roleAssigned = await assignEarlyRole(env, prof.discord_id); }
  catch (e) { console.error('[welcome] role assign failed:', e?.message); }

  return { awarded: true, badges: newBadges, roleAssigned };
}

async function assignEarlyRole(env, discordId) {
  const guildId  = env.ONELIQ_GUILD_ID;
  const roleId   = env.ONELIQ_EARLY_ROLE_ID;
  const botToken = env.DISCORD_BOT_TOKEN;

  if (!guildId || !roleId || !botToken || !discordId) {
    console.warn('[welcome] role grant skipped - missing env or discordId');
    return false;
  }

  // PUT adds the role; Discord returns 204 on success (and on a no-op if the
  // member already has it).
  const res = await fetch(
    'https://discord.com/api/v10/guilds/' + guildId + '/members/' + discordId + '/roles/' + roleId,
    {
      method:  'PUT',
      headers: {
        Authorization:  'Bot ' + botToken,
        'Content-Length': '0',
      },
    }
  );

  if (res.ok) return true;
  const t = await res.text().catch(() => '');
  console.error('[welcome] Discord role grant error:', res.status, t);
  return false;
}
