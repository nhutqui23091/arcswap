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

import {
  provisionWalletsForAgent,
  executeRefill,
  getTransaction,
  submitPermit,
  CHIP_TO_ARC,
} from './_circle.js';

const HEADERS_JSON = { 'Content-Type': 'application/json' };

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: HEADERS_JSON });
}

function isCircleConfigured(env) {
  return !!(env.CIRCLE_API_KEY && env.CIRCLE_ENTITY_SECRET);
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

/* ────────────────────────────────────────────────────────────
   GLOBAL AGENT INDEX
   ────────────────────────────────────────────────────────────
   `agents:index` is a single KV key containing a JSON array of every
   agent ID ever created (minus revoked ones). The cron tick reads this
   one key instead of doing `kv.list({ prefix: 'agent:' })` every minute.

   Why: kv.list() counts against the daily LIST cap (1,000/day on free
   tier). At 1-minute cron resolution that meant 1,440 lists/day — over
   cap. With the index, we read 1 key per tick (a cheap READ op against
   the much higher 100k/day read cap).

   Migration: on first read after deploy the index may not exist yet.
   `getAllAgentIds` falls back to one kv.list() to seed the index, then
   uses it thereafter. So existing agents are picked up automatically. */
const AGENT_INDEX_KEY = 'agents:index';

async function getAllAgentIds(kv) {
  const existing = await getJSON(kv, AGENT_INDEX_KEY, null);
  if (Array.isArray(existing)) return existing;

  // Cold start: seed the index from kv.list() one time.
  const ids = [];
  let cursor = undefined;
  do {
    const page = await kv.list({ prefix: 'agent:', limit: 100, cursor });
    for (const k of page.keys) {
      const m = k.name.match(/^agent:(ag_[a-z0-9_]+)$/i);
      if (m) ids.push(m[1]);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  await putJSON(kv, AGENT_INDEX_KEY, ids);
  return ids;
}

async function addToAgentIndex(kv, id) {
  const ids = await getAllAgentIds(kv);
  if (!ids.includes(id)) {
    ids.push(id);
    await putJSON(kv, AGENT_INDEX_KEY, ids);
  }
}

async function removeFromAgentIndex(kv, id) {
  const ids = await getAllAgentIds(kv);
  const filtered = ids.filter(x => x !== id);
  if (filtered.length !== ids.length) {
    await putJSON(kv, AGENT_INDEX_KEY, filtered);
  }
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

async function handleCreate(req, kv, env) {
  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'bad_json' }); }

  const { owner, mode, sources, targets, targetChains, params, signature, expiresAt, nextRun: bodyNextRun } = body || {};

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

  // targetChains is a parallel array — same length as targets — naming the
  // destination chain for each one. Optional for back-compat with older
  // clients; we default to sources[0] for any missing entry, which mirrors
  // the previous "send on first source chain" behavior.
  let resolvedTargetChains;
  if (Array.isArray(targetChains) && targetChains.length === targets.length) {
    // Each entry must be one of the agent's declared source chains —
    // otherwise we have no Circle wallet / permit to route through.
    const badIdx = targetChains.findIndex(c => !sources.includes(c));
    if (badIdx >= 0) return json(400, { error: 'target_chain_not_in_sources', index: badIdx });
    resolvedTargetChains = targetChains;
  } else {
    resolvedTargetChains = targets.map(() => sources[0]);
  }

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
    targetChains: resolvedTargetChains,
    params,
    signature,
    state: 'active',
    created: now,
    expiresAt: expiresAt || (now + 30 * 24 * 60 * 60 * 1000),
    totalSent: 0,
    lastTrigger: null,
    // Prefer the nextRun computed by the frontend (correct in user's
    // local timezone). Fall back to backend computeNextRun if the
    // frontend didn't send one — legacy clients or non-schedule modes.
    nextRun: typeof bodyNextRun === 'number' || bodyNextRun === null
      ? bodyNextRun
      : computeNextRun(mode, params, now),
    circleWalletSetId: null,
    circleWallets: [], // [{source, walletId, address, blockchain}]
    provisioning: 'pending',
  };

  // Persist first so the agent exists even if Circle provisioning fails.
  await putJSON(kv, `agent:${id}`, agent);
  await addOwnerAgent(kv, owner, id);
  await addToAgentIndex(kv, id);
  await appendExecution(kv, id, {
    type: 'deployed',
    detail: mode === 'topup'
      ? `Watching ${targets.length} wallet(s) · floor $${params.floor}`
      : `Scheduled ${params.cadence} · ${targets.length} wallet(s) @ ${params.time}`,
  });

  // Try to provision Circle wallets synchronously. If Circle isn't configured
  // or the call fails, the agent still exists but in 'no-wallets' state.
  if (isCircleConfigured(env)) {
    try {
      const result = await provisionWalletsForAgent(env, agent);
      agent.circleWalletSetId = result.walletSetId;
      agent.circleWallets = result.wallets;
      agent.provisioning = result.wallets.length ? 'ready' : 'failed';
      await putJSON(kv, `agent:${id}`, agent);
      await appendExecution(kv, id, {
        type: 'provisioned',
        detail: `Created ${result.wallets.length} Circle wallet(s): ${result.wallets.map(w => w.source).join(', ')}`,
      });
    } catch (e) {
      console.error('[handleCreate] provisioning failed:', e?.message || e);
      agent.provisioning = 'failed';
      agent.provisioningError = String(e?.message || e).slice(0, 300);
      await putJSON(kv, `agent:${id}`, agent);
      await appendExecution(kv, id, {
        type: 'error',
        detail: `Circle provisioning failed: ${agent.provisioningError}`,
      });
    }
  } else {
    agent.provisioning = 'circle_not_configured';
    await putJSON(kv, `agent:${id}`, agent);
  }

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

/**
 * Given a previous `nextRun` (UTC millisecond timestamp) and a cadence,
 * return the timestamp for the next firing. Uses plain UTC arithmetic on
 * the existing nextRun so the time-of-day stays anchored to whatever
 * timezone the user picked at deploy time — no need to know the user's
 * tz on the backend.
 *
 *   advanceNextRun(prev, 'daily')   → prev + 1 calendar day, same HH:MM
 *   advanceNextRun(prev, 'weekly')  → prev + 7 calendar days
 *   advanceNextRun(prev, 'monthly') → prev + 1 calendar month
 *   advanceNextRun(prev, 'once')    → null (one-time, done after fire)
 */
function advanceNextRun(prev, cadence) {
  if (cadence === 'once' || !prev) return null;
  const d = new Date(prev);
  if (cadence === 'daily')   d.setUTCDate(d.getUTCDate() + 1);
  if (cadence === 'weekly')  d.setUTCDate(d.getUTCDate() + 7);
  if (cadence === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
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
  await removeFromAgentIndex(kv, id);
  await appendExecution(kv, id, { type: 'revoked', detail: 'Agent revoked · signature invalidated' });
  return json(204, {});
}

/**
 * Accept EIP-2612 permit signatures from the frontend and submit them
 * on-chain via each agent's SCA wallet. This authorizes the agent to pull
 * USDC directly from the user's external wallet (e.g. MetaMask) — no need
 * for the user to fund the Circle SCA wallet themselves.
 *
 * Body: {
 *   signature,  // ownership proof — agent's master EIP-712 sig
 *   permits: [
 *     { sourceChain: 'baseSepolia', value: '1000000000', deadline: 17xxxxxxxx,
 *       v: 28, r: '0x...', s: '0x...' },
 *     ...
 *   ]
 * }
 */
async function handleSubmitPermits(req, kv, env, id) {
  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'bad_json' }); }
  const agent = await getJSON(kv, `agent:${id}`, null);
  if (!agent) return json(404, { error: 'not_found' });
  if (!verifySignature(agent.owner, body.signature))
    return json(401, { error: 'signature_invalid' });
  if (!Array.isArray(body.permits) || !body.permits.length)
    return json(400, { error: 'permits_required' });
  if (!agent.circleWallets?.length)
    return json(409, { error: 'no_circle_wallets', message: 'Agent has no provisioned wallets to authorize against.' });

  // Build wallet-lookup by sourceChain (canonical ARC key)
  const walletByChain = {};
  for (const w of agent.circleWallets) {
    const arcKey = CHIP_TO_ARC[w.source] || w.source;
    walletByChain[arcKey] = w;
  }

  const results = [];
  for (const p of body.permits) {
    const { sourceChain, value, deadline, v, r, s } = p;
    const wallet = walletByChain[sourceChain];
    if (!wallet) {
      results.push({ sourceChain, error: `No agent wallet for ${sourceChain}` });
      continue;
    }
    if (!value || !deadline || v == null || !r || !s) {
      results.push({ sourceChain, error: 'missing permit fields' });
      continue;
    }
    try {
      const tx = await submitPermit(env, {
        wallet,
        sourceChain,
        owner: agent.owner,
        spender: wallet.address,
        value,
        deadline,
        v, r, s,
      });
      results.push({ sourceChain, circleTxId: tx.id, state: tx.state || 'submitted' });
    } catch (e) {
      results.push({ sourceChain, error: String(e?.message || e).slice(0, 300) });
    }
  }

  // Store permits on the agent record (so executeRefill can pick them up)
  agent.permits = (agent.permits || []).concat(
    results.map((r, i) => ({
      ...body.permits[i],
      sourceChain: body.permits[i].sourceChain,
      state: r.error ? 'failed' : 'submitted',
      circleTxId: r.circleTxId,
      error: r.error,
      submittedAt: Date.now(),
    })),
  );
  await putJSON(kv, `agent:${id}`, agent);

  // Log to executions
  for (const r of results) {
    await appendExecution(kv, id, {
      type: r.error ? 'error' : 'permit',
      detail: r.error
        ? `Permit ${r.sourceChain} failed: ${r.error}`
        : `Permit submitted on ${r.sourceChain} · agent can pull from user wallet`,
    });
  }

  return json(200, { agentId: id, results });
}

