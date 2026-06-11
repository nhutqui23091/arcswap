/**
 * Cloudflare Pages Function: /auth/profile/:address
 *
 * GET    - return Discord profile linked to this wallet address (JSON)
 * DELETE - unlink Discord from this wallet address
 *
 * Requires KV binding: PROFILE_KV
 */
export async function onRequest(context) {
  const { request, params, env } = context;
  const addr = params.address?.toLowerCase();

  if (!addr) {
    return new Response('Missing address.', { status: 400 });
  }

  const kv  = env.PROFILE_KV;
  const key = `profile:${addr}`;

  const cors = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (request.method === 'GET') {
    const val = kv ? await kv.get(key) : null;
    if (!val) {
      return new Response(null, { status: 404, headers: cors });
    }
    return new Response(val, {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  if (request.method === 'DELETE') {
    if (kv) await kv.delete(key);
    return new Response(null, { status: 204, headers: cors });
  }

  return new Response('Method not allowed.', { status: 405, headers: cors });
}
