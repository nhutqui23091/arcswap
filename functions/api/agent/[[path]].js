/**
 * ArcSwap Agent API — Cloudflare Pages Function.
 *
 * Stores Auto-Replenish / Scheduled Send agent rules signed by users.
 * Backed by Cloudflare KV (binding: AGENT_KV).
 *
 * Routes:
 *   POST   /api/agent/create            → register new agent
 *   GET    /api/agent/list?owner=0x...  → list agents for owner
 *   GET    /api/agent/:id               → fetch one agent
 *   POST   /api/agent/:id/pause         → pause execution
 *   POST   /api/agent/:id/resume        → resume execution
 *   DELETE /api/agent/:id               → revoke (signature invalidated)
 *   POST   /api/agent/:id/run-now       → trigger immediate execution
 *   GET    /api/agent/:id/executions    → recent execution log
 *
 * Storage layout (KV keys):
 *   agent:<id>                → JSON agent record
 *   agent:<id>:executions     → JSON array, capped at 100 most recent
 *   owner:<addr-lower>:agents → JSON array of agent IDs for that owner
 *
 * Auth model (preview):
 *   - Mutations require `signature` field in body.
 *   - The signature is the EIP-712 message that authorizes the agent (or any
 *     subsequent action signed by the owner). For preview we just check that
 *     a signature is present and the owner address matches. Recovering the
 *     address from the EIP-712 sig is a TODO — will use ethers.verifyTypedData
 *     once we standardize the typed-data schema.
 *
 * Required env:
 *   AGENT_KV  (KV namespace binding — set up in Cloudflare Pages dashboard)
 *
 * Not configured yet? Endpoints return 503 with a hint message; the frontend
 * falls back to localStorage transparently. See SETUP-AGENT.md.
 */

const HEADERS_JSON = { 'Content-Type': 'application/json' };

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: HEADERS_JSON });
}

function notReady() {
  return json(503, {
    error: 'agent_storage_unconfigured',
    message:
      'AGENT_KV binding not set. See SETUP-AGENT.md for one-time setup. ' +
      'Frontend should fall back to local storage.',
  });
}

function isValidAddr(s) {
  return typeof s === 'string' && /^0x[a-fA-F0-9]{40}$/.test(s);
}

function lower(a) { return String(a || '').toLowerCase(); }