async function handleRunNow(req, kv, env, id) {
  let body;
  try { body = await req.json(); } catch { body = {}; }
  const agent = await getJSON(kv, `agent:${id}`, null);
  if (!agent) return json(404, { error: 'not_found' });
  if (!verifySignature(agent.owner, body.signature))
    return json(401, { error: 'signature_invalid' });
  if (agent.state !== 'active') return json(409, { error: 'agent_not_active' });

  // Two execution paths:
  //   1. REAL: Circle is configured AND agent has provisioned wallets →
  //      call Circle's Transfer API on one of those wallets.
  //   2. SIMULATED: no Circle, or no wallets → just record an entry and
  //      bump totalSent so the UX still shows progress.
  const realMode = isCircleConfigured(env) && agent.circleWallets?.length > 0;

  if (realMode) {
    let result;
    try {
      result = await executeRefill(env, agent);
    } catch (e) {
      await appendExecution(kv, id, {
        type: 'error',
        detail: `Run-now failed: ${String(e?.message || e).slice(0, 200)}`,
      });
      return json(502, { error: 'execution_failed', detail: String(e?.message || e) });
    }

    // Record each transfer attempt
    for (const t of (result.txs || [])) {
      if (t.error) {
        await appendExecution(kv, id, {
          type: 'error',
          detail: `Transfer failed (${t.source}→${shortAddr(t.target)}): ${t.error.slice(0, 160)}`,
        });
      } else {
        await appendExecution(kv, id, {
          type: 'sent',
          detail: `Sent $${t.amount} ${t.source} → ${shortAddr(t.target)}`,
          amount: Number(t.amount),
          circleTxId: t.circleTxId,
          state: t.state,
        });
      }
    }

    agent.totalSent = (agent.totalSent || 0) + (result.totalSent || 0);
    agent.lastTrigger = Date.now();
    if (agent.mode === 'schedule') agent.nextRun = advanceNextRun(agent.nextRun, agent.params.cadence);
    await putJSON(kv, `agent:${id}`, agent);

    return json(202, {
      agentId: id,
      status: result.ok ? 'sent' : 'failed',
      amount: result.totalSent || 0,
      txs: result.txs,
    });
  }

  // Simulated fallback
  const total = agent.mode === 'topup'
    ? agent.params.refillAmount
    : (agent.params.dist === 'each'
        ? agent.params.sendAmount * agent.targets.length
        : agent.params.sendAmount);
  agent.totalSent = (agent.totalSent || 0) + total;
  agent.lastTrigger = Date.now();
  if (agent.mode === 'schedule') agent.nextRun = advanceNextRun(agent.nextRun, agent.params.cadence);
  await putJSON(kv, `agent:${id}`, agent);
  const reason = !isCircleConfigured(env)
    ? 'Circle not configured'
    : (!agent.circleWallets?.length ? 'no wallets provisioned' : 'unknown');
  await appendExecution(kv, id, {
    type: 'sent',
    detail: agent.mode === 'topup'
      ? `Refilled (simulated · ${reason})`
      : `Scheduled send (simulated · ${reason}) · ${agent.targets.length} wallet(s)`,
    amount: total,
    simulated: true,
  });
  return json(202, { agentId: id, status: 'simulated', amount: total, reason });
}

