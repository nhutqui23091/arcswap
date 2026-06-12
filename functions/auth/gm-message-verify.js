/**
 * Cloudflare Pages Function: /auth/gm-message-verify
 * POST { address } -> verify user posted in #gm-gn Discord channel
 *
 * Required env vars:
 *   ONELIQ_GM_GN_CHANNEL_ID  - Discord channel ID for #gm-gn
 *   DISCORD_BOT_TOKEN         - Bot token (bot must have access to the channel)
 *
 * Required KV binding: PROFILE_KV
 * User must have Discord linked (profile:${address} must contain discord_id).
 *
 * On success: updates profile:${address} with said_gm:true
 *             awards welcome badge if check-in + discord + said_gm all met
 */

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsOk();
  if (request.method !== 'POST') return jsonRes({ error: 'Method not allowed' }, 405);

  const kv = env.PROFILE_KV;
  if (!kv) return jsonRes({ error: 'KV not configured' }, 503);

  let body;
  try { body = await request.json(); }
  catch { return jsonRes({ error: 'Invalid JSON body' }, 400); }

  const addr = (body.address || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    return jsonRes({ error: 'Invalid address' }, 400);
  }

  const channelId = env.ONELIQ_GM_GN_CHANNEL_ID;
  const botToken  = env.DISCORD_BOT_TOKEN;

  if (!channelId || !botToken) {
    return jsonRes({ error: 'GM message verification not configured. Set ONELIQ_GM_GN_CHANNEL_ID and DISCORD_BOT_TOKEN in Cloudflare Pages env vars.' }, 503);
  }

  // Read Discord ID from profile KV
  const profileRaw = await kv.get('profile:' + addr);
  if (!profileRaw) {
    return jsonRes({ error: 'Discord not linked. Link Discord in Profile first.' }, 400);
  }

  let profile;
  try { profile = JSON.parse(profileRaw); }
  catch { return jsonRes({ error: 'Invalid profile data.' }, 500); }

  const discordId = profile.discord_id;
  if (!discordId) {
    return jsonRes({ error: 'Discord not linked. Re-link Discord in Profile.' }, 400);
  }

  // Fetch last 100 messages from #gm-gn channel
  let messages;
  try {
    const res = await fetch(
      'https://discord.com/api/v10/channels/' + channelId + '/messages?limit=100',
      { headers: { Authorization: 'Bot ' + botToken } }
    );
    if (res.status === 403) {
      console.error('[gm-verify] Bot lacks access to channel', channelId);
      return jsonRes({ error: 'Bot lacks access to #gm-gn channel. Ensure the bot role has View Channel permission.' }, 502);
    }
    if (!res.ok) {
      const t = await res.text();
      console.error('[gm-verify] Discord API error:', res.status, t);
      return jsonRes({ error: 'Discord API error (' + res.status + ').' }, 502);
    }
    messages = await res.json();
  } catch(e) {
    console.error('[gm-verify] fetch failed:', e?.message);
    return jsonRes({ error: 'Failed to reach Discord API: ' + (e?.message || String(e)) }, 502);
  }

  const found = Array.isArray(messages) && messages.some(m => m.author?.id === discordId);

  if (!found) {
    return jsonRes({
      verified: false,
      message: 'No message found from your Discord account in #gm-gn. Post a GM and try again.',
    });
  }

  // Update profile with said_gm: true
  const updatedProfile = { ...profile, said_gm: true };
  await kv.put('profile:' + addr, JSON.stringify(updatedProfile));

  // Check if welcome badge should be awarded now
  const gmRaw = await kv.get('gm:' + addr);
  let gmState = {};
  try { if (gmRaw) gmState = JSON.parse(gmRaw); } catch {}

  const badges = [...(gmState.badges || [])];
  const welcomeAwarded = (gmState.total_checkins || 0) >= 1 && !badges.includes('welcome');
  if (welcomeAwarded) badges.push('welcome');

  if (welcomeAwarded) {
    await kv.put('gm:' + addr, JSON.stringify({ ...gmState, badges }));
  }

  return jsonRes({ verified: true, said_gm: true, welcome_awarded: welcomeAwarded, badges });
}

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
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