function genId() {
  // Compact random id — non-cryptographic but unique enough for agents.
  return 'ag_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

async function getJSON(kv, key, fallback) {
  const raw = await kv.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

async function putJSON(kv, key, val) {
  await kv.put(key, JSON.stringify(val));
}

async function listOwnerAgentIds(kv, owner) {
  return await getJSON(kv, `owner:${lower(owner)}:agents`, []);
}

async function addOwnerAgent(kv, owner, id) {
  const ids = await listOwnerAgentIds(kv, owner);
  if (!ids.includes(id)) ids.push(id);
  await putJSON(kv, `owner:${lower(owner)}:agents`, ids);
}

async function removeOwnerAgent(kv, owner, id) {
  const ids = await listOwnerAgentIds(kv, owner);
  await putJSON(kv, `owner:${lower(owner)}:agents`, ids.filter(x => x !== id));
}

async function appendExecution(kv, agentId, event) {
  const key = `agent:${agentId}:executions`;
  const arr = await getJSON(kv, key, []);
  arr.unshift({ ...event, time: Date.now() });
  // Cap at 100 most recent
  if (arr.length > 100) arr.length = 100;
  await putJSON(kv, key, arr);
}

/**
 * Verify the signature accompanying a mutation. For preview we accept any
 * non-empty hex string. Production should run ethers.verifyTypedData against
 * the EIP-712 domain + the agent's params and confirm the recovered address
 * matches the owner.
 */
function verifySignature(_owner, sig) {
  if (typeof sig !== 'string') return false;
  if (!/^0x[0-9a-fA-F]+$/.test(sig)) return false;
  if (sig.length < 10) return false;
  return true; // TODO: replace with ethers.verifyTypedData once typed-data schema is locked
}

/* ────────────────────────────────────────────────────────────
   HANDLERS
   ──────────────────────────────────────────────────────────── */

async function handleCreate(req, kv) {
  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'bad_json' }); }

  const { owner, mode, sources, targets, params, signature, expiresAt } = body || {};

  if (!isValidAddr(owner))          return json(400, { error: 'owner_required' });
  if (mode !== 'topup' && mode !== 'schedule')
                                    return json(400, { error: 'invalid_mode' });
  if (!Array.isArray(sources) || !sources.length)
                                    return json(400, { error: 'sources_required' });
  if (!Array.isArray(targets) || !targets.length || !targets.every(isValidAddr))
                                    return json(400, { error: 'targets_invalid' });
  if (!params || typeof params !== 'object')
                                    return json(400, { error: 'params_required' });
  if (!verifySignature(owner, signature))
                                    return json(400, { error: 'signature_invalid' });

  // Validate mode-specific params
  if (mode === 'topup') {
    const { floor, refillAmount, dailyCap } = params;
    if (!(floor > 0) || !(refillAmount > 0) || !(dailyCap >= refillAmount))
      return json(400, { error: 'topup_params_invalid' });
  } else {
    const { sendAmount, cadence, time, dist } = params;
    if (!(sendAmount > 0))                       return json(400, { error: 'sendAmount_invalid' });
    if (!['once','daily','weekly','monthly'].includes(cadence))
                                                 return json(400, { error: 'cadence_invalid' });
    if (typeof time !== 'string' || !/^\d{2}:\d{2}$/.test(time))
                                                 return json(400, { error: 'time_invalid' });
    if (dist && !['each','split'].includes(dist))
                                                 return json(400, { error: 'dist_invalid' });
  }

  const id = genId();
  const now = Date.now();
  const agent = {
    id,
    owner: lower(owner),
    mode,
    sources,
    targets: targets.map(lower),
    params,
    signature,
    state: 'active',
    created: now,
    expiresAt: expiresAt || (now + 30 * 24 * 60 * 60 * 1000),
    totalSent: 0,
    lastTrigger: null,
    nextRun: computeNextRun(mode, params, now),
  };

  await putJSON(kv, `agent:${id}`, agent);
  await addOwnerAgent(kv, owner, id);
  await appendExecution(kv, id, {
    type: 'deployed',
    detail: mode === 'topup'
      ? `Watching ${targets.length} wallet(s) · floor $${params.floor}`
      : `Scheduled ${params.cadence} · ${targets.length} wallet(s) @ ${params.time}`,
  });

  return json(201, agent);
}

function computeNextRun(mode, params, fromTs) {
  if (mode === 'topup') return null; // threshold-based, no fixed time
  if (mode !== 'schedule') return null;
  const { cadence, time, startDate } = params;
  const [hh, mm] = (time || '00:00').split(':').map(Number);
  // Use the user's startDate if provided, else today.
  const base = startDate ? new Date(startDate + 'T00:00:00') : new Date(fromTs);
  base.setHours(hh, mm, 0, 0);
  if (base.getTime() <= fromTs) {
    // Move to next slot
    if (cadence === 'once')    return base.getTime() < fromTs ? null : base.getTime();
    if (cadence === 'daily')   base.setDate(base.getDate() + 1);
    if (cadence === 'weekly')  base.setDate(base.getDate() + 7);
    if (cadence === 'monthly') base.setMonth(base.getMonth() + 1);
  }
  return base.getTime();
}

async function handleList(req, kv) {
  const url = new URL(req.url);
  const owner = url.searchParams.get('owner');
  if (!isValidAddr(owner)) return json(400, { error: 'owner_required' });
  const ids = await listOwnerAgentIds(kv, owner);
  const agents = (await Promise.all(ids.map(id => getJSON(kv, `agent:${id}`, null))))
    .filter(Boolean);
  return json(200, agents);
}

async function handleGet(_req, kv, id) {
  const agent = await getJSON(kv, `agent:${id}`, null);
  if (!agent) return json(404, { error: 'not_found' });
  return json(200, agent);
}

async function handlePauseResume(req, kv, id, newState) {
  let body;
  try { body = await req.json(); } catch { body = {}; }
  const agent = await getJSON(kv, `agent:${id}`, null);
  if (!agent) return json(404, { error: 'not_found' });
  if (!verifySignature(agent.owner, body.signature))
    return json(401, { error: 'signature_invalid' });

  agent.state = newState;
  await putJSON(kv, `agent:${id}`, agent);
  await appendExecution(kv, id, { type: newState, detail: `Agent ${newState}` });
  return json(200, agent);
}

