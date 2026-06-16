/**
 * Cloudflare Pages Function: /auth/role-debug?address=0x...
 *
 * TEMPORARY diagnostic for the Early Oneliq role grant. Reports which env
 * vars are present (booleans only — never the values), whether the wallet
 * has Discord linked + the Welcome badge, and the exact Discord API result
 * of attempting the role assignment. Remove once role granting is verified.
 *
 * Env: ONELIQ_GUILD_ID, ONELIQ_EARLY_ROLE_ID, DISCORD_BOT_TOKEN
 * KV:  PROFILE_KV
 */
export async function onRequestGet(context) {
  const { request, env } = context;
  const url  = new URL(request.url);
  const addr = (url.searchParams.get('address') || '').toLowerCase();

  const out = {
    address: addr || null,
    env: {
      ONELIQ_GUILD_ID:      !!env.ONELIQ_GUILD_ID,
      ONELIQ_EARLY_ROLE_ID: !!env.ONELIQ_EARLY_ROLE_ID,
      DISCORD_BOT_TOKEN:     !!env.DISCORD_BOT_TOKEN,
    },
  };

  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    out.note = 'Pass ?address=0x... (your test wallet, lowercase).';
    return json(out);
  }

  const kv = env.PROFILE_KV;
  if (!kv) { out.error = 'PROFILE_KV not bound'; return json(out); }

  // Profile / discord link
  let discordId = null;
  try {
    const p = await kv.get('profile:' + addr);
    if (p) discordId = JSON.parse(p).discord_id || null;
  } catch {}
  out.discord_linked = !!discordId;

  // GM state / badge + flags
  try {
    const g = await kv.get('gm:' + addr);
    const gm = g ? JSON.parse(g) : {};
    out.has_welcome_badge = Array.isArray(gm.badges) && gm.badges.includes('welcome');
    out.early_role_granted = !!gm.early_role_granted;
    out.task_flags = {
      x_follow_done: !!gm.x_follow_done,
      like_done:     !!gm.like_done,
      retweet_done:  !!gm.retweet_done,
    };
  } catch {}

  // Attempt the role grant and report the raw Discord result
  const guildId  = env.ONELIQ_GUILD_ID;
  const roleId   = env.ONELIQ_EARLY_ROLE_ID;
  const botToken = env.DISCORD_BOT_TOKEN;

  if (!guildId || !roleId || !botToken) {
    out.grant_attempt = 'skipped — missing one of ONELIQ_GUILD_ID / ONELIQ_EARLY_ROLE_ID / DISCORD_BOT_TOKEN';
    return json(out);
  }
  if (!discordId) {
    out.grant_attempt = 'skipped — wallet has no linked Discord (profile.discord_id)';
    return json(out);
  }

  try {
    const res = await fetch(
      'https://discord.com/api/v10/guilds/' + guildId + '/members/' + discordId + '/roles/' + roleId,
      { method: 'PUT', headers: { Authorization: 'Bot ' + botToken, 'Content-Length': '0' } }
    );
    const text = await res.text().catch(() => '');
    out.discord_status = res.status; // 204 = success, 403 = perms/hierarchy, 404 = bad id, 401 = bad token
    out.discord_body   = text || '(empty)';
    out.grant_attempt  = res.ok ? 'SUCCESS — role assigned' : 'FAILED — see discord_status/body';
    out.hint = res.status === 403
      ? "403: bot is missing Manage Roles, OR the bot's highest role sits BELOW Early Oneliq in Server Settings > Roles."
      : res.status === 404
      ? '404: wrong ONELIQ_GUILD_ID / ONELIQ_EARLY_ROLE_ID, or the user is not a member of the guild.'
      : res.status === 401
      ? '401: DISCORD_BOT_TOKEN is invalid.'
      : undefined;
  } catch (e) {
    out.grant_attempt = 'ERROR: ' + (e?.message || String(e));
  }

  return json(out);
}

function json(data) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
