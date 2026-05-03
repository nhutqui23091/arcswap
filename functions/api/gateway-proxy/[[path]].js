/**
 * Cloudflare Pages Function: server-side proxy to Circle Gateway REST API.
 *
 * Why a proxy?
 *  1. CORS: gateway-api-testnet.circle.com may or may not enable CORS for our
 *     Pages domain. Routing through same-origin /api/* sidesteps that entirely.
 *  2. Auth: if Circle starts requiring a Bearer token for testnet (currently
 *     unauthenticated), we can inject env.GATEWAY_KEY here without leaking it
 *     to the browser. For now it's pass-through.
 *  3. Origin allowlist: defense-in-depth — only requests from our own pages
 *     are forwarded.
 *
 * Routing:
 *   Browser  → POST /api/gateway-proxy/v1/balances
 *   Function → POST https://gateway-api-testnet.circle.com/v1/balances
 *
 *   Browser  → POST /api/gateway-proxy/v1/transfer
 *   Function → POST https://gateway-api-testnet.circle.com/v1/transfer
 */
const UPSTREAM = 'https://gateway-api-testnet.circle.com';

const ALLOWED_ORIGINS = [
  'https://arcswap.net',
  'https://www.arcswap.net',
  'https://arcswap.pages.dev',
];

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const origin = request.headers.get('Origin') || '';
  const isAllowedOrigin = !origin
    || ALLOWED_ORIGINS.includes(origin)
    || origin.endsWith('.arcswap.pages.dev')
    // Allow localhost for `wrangler pages dev` testing
    || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (origin && !isAllowedOrigin) {
    return new Response('Forbidden: origin not allowed', { status: 403 });
  }

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // Extract path after /api/gateway-proxy/  →  e.g. "v1/balances"
  const m = url.pathname.match(/^\/api\/gateway-proxy\/(.+)$/);
  if (!m) return new Response('Bad request: missing proxy path', { status: 400 });
  const upstreamPath = m[1];

  // Light path allowlist — don't proxy arbitrary paths
  if (!/^v1\/(balances|transfer|info)(\/|$)/.test(upstreamPath)) {
    return new Response('Forbidden: path not allowed', { status: 403 });
  }

  const targetUrl = `${UPSTREAM}/${upstreamPath}${url.search}`;
  const upstreamHeaders = new Headers();
  upstreamHeaders.set('Content-Type', request.headers.get('Content-Type') || 'application/json');
  upstreamHeaders.set('Accept', request.headers.get('Accept') || 'application/json');
  // Optional: add server-side Bearer token if/when Circle requires it.
  // Set GATEWAY_KEY in Cloudflare Pages env vars (encrypted secret).
  if (env.GATEWAY_KEY) {
    upstreamHeaders.set('Authorization', `Bearer ${env.GATEWAY_KEY}`);
  }
  const ua = request.headers.get('User-Agent');
  if (ua) upstreamHeaders.set('User-Agent', ua);

  let upstreamResp;
  try {
    upstreamResp = await fetch(targetUrl, {
      method: request.method,
      headers: upstreamHeaders,
      body: request.method !== 'GET' && request.method !== 'HEAD'
        ? await request.text()
        : undefined,
    });
  } catch (e) {
    console.error('[gateway-proxy] upstream fetch failed:', e?.message);
    return new Response(JSON.stringify({ error: 'Upstream unreachable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const respBody = await upstreamResp.text();
  const respHeaders = new Headers();
  respHeaders.set('Content-Type', upstreamResp.headers.get('Content-Type') || 'application/json');
  respHeaders.set('Access-Control-Allow-Origin', origin || '*');
  respHeaders.set('Access-Control-Allow-Credentials', 'true');
  respHeaders.set('Cache-Control', 'no-store');

  return new Response(respBody, { status: upstreamResp.status, headers: respHeaders });
}