async function handleRevoke(req, kv, id) {
  let body;
  try { body = await req.json(); } catch { body = {}; }
  const agent = await getJSON(kv, `agent:${id}`, null);
  if (!agent) return json(404, { error: 'not_found' });
  if (!verifySignature(agent.owner, body.signature))
    return json(401, { error: 'signature_invalid' });

  // Soft delete: mark revoked, remove from owner index, keep agent record for
  // audit. Could also do a hard delete here if storage limits matter.
  agent.state = 'revoked';
  agent.revokedAt = Date.now();
  await putJSON(kv, `agent:${id}`, agent);
  await removeOwnerAgent(kv, agent.owner, id);
  await appendExecution(kv, id, { type: 'revoked', detail: 'Agent revoked · signature invalidated' });
  return json(204, {});
}

async function handleRunNow(req, kv, id) {
  let body;
  try { body = await req.json(); } catch { body = {}; }
  const agent = await getJSON(kv, `agent:${id}`, null);
  if (!agent) return json(404, { error: 'not_found' });
  if (!verifySignature(agent.owner, body.signature))
    return json(401, { error: 'signature_invalid' });
  if (agent.state !== 'active') return json(409, { error: 'agent_not_active' });

  // TODO(circle): replace simulation below with real execution via Circle
  // Programmable Wallet API + Gateway. See functions/api/agent/_circle.js.
  const total = agent.mode === 'topup'
    ? agent.params.refillAmount
    : (agent.params.dist === 'each'
        ? agent.params.sendAmount * agent.targets.length
        : agent.params.sendAmount);
  agent.totalSent += total;
  agent.lastTrigger = Date.now();
  if (agent.mode === 'schedule') agent.nextRun = computeNextRun('schedule', agent.params, Date.now());
  await putJSON(kv, `agent:${id}`, agent);
  await appendExecution(kv, id, {
    type: 'sent',
    detail: agent.mode === 'topup'
      ? `Refilled (simulated) — wire Circle PW to execute`
      : `Scheduled send (simulated) · ${agent.targets.length} wallet(s)`,
    amount: total,
    simulated: true,
  });
  return json(202, { agentId: id, status: 'simulated', amount: total });
}

async function handleExecutions(_req, kv, id) {
  const arr = await getJSON(kv, `agent:${id}:executions`, []);
  return json(200, arr);
}

/* ────────────────────────────────────────────────────────────
   ROUTER
   ──────────────────────────────────────────────────────────── */

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // CORS preflight (same pattern as circle-proxy)
  const origin = request.headers.get('Origin') || '';
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // KV binding required for storage
  const kv = env.AGENT_KV;
  if (!kv) return notReady();

  // Routing — extract /api/agent/<rest>
  const m = url.pathname.match(/^\/api\/agent\/?(.*)$/);
  if (!m) return json(404, { error: 'not_found' });
  const rest = (m[1] || '').replace(/\/+$/, '');
  const parts = rest ? rest.split('/') : [];

  try {
    // POST /api/agent/create
    if (parts[0] === 'create' && parts.length === 1 && request.method === 'POST') {
      return await handleCreate(request, kv);
    }
    // GET /api/agent/list
    if (parts[0] === 'list' && parts.length === 1 && request.method === 'GET') {
      return await handleList(request, kv);
    }
    // /api/agent/:id and subroutes
    if (parts.length >= 1 && parts[0] !== 'create' && parts[0] !== 'list') {
      const id = parts[0];
      if (!/^ag_[a-z0-9_]+$/i.test(id)) return json(400, { error: 'invalid_id' });
      if (parts.length === 1) {
        if (request.method === 'GET')    return await handleGet(request, kv, id);
        if (request.method === 'DELETE') return await handleRevoke(request, kv, id);
      }
      if (parts.length === 2) {
        if (parts[1] === 'pause'      && request.method === 'POST')
          return await handlePauseResume(request, kv, id, 'paused');
        if (parts[1] === 'resume'     && request.method === 'POST')
          return await handlePauseResume(request, kv, id, 'active');
        if (parts[1] === 'run-now'    && request.method === 'POST')
          return await handleRunNow(request, kv, id);
        if (parts[1] === 'executions' && request.method === 'GET')
          return await handleExecutions(request, kv, id);
      }
    }
    return json(404, { error: 'not_found' });
  } catch (e) {
    console.error('[api/agent] handler error:', e?.message || e);
    return json(500, { error: 'internal', detail: String(e?.message || e) });
  }
}
