/**
 * ArcSwap Agent Cron — Cloudflare Worker.
 *
 * Runs once per minute (configured in wrangler.toml). Calls the
 * /api/agent/cron-tick endpoint on the arcswap Pages project via a
 * service binding, which bypasses Cloudflare's public edge entirely —
 * no bot challenge, no rate limiting, no CSP friction.
 *
 * Required bindings (set in wrangler.toml or dashboard):
 *   PAGES         — service binding pointing at the arcswap Pages project
 *   CRON_SECRET   — same secret string used by the Pages function to
 *                   validate the bearer token (must match
 *                   env.CRON_SECRET on Pages side)
 *
 * Manual trigger for testing:
 *   wrangler dev   then  curl http://localhost:8787  (HTTP handler below)
 *
 * Logs:
 *   wrangler tail  to stream live invocation logs.
 */

export default {
  /**
   * Scheduled handler — invoked by Cloudflare cron at the cadence in
   * wrangler.toml [triggers] crons. `event.scheduledTime` is the
   * intended firing time (may differ slightly from actual run time).
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env));
  },

  /**
   * HTTP handler — lets you smoke-test the cron path manually.
   *   GET / → triggers a tick once (requires ?secret=<CRON_SECRET>)
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const provided = url.searchParams.get('secret');
    if (provided !== env.CRON_SECRET) {
      return new Response('forbidden', { status: 403 });
    }
    const result = await tick(env);
    return new Response(JSON.stringify(result, null, 2), {
      status: result.status === 200 ? 200 : 502,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};

async function tick(env) {
  if (!env.PAGES) {
    console.error('[cron] PAGES service binding missing');
    return { status: 500, error: 'service_binding_missing' };
  }
  if (!env.CRON_SECRET) {
    console.error('[cron] CRON_SECRET secret missing');
    return { status: 500, error: 'cron_secret_missing' };
  }

  // Internal request via service binding — bypasses public edge,
  // skips bot detection, no DNS/TLS handshake.
  const req = new Request('https://arcswap.net/api/agent/cron-tick', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.CRON_SECRET}`,
      'Content-Type': 'application/json',
      'User-Agent': 'arcswap-agent-cron-worker/1.0',
    },
  });

  let res;
  try {
    res = await env.PAGES.fetch(req);
  } catch (e) {
    console.error('[cron] service binding fetch threw:', e?.message || e);
    return { status: 502, error: String(e?.message || e) };
  }

  const body = await res.text();
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = { raw: body }; }

  console.log(`[cron] cron-tick → HTTP ${res.status}`, parsed);
  return { status: res.status, body: parsed };
}
