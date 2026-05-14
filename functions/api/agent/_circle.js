/**
 * Circle Programmable Wallet integration — STUB.
 *
 * This module will wrap Circle's Developer-Controlled Wallets API to
 * provision per-user agent wallets and execute USDC transfers on their
 * behalf. None of these functions are wired into the live execution path
 * yet — they're scaffolding so the API surface is settled before we
 * point real users at it.
 *
 * Required env (set in Cloudflare Pages → Settings → Environment variables):
 *   CIRCLE_API_KEY        — Circle Developer Console → API Keys (TESTNET first)
 *   CIRCLE_ENTITY_SECRET  — 32-byte hex, generated via Circle SDK once;
 *                           used to authenticate wallet operations.
 *
 * Docs:
 *   https://developers.circle.com/w3s/docs/developer-controlled-create-your-first-wallet
 *   https://developers.circle.com/w3s/docs/entity-secret-management
 *
 * Implementation roadmap:
 *   [ ] createWalletSet(env, name)
 *         → POST /v1/w3s/developer/walletSets
 *         → returns walletSetId we associate with one agent / one user
 *
 *   [ ] createAgentWallet(env, walletSetId, blockchain)
 *         → POST /v1/w3s/developer/wallets
 *         → returns walletId + address; create one per source chain
 *
 *   [ ] getWalletBalance(env, walletId)
 *         → GET /v1/w3s/wallets/:id/balances
 *
 *   [ ] transferUSDC(env, walletId, toAddress, amount, blockchain)
 *         → POST /v1/w3s/developer/transactions/transfer
 *         → standard USDC transfer; we'll wrap CCTP V2 burn for cross-chain
 *
 *   [ ] burnViaCCTP(env, walletId, amount, destDomain, destAddress)
 *         → custom contract call to TokenMessengerV2.depositForBurn()
 *         → returns txHash; pair with attestation polling for mint side
 *
 *   [ ] mintViaCCTP(env, walletId, message, attestation)
 *         → custom contract call to MessageTransmitterV2.receiveMessage()
 *         → completes the cross-chain leg
 *
 *   [ ] pullFromUserWallet(env, userAddr, amount, srcChain, eip3009Sig)
 *         → submit user's EIP-3009 transferWithAuthorization signature
 *         → moves USDC from user EOA → agent wallet on source chain
 *
 * Today's stub: every function logs intent and returns a fake response shape
 * so the rest of the pipeline (API → KV → executions) compiles end-to-end.
 */

const CIRCLE_BASE = 'https://api.circle.com';

function requireEnv(env) {
  if (!env.CIRCLE_API_KEY) {
    throw new Error('CIRCLE_API_KEY missing — set in Cloudflare Pages env vars.');
  }
  if (!env.CIRCLE_ENTITY_SECRET) {
    throw new Error('CIRCLE_ENTITY_SECRET missing — see SETUP-AGENT.md.');
  }
}

/**
 * Generic Circle API call. Adds the API key header, JSON serialization,
 * and idempotency key handling.
 *
 * @param {object} env
 * @param {string} path - relative path under api.circle.com (must start with /)
 * @param {object} opts - { method, body, idempotencyKey, query }
 */
export async function circleFetch(env, path, opts = {}) {
  requireEnv(env);
  const url = new URL(CIRCLE_BASE + path);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }

  const headers = {
    'Authorization': `Bearer ${env.CIRCLE_API_KEY}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  // TODO(security): The entity secret should be sent as a one-time-use
  // ciphertext per request, not a raw secret. Circle's API expects
  // `entitySecretCiphertext` encrypted with their public key. Implement
  // proper entity-secret-ciphertext generation here.

  const init = {
    method: opts.method || 'GET',
    headers,
  };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }

  const r = await fetch(url, init);
  const text = await r.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!r.ok) {
    const err = new Error(`Circle API ${r.status}: ${json?.message || text}`);
    err.status = r.status;
    err.body = json;
    throw err;
  }
  return json;
}

/* ────────────────────────────────────────────────────────────
   WALLET LIFECYCLE  (all stubs — uncomment when ready)
   ──────────────────────────────────────────────────────────── */

export async function createWalletSet(env, name) {
  console.log('[circle:stub] createWalletSet', { name });
  // return await circleFetch(env, '/v1/w3s/developer/walletSets', {
  //   method: 'POST',
  //   body: { name, idempotencyKey: crypto.randomUUID(),
  //           entitySecretCiphertext: await entityCiphertext(env) },
  // });
  return { id: 'ws_stub_' + Math.random().toString(36).slice(2, 8), name, _stub: true };
}

export async function createAgentWallet(env, walletSetId, blockchain) {
  console.log('[circle:stub] createAgentWallet', { walletSetId, blockchain });
  // return await circleFetch(env, '/v1/w3s/developer/wallets', {
  //   method: 'POST',
  //   body: { walletSetId, blockchains: [blockchain], count: 1,
  //           idempotencyKey: crypto.randomUUID(),
  //           entitySecretCiphertext: await entityCiphertext(env) },
  // });
  return {
    id: 'wal_stub_' + Math.random().toString(36).slice(2, 8),
    address: '0x' + '0'.repeat(40),
    blockchain,
    _stub: true,
  };
}

/* ────────────────────────────────────────────────────────────
   TRANSFER & EXECUTION  (all stubs)
   ──────────────────────────────────────────────────────────── */

export async function getWalletBalance(env, walletId) {
  console.log('[circle:stub] getWalletBalance', { walletId });
  return { balances: [], _stub: true };
}

/**
 * Pull USDC from the user's external wallet → agent wallet via EIP-3009.
 * The signature was captured at agent-creation time; here we submit it
 * to the source chain's USDC contract.
 */
export async function pullFromUserWallet(env, params) {
  console.log('[circle:stub] pullFromUserWallet', params);
  // TODO: build raw tx calling USDC.transferWithAuthorization(...) and have
  // the agent wallet send it (since the user's signature pre-authorizes).
  return { txHash: '0x' + 'a'.repeat(64), simulated: true, _stub: true };
}

export async function burnViaCCTP(env, params) {
  console.log('[circle:stub] burnViaCCTP', params);
  // TODO: TokenMessengerV2.depositForBurn(amount, destDomain, recipient32, USDC)
  return { txHash: '0x' + 'b'.repeat(64), simulated: true, _stub: true };
}

export async function mintViaCCTP(env, params) {
  console.log('[circle:stub] mintViaCCTP', params);
  // TODO: poll attestation from iris-api-sandbox.circle.com, then call
  // MessageTransmitterV2.receiveMessage(message, attestation) on dest.
  return { txHash: '0x' + 'c'.repeat(64), simulated: true, _stub: true };
}

/**
 * High-level helper used by the cron trigger / run-now endpoint.
 * Executes one full leg: pull → burn → wait → mint → done.
 *
 * @returns { ok: boolean, steps: [...], txHashes: [...], error?: string }
 */
export async function executeRefill(env, agent, _amount, _targetAddr) {
  // For now everything returns simulated results. Wire actual calls when
  // CIRCLE_API_KEY + entity secret are in place AND we've tested on a single
  // chain manually first.
  console.log('[circle:stub] executeRefill agent=' + agent.id);
  return {
    ok: true,
    simulated: true,
    steps: ['pull (stub)', 'burn (stub)', 'attest (stub)', 'mint (stub)'],
    txHashes: { pull: null, burn: null, mint: null },
  };
}
