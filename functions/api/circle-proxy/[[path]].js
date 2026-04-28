/**
 * Cloudflare Pages Function: server-side proxy to Circle App Kit API.
 *
 * Why: Circle's Kit Key has Origin whitelist for browsers (CORS) but the key
 * itself works from any non-browser context (curl, server). To prevent the key
 * from being exposed in client JS at all, this function proxies all calls to
 * api.circle.com — the kit key lives only in env.KIT_KEY (Cloudflare Secret),
 * never reaches the browser.
 *
 * Routing:
 *   Browser → /api/circle-proxy/v1/stablecoinKits/swap
 *   Function → https://api.circle.com/v1/stablecoinKits/swap (with KIT_KEY)
 *
 * Setup:
 *   1. KIT_KEY must be set in Cloudflare Pages env vars (Settings → Environment
 *      variables → encrypted Secret).
 *   2. Browser code routes via /api/circle-proxy/* instead of api.circle.com
 *      (handled in arc-appkit.js fetch monkey-patch).
 */
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // Validate origin — only accept requests from our own domains.
  // (Defense in depth — Cloudflare's same-origin policy already enforces this
  // for browsers, but adding explicit check protects against bypass attempts.)
  const origin = request.headers.get('Origin') || '';
  const ALLOWED_ORIGINS = [
    'https://arcswap.net',
    'https://www.arcswap.net',
    'https://arcswap.pages.dev',
    // Allow Cloudflare Pages preview deploys (*.arcswap.pages.dev)
  ];
  const isAllowedOrigin = !origin || ALLOWED_ORIGINS.includes(origin) ||
                          origin.endsWith('.arcswap.pages.dev');
  if (origin && !isAllowedOrigin) {
    return new Response('Forbidden: origin not allowed', { status: 403 });
  }

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // Extract path after /api/circle-proxy/
  const proxyPathMatch = url.pathname.match(/^\/api\/circle-proxy\/(.+)$/);
  if (!proxyPathMatch) {
    return new Response('Bad request: missing proxy path', { status: 400 });
  }
  const circlePath = proxyPathMatch[1];

  // Validate KIT_KEY exists in env
  if (!env.KIT_KEY) {
    console.error('[circle-proxy] KIT_KEY env var missing');
    return new Response('Server misconfigured: KIT_KEY not set', { status: 500 });
  }

  // Build target URL on Circle's API
  const targetUrl = `https://api.circle.com/${circlePath}${url.search}`;

  // Build headers — strip browser-specific stuff, add server-side auth
  const upstreamHeaders = new Headers();
  upstreamHeaders.set('Content-Type', request.headers.get('Content-Type') || 'application/json');
  upstreamHeaders.set('Accept', request.headers.get('Accept') || 'application/json');
  // Add KIT_KEY from secure env (NEVER appears in client)
  upstreamHeaders.set('Authorization', `Bearer ${env.KIT_KEY}`);
  // Pass through user-agent so Circle has telemetry
  const ua = request.headers.get('User-Agent');
  if (ua) upstreamHeaders.set('User-Agent', ua);

  // Forward the request
  let upstreamResponse;
  try {
    upstreamResponse = await fetch(targetUrl, {
      method: request.method,
      headers: upstreamHeaders,
      body: request.method !== 'GET' && request.method !== 'HEAD'
        ? await request.text()
        : undefined,
    });
  } catch (e) {
    console.error('[circle-proxy] upstream fetch failed:', e?.message);
    return new Response(JSON.stringify({ error: 'Upstream unreachable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Pass response back to browser with CORS headers
  const respBody = await upstreamResponse.text();
  const respHeaders = new Headers();
  respHeaders.set('Content-Type', upstreamResponse.headers.get('Content-Type') || 'application/json');
  respHeaders.set('Access-Control-Allow-Origin', origin || '*');
  respHeaders.set('Access-Control-Allow-Credentials', 'true');
  respHeaders.set('Cache-Control', 'no-store');

  return new Response(respBody, {
    status: upstreamResponse.status,
    headers: respHeaders,
  });
}