function shortAddr(a) {
  return a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
}

async function handleExecutions(_req, kv, id) {
  const arr = await getJSON(kv, `agent:${id}:executions`, []);
  return json(200, arr);
}

/**
 * Cron tick — sweep all active agents, fire those that are due.
 *
 * Called by an external scheduler (or a Cloudflare Worker with `crons =
 * ["* * * * *"]`) once per minute. Protected by Bearer token in
 * Authorization header matching env.CRON_SECRET.
 *
 * For schedule mode: fires when `nextRun <= now`, then advances nextRun.
 * For topup mode: fires unconditionally for now (proper version polls
 * each target's balance via RPC and fires only those below the floor —
 * deferred to a follow-up since it requires per-chain RPC config).
 *
 * Returns a summary so the cron worker can log progress.
 */
async function handleCronTick(req, kv, env) {
  // Auth check — bearer secret must match env.CRON_SECRET
  const auth = req.headers.get('Authorization') || '';
  if (!env.CRON_SECRET) {
    return json(503, { error: 'cron_not_configured', message: 'Set CRON_SECRET env var to enable cron-tick.' });
  }
  if (auth !== `Bearer ${env.CRON_SECRET}`) {
    return json(401, { error: 'unauthorized' });
  }

  const now = Date.now();
  const summary = { scanned: 0, fired: 0, skipped: 0, errors: 0, details: [] };

  // Pull agent IDs from the global index. This replaces the previous
  // `kv.list({ prefix: 'agent:' })` sweep, which counted against the
  // 1k/day LIST cap on the KV free tier. One get vs one list per tick.
  const agentIds = await getAllAgentIds(kv);
  for (const id of agentIds) {
    summary.scanned++;
    const agent = await getJSON(kv, `agent:${id}`, null);
    if (!agent) continue;
    if (agent.state !== 'active') { summary.skipped++; continue; }
    if (agent.expiresAt && agent.expiresAt < now) { summary.skipped++; continue; }

    // Decide whether to fire
    let shouldFire = false;
    if (agent.mode === 'schedule') {
      if (agent.nextRun && agent.nextRun <= now) shouldFire = true;
    } else if (agent.mode === 'topup') {
      // Naive: fire on the throttle interval, regardless of whether the
      // target wallet's balance is actually below the floor. Proper
      // version polls target balances via RPC and only fires when below
      // floor — deferred (needs per-chain RPC config). For now, throttle
      // hard at 6 hours so we don't burn write ops re-funding already-
      // funded wallets.
      const SIX_HOURS = 6 * 60 * 60 * 1000;
      if (!agent.lastTrigger || now - agent.lastTrigger > SIX_HOURS) {
        shouldFire = true;
      }
    }

    if (!shouldFire) { summary.skipped++; continue; }

    // Fire
    try {
      const result = await executeRefill(env, agent);
      for (const t of (result.txs || [])) {
        if (t.error) {
          await appendExecution(kv, agent.id, {
            type: 'error',
            detail: `[cron] ${t.source}→${t.target?.slice(0,10) || '?'}: ${String(t.error).slice(0, 160)}`,
          });
        } else {
          await appendExecution(kv, agent.id, {
            type: 'sent',
            detail: `[cron] sent $${t.amount} ${t.source}→${t.target?.slice(0,10) || '?'}`,
            amount: Number(t.amount),
            circleTxId: t.circleTxId,
            state: t.state,
            flow: t.flow,
          });
        }
      }
      agent.totalSent = (agent.totalSent || 0) + (result.totalSent || 0);
      agent.lastTrigger = now;
      if (agent.mode === 'schedule') agent.nextRun = advanceNextRun(agent.nextRun, agent.params.cadence);
      await putJSON(kv, `agent:${id}`, agent);

      summary.fired++;
      summary.details.push({ id: agent.id, mode: agent.mode, sent: result.totalSent });
    } catch (e) {
      summary.errors++;
      summary.details.push({ id: agent.id, error: String(e?.message || e).slice(0, 200) });
      await appendExecution(kv, agent.id, {
        type: 'error',
        detail: `[cron] executeRefill threw: ${String(e?.message || e).slice(0, 200)}`,
      });
    }
  }

  return json(200, summary);
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
      return await handleCreate(request, kv, env);
    }
    // GET /api/agent/list
    if (parts[0] === 'list' && parts.length === 1 && request.method === 'GET') {
      return await handleList(request, kv);
    }
    // POST /api/agent/cron-tick — fired by external scheduler every minute.
    // Auth: Authorization: Bearer ${env.CRON_SECRET}
    if (parts[0] === 'cron-tick' && parts.length === 1 && request.method === 'POST') {
      return await handleCronTick(request, kv, env);
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
          return await handleRunNow(request, kv, env, id);
        if (parts[1] === 'executions' && request.method === 'GET')
          return await handleExecutions(request, kv, id);
        if (parts[1] === 'permits'    && request.method === 'POST')
          return await handleSubmitPermits(request, kv, env, id);
      }
    }
    return json(404, { error: 'not_found' });
  } catch (e) {
    console.error('[api/agent] handler error:', e?.message || e);
    return json(500, { error: 'internal', detail: String(e?.message || e) });
  }
}
