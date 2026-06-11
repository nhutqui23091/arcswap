/**
 * Cloudflare Pages Function: /auth/discord/callback
 *
 * Receives the Discord OAuth2 authorization code, exchanges it for an access
 * token, fetches the Discord user, stores the mapping in KV, then redirects
 * back to /balance?discord_linked=1.
 *
 * Required environment variables (Cloudflare Pages > Settings > Env vars):
 *   DISCORD_CLIENT_ID      - from discord.com/developers/applications
 *   DISCORD_CLIENT_SECRET  - same source
 *   DISCORD_REDIRECT_URI   - must match exactly: https://oneliq.xyz/auth/discord/callback
 *
 * Required KV binding:
 *   PROFILE_KV  - create a KV namespace named "PROFILE_KV" and bind it here
 */
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state'); // wallet address (lowercase)

  if (!code || !state) {
    return new Response('Missing code or state parameter.', { status: 400 });
  }

  const clientId     = env.DISCORD_CLIENT_ID;
  const clientSecret = env.DISCORD_CLIENT_SECRET;
  const redirectUri  = env.DISCORD_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return new Response('Discord OAuth is not configured on this server.', { status: 503 });
  }

  try {
    // Exchange authorization code for access token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     clientId,
        client_secret: clientSecret,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  redirectUri,
      }).toString(),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      console.error('[discord-callback] token exchange failed:', body);
      return new Response('Token exchange failed.', { status: 502 });
    }

    const { access_token } = await tokenRes.json();

    // Fetch Discord user identity
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    if (!userRes.ok) {
      return new Response('Failed to fetch Discord user.', { status: 502 });
    }

    const user = await userRes.json();

    // Store wallet <-> Discord mapping in KV
    if (env.PROFILE_KV) {
      await env.PROFILE_KV.put(
        `profile:${state.toLowerCase()}`,
        JSON.stringify({
          discord_id:          user.id,
          discord_username:    user.username,
          discord_global_name: user.global_name || user.username,
          linked_at:           new Date().toISOString(),
        })
      );
    }

    // Redirect back with confirmation flag
    const origin = new URL(request.url).origin;
    return Response.redirect(`${origin}/balance?discord_linked=1`, 302);

  } catch (err) {
    console.error('[discord-callback] unexpected error:', err);
    return new Response('Internal server error.', { status: 500 });
  }
}
