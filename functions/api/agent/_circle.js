/**
 * Circle Programmable Wallet integration — LIVE.
 *
 * Implements the Developer-Controlled Wallets API needed for the ArcSwap
 * agent backend:
 *   - Generate per-request `entitySecretCiphertext` via Web Crypto (RSA-OAEP-SHA256)
 *   - Create wallet sets + wallets on supported testnet chains
 *   - Transfer USDC from agent wallet to a target address
 *
 * Required env:
 *   CIRCLE_API_KEY        — Bearer token from Circle Console
 *   CIRCLE_ENTITY_SECRET  — 64-hex secret registered with Circle (raw, not ciphertext)
 *
 * NOTE: All functions throw on Circle API error. Callers in [[path]].js wrap
 * them in try/catch and degrade gracefully (agent still persists in KV even
 * if wallet provisioning fails — user can retry).
 */

const CIRCLE_BASE = 'https://api.circle.com';

// Map our internal chain key (matches ARC.CHAINS) → Circle blockchain identifier.
// Circle uses ALL-CAPS hyphenated names. Mainnet would be 'ETH' / 'BASE' etc.
// We're on testnet across the board.
//
// Source: https://developers.circle.com/w3s/supported-blockchains-and-currencies
// Verified May 2026 — ARC-TESTNET is now a first-class PW-supported chain.
export const CIRCLE_BLOCKCHAIN = {
  sepolia:         'ETH-SEPOLIA',
  baseSepolia:     'BASE-SEPOLIA',
  arbitrumSepolia: 'ARB-SEPOLIA',
  optimismSepolia: 'OP-SEPOLIA',
  polygonAmoy:     'MATIC-AMOY',
  avalancheFuji:   'AVAX-FUJI',
  unichainSepolia: 'UNI-SEPOLIA',
  arc:             'ARC-TESTNET',  // Circle's own L1 — USDC is native gas
};

// Native testnet USDC contract addresses (Circle published). Source:
// https://developers.circle.com/stablecoins/usdc-on-test-networks
//
// Arc is special: USDC is the NATIVE gas token (not a regular ERC-20). The
// contract lives at a system address `0x3600...0000` and exposes the
// standard ERC-20 interface (balanceOf returns 6-decimal units). Native
// USDC gas internally uses 18 decimals; the ERC-20 interface still
// presents 6 decimals so our existing balance / transfer code works
// without changes.
export const USDC_ADDRESS = {
  sepolia:         '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  baseSepolia:     '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  arbitrumSepolia: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
  optimismSepolia: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
  polygonAmoy:     '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
  avalancheFuji:   '0x5425890298aed601595a70AB815c96711a31Bc65',
  unichainSepolia: '0x31d0220469e10c4E71834a79b1f276d740d3768F',
  arc:             '0x3600000000000000000000000000000000000000', // native USDC system contract
};

// Map chip-id (frontend) → ARC chain key (canonical). Same mapping as
// agent.html — duplicated here so the backend doesn't need a shared module.
export const CHIP_TO_ARC = {
  base:     'baseSepolia',
  arc:      'arc',
  sepolia:  'sepolia',
  arbitrum: 'arbitrumSepolia',
  optimism: 'optimismSepolia',
  polygon:  'polygonAmoy',
  unichain: 'unichainSepolia',
  fuji:     'avalancheFuji',
};

/* ────────────────────────────────────────────────────────────
   ENV + CIPHERTEXT
   ──────────────────────────────────────────────────────────── */

function requireEnv(env) {
  if (!env.CIRCLE_API_KEY) {
    throw new Error('CIRCLE_API_KEY missing — set in Cloudflare Pages env vars.');
  }
  if (!env.CIRCLE_ENTITY_SECRET) {
    throw new Error('CIRCLE_ENTITY_SECRET missing — see SETUP-AGENT.md.');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(env.CIRCLE_ENTITY_SECRET)) {
    throw new Error('CIRCLE_ENTITY_SECRET must be 64 hex characters (32 bytes).');
  }
}

// Cache the public key + parsed CryptoKey per Worker isolate. Public key is
// stable across requests; refetching every time is wasteful.
let _publicKeyCache = null;          // { pem, key }
let _publicKeyFetchPromise = null;   // dedupe concurrent fetches

async function getCryptoKey(env) {
  if (_publicKeyCache) return _publicKeyCache.key;
  if (_publicKeyFetchPromise) return _publicKeyFetchPromise;

  _publicKeyFetchPromise = (async () => {
    const r = await fetch(`${CIRCLE_BASE}/v1/w3s/config/entity/publicKey`, {
      headers: {
        Authorization: `Bearer ${env.CIRCLE_API_KEY}`,
        Accept: 'application/json',
      },
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`Circle publicKey fetch failed: HTTP ${r.status} ${txt.slice(0, 200)}`);
    }
    const body = await r.json();
    const pem = body?.data?.publicKey;
    if (!pem) throw new Error('Circle publicKey response missing data.publicKey');

    // Strip PEM headers + whitespace, decode base64 to DER bytes.
    const der = pemToDer(pem);

    // Import as RSA-OAEP-SHA256 public key for encryption.
    const key = await crypto.subtle.importKey(
      'spki',
      der,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['encrypt'],
    );

    _publicKeyCache = { pem, key };
    return key;
  })().finally(() => { _publicKeyFetchPromise = null; });

  return _publicKeyFetchPromise;
}

function pemToDer(pem) {
  // Accepts both "-----BEGIN PUBLIC KEY-----" (SPKI) and unwrapped base64.
  const cleaned = String(pem)
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(cleaned);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.substr(i, 2), 16);
  return out;
}

function bytesToBase64(bytes) {
  let bin = '';
  const u8 = new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
}

/**
 * Generate a fresh entitySecretCiphertext for a Circle API call.
 * Circle requires this for every mutation (createWallet, transfer, etc.) —
 * it's the entity secret re-encrypted with their public key. They reject
 * stale ciphertexts so we can't cache the encrypted form.
 */
export async function entityCiphertext(env) {
  requireEnv(env);
  const key = await getCryptoKey(env);
  const secretBytes = hexToBytes(env.CIRCLE_ENTITY_SECRET);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    key,
    secretBytes,
  );
  return bytesToBase64(encrypted);
}

/* ────────────────────────────────────────────────────────────
   GENERIC CIRCLE FETCH
   ──────────────────────────────────────────────────────────── */

export async function circleFetch(env, path, opts = {}) {
  requireEnv(env);
  const url = new URL(CIRCLE_BASE + path);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }

  const init = {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${env.CIRCLE_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }

  const r = await fetch(url, init);
  const text = await r.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!r.ok) {
    // Circle's error responses have two flavors:
    //   { code: N, message: "API parameter invalid", errors: [{message, location, constraint, error}, …] }
    //   { code: N, message: "human-readable" }
    // The `errors` array has the real details — surface them.
    let msg = json?.message || json?.error?.message || text;
    if (Array.isArray(json?.errors) && json.errors.length) {
      const details = json.errors.map(e => {
        const loc = e.location ? `[${e.location}]` : '';
        const txt = e.message || e.error || JSON.stringify(e);
        return `${loc} ${txt}`.trim();
      }).join(' · ');
      msg = `${msg} :: ${details}`;
    }
    const err = new Error(`Circle ${path} → HTTP ${r.status}: ${String(msg).slice(0, 500)}`);
    err.status = r.status;
    err.body = json;
    throw err;
  }
  return json;
}

/* ────────────────────────────────────────────────────────────
   WALLET SET + WALLETS
   ──────────────────────────────────────────────────────────── */

/**
 * Create a new wallet set. We use one wallet set per agent — gives clean
 * isolation and a single namespace for that agent's per-chain wallets.
 */
export async function createWalletSet(env, name) {
  const entitySecretCiphertext = await entityCiphertext(env);
  const res = await circleFetch(env, '/v1/w3s/developer/walletSets', {
    method: 'POST',
    body: {
      idempotencyKey: crypto.randomUUID(),
      name,
      entitySecretCiphertext,
    },
  });
  // Response shape: { data: { walletSet: { id, ... } } }
  return res?.data?.walletSet || res;
}

/**
 * Create a wallet on the given blockchain inside an existing wallet set.
 * Returns: { id, address, blockchain, ... }
 *
 * `accountType`:
 *   - 'SCA' (default) — smart contract account. Required for Circle's Gas
 *     Station (auto gas sponsorship on testnet, paid on mainnet). User only
 *     needs to fund the wallet with the token they want to spend (USDC),
 *     not native gas.
 *   - 'EOA' — externally owned account. Cheaper to create but requires the
 *     user to also fund the wallet with native gas (ETH on Base, AVAX on
 *     Fuji, etc) which is friction-heavy and confusing.
 *
 * SCA is the right default for an agent product where the user only thinks
 * in USDC and never wants to think about gas.
 */
export async function createAgentWallet(env, walletSetId, blockchain, opts = {}) {
  const entitySecretCiphertext = await entityCiphertext(env);
  const res = await circleFetch(env, '/v1/w3s/developer/wallets', {
    method: 'POST',
    body: {
      idempotencyKey: opts.idempotencyKey || crypto.randomUUID(),
      entitySecretCiphertext,
      walletSetId,
      blockchains: [blockchain],
      count: 1,
      accountType: opts.accountType || 'SCA',
    },
  });
  // Response shape: { data: { wallets: [{id, address, blockchain, ...}] } }
  return res?.data?.wallets?.[0] || null;
}

/**
 * Provision Circle wallets for every selected source chain on an agent.
 *
 * Returns:
 *   {
 *     walletSetId,
 *     wallets: [{ source, walletId, address, blockchain }, ...] — successes,
 *     failedChains: [{ source, blockchain, error }, ...]        — per-chain
 *       failures that the caller should persist on the agent record so the
 *       UI can show "FAILED — retry" instead of pretending the chain is OK.
 *   }
 *
 * Why this matters: previously a per-chain failure was caught & swallowed,
 * leaving `wallets` short by one. Schedule send then fell back to a
 * different chain's wallet via pickWalletForTarget, silently moving USDC
 * on the wrong chain. Tracking failures lets us (a) error loudly at fire
 * time and (b) offer a retry path. See the bug fix in executeRefill below
 * for the loud-error half of this pair.
 */
export async function provisionWalletsForAgent(env, agent, options = {}) {
  const sources = options.sources || agent.sources;

  // For initial provisioning we create a wallet set; for retries
  // (reprovision) we reuse the existing one — caller passes it via options.
  let walletSetId = options.walletSetId || agent.circleWalletSetId;
  if (!walletSetId) {
    const setName = `arcswap-${agent.id}`;
    const ws = await createWalletSet(env, setName);
    if (!ws?.id) throw new Error('createWalletSet returned no id');
    walletSetId = ws.id;
  }

  const wallets = [];
  const failedChains = [];
  for (const source of sources) {
    const arcKey = CHIP_TO_ARC[source];
    const blockchain = CIRCLE_BLOCKCHAIN[arcKey];
    if (!blockchain) {
      console.log(`[circle] skipping unsupported source chain: ${source}`);
      failedChains.push({ source, blockchain: null, error: 'chain not supported by Circle' });
      continue;
    }
    try {
      const w = await createAgentWallet(env, walletSetId, blockchain);
      if (w) {
        wallets.push({
          source,
          walletId: w.id,
          address: w.address,
          blockchain,
        });
      } else {
        failedChains.push({ source, blockchain, error: 'Circle returned no wallet' });
      }
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 300);
      console.error(`[circle] createAgentWallet failed for ${source}/${blockchain}:`, msg);
      failedChains.push({ source, blockchain, error: msg });
      // Don't throw — provision what we can, surface failures via failedChains.
    }
  }

  return { walletSetId, wallets, failedChains };
}

/* ────────────────────────────────────────────────────────────
   GENERIC CONTRACT EXECUTION  (used for permit / transferFrom)
   ──────────────────────────────────────────────────────────── */

/**
 * Execute an arbitrary contract function via a Circle SCA wallet.
 * Gas is sponsored by Circle Gas Station on testnet.
 *
 * @param env
 * @param params {
 *   walletId,            // SCA wallet that will be msg.sender
 *   contractAddress,     // contract to call (e.g. USDC)
 *   abiFunctionSignature,// "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)"
 *   abiParameters,       // array of values matching the signature
 *   feeLevel,            // 'LOW' | 'MEDIUM' | 'HIGH'
 * }
 */
export async function contractExecution(env, params) {
  const entitySecretCiphertext = await entityCiphertext(env);
  const res = await circleFetch(env, '/v1/w3s/developer/transactions/contractExecution', {
    method: 'POST',
    body: {
      idempotencyKey: crypto.randomUUID(),
      entitySecretCiphertext,
      walletId: params.walletId,
      contractAddress: params.contractAddress.toLowerCase(),
      abiFunctionSignature: params.abiFunctionSignature,
      abiParameters: params.abiParameters,
      feeLevel: params.feeLevel || 'MEDIUM',
    },
  });
  return res?.data || res;
}

/**
 * Submit a USDC EIP-2612 permit() on-chain via the agent's SCA wallet.
 * Sets `allowance[owner][spender] = value` on the USDC contract.
 *
 * The (v, r, s) signature was generated by the user signing EIP-2612 typed
 * data offchain. Anyone can submit it; we use the agent's SCA wallet so
 * Paymaster covers the gas.
 */
export async function submitPermit(env, params) {
  const { wallet, sourceChain, owner, spender, value, deadline, v, r, s } = params;
  const usdcAddress = USDC_ADDRESS[sourceChain];
  if (!usdcAddress) throw new Error(`No USDC address for ${sourceChain}`);
  return await contractExecution(env, {
    walletId: wallet.walletId,
    contractAddress: usdcAddress,
    abiFunctionSignature: 'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
    abiParameters: [
      owner.toLowerCase(),
      spender.toLowerCase(),
      String(value),
      String(deadline),
      Number(v),
      r,
      s,
    ],
  });
}

/**
 * Pull USDC from the user's wallet (which previously approved this agent
 * via EIP-2612 permit) to a target address.
 *
 * Calls USDC.transferFrom(user, target, amount) from the agent's SCA wallet.
 * Requires that `allowance[user][agentSCA] >= amount` — guaranteed by a
 * prior submitPermit() in the deploy flow.
 */
export async function transferFromUser(env, params) {
  const { wallet, sourceChain, owner, target, amount } = params;
  const usdcAddress = USDC_ADDRESS[sourceChain];
  if (!usdcAddress) throw new Error(`No USDC address for ${sourceChain}`);

  // USDC has 6 decimals. Convert "1.50" → "1500000".
  const rawAmount = toUsdcUnits(amount);

  return await contractExecution(env, {
    walletId: wallet.walletId,
    contractAddress: usdcAddress,
    abiFunctionSignature: 'transferFrom(address,address,uint256)',
    abiParameters: [
      owner.toLowerCase(),
      target.toLowerCase(),
      rawAmount,
    ],
  });
}

/** Convert human USDC string ("1.5") to raw 6-decimal units ("1500000"). */
export function toUsdcUnits(human) {
  const s = String(human);
  const [whole, frac = ''] = s.split('.');
  const fracPad = (frac + '000000').slice(0, 6);
  // Build as BigInt to avoid float precision
  const big = BigInt(whole) * 1000000n + BigInt(fracPad);
  return big.toString();
}

/* ────────────────────────────────────────────────────────────
   TRANSFERS
   ──────────────────────────────────────────────────────────── */

/**
 * Transfer USDC from an agent's Circle wallet to an arbitrary destination.
 *
 * @param env
 * @param params {
 *   walletId,            // Circle wallet id (source)
 *   blockchain,          // Circle's blockchain id, e.g. 'BASE-SEPOLIA' — REQUIRED when sending tokenAddress
 *   sourceChain,         // our canonical ARC key 'baseSepolia' — used to pick USDC_ADDRESS
 *   destinationAddress,
 *   amount,              // human-readable USDC, e.g. "0.01"
 * }
 *
 * Returns Circle transaction record. The actual tx hash lands on
 * res.txHash a few seconds later (Circle batches). The frontend should
 * poll GET /transactions/:id if it needs the hash.
 */
export async function transferUSDC(env, params) {
  const { walletId, sourceChain, blockchain, destinationAddress, amount } = params;
  const tokenAddress = USDC_ADDRESS[sourceChain];
  if (!tokenAddress) {
    throw new Error(`No USDC address mapped for source chain "${sourceChain}"`);
  }
  if (!walletId)            throw new Error('walletId required');
  if (!blockchain)          throw new Error('blockchain required (e.g. BASE-SEPOLIA)');
  if (!destinationAddress)  throw new Error('destinationAddress required');
  if (!amount)              throw new Error('amount required');

  const entitySecretCiphertext = await entityCiphertext(env);
  // Circle requires EITHER tokenId OR (blockchain + tokenAddress). We use the
  // latter so we don't have to maintain a separate Circle-tokenId mapping.
  // Addresses must be lowercase — EIP-55 checksummed casing was failing 400.
  const res = await circleFetch(env, '/v1/w3s/developer/transactions/transfer', {
    method: 'POST',
    body: {
      idempotencyKey: crypto.randomUUID(),
      entitySecretCiphertext,
      walletId,
      blockchain,
      tokenAddress: tokenAddress.toLowerCase(),
      destinationAddress: destinationAddress.toLowerCase(),
      amounts: [String(amount)],
      feeLevel: 'MEDIUM',
    },
  });
  // Response: { data: { id, state, ... } } where state starts as INITIATED.
  return res?.data || res;
}

/**
 * Fetch a transaction by Circle id — useful to poll for the on-chain tx hash
 * after a transfer is initiated.
 */
export async function getTransaction(env, txId) {
  const res = await circleFetch(env, `/v1/w3s/transactions/${txId}`);
  return res?.data?.transaction || res?.data || res;
}

/**
 * Look up balances of a Circle wallet (returns all tokens including USDC).
 */
export async function getWalletBalance(env, walletId) {
  const res = await circleFetch(env, `/v1/w3s/wallets/${walletId}/balances`);
  return res?.data?.tokenBalances || [];
}

/* ────────────────────────────────────────────────────────────
   HIGH-LEVEL: executeRefill
   ──────────────────────────────────────────────────────────── */

/**
 * Execute one refill / scheduled-send tick for an agent.
 *
 * Three flows:
 *
 *   A. SAME-CHAIN (legacy, default)
 *      Target chain is one of the user's authorized sources. We transferFrom
 *      user wallet → target on that same chain. Single tx, instant.
 *
 *   B. CROSS-CHAIN via CCTP V2 (new)
 *      Target chain ≠ any source chain. We pull USDC from one of the user's
 *      source chains (via permit transferFrom into the agent SCA), then burn
 *      it via TokenMessengerV2.depositForBurn with mintRecipient = user
 *      target. IRIS attests the burn, and a later cron tick claims via
 *      MessageTransmitterV2.receiveMessage on the dest chain. Saves a
 *      `pendingCctp` entry on the agent for the cron to advance.
 *
 *   C. SIMULATED
 *      Caller fallback when Circle isn't configured. Handled in
 *      [[path]].js handleRunNow, not here.
 *
 * @returns {
 *   ok, totalSent,
 *   txs:        [{ source, target, amount, circleTxId, error?, flow }],
 *   pendingCctp:[{ ...cctp state objects to append to agent.pendingCctp }]
 * }
 */
export async function executeRefill(env, agent) {
  if (!agent.circleWallets?.length) {
    return { ok: false, error: 'No Circle wallets provisioned for this agent', txs: [] };
  }
  const p = agent.params || {};
  const txs = [];
  const pendingCctp = []; // CCTP transfers initiated this tick (caller persists on agent)

  // Lazy-import CCTP module — only loaded when a cross-chain transfer is
  // detected, to keep the same-chain hot path cheap.
  let cctpMod = null;
  async function cctp() {
    if (cctpMod) return cctpMod;
    cctpMod = await import('./_cctp.js');
    return cctpMod;
  }

  // Build a map: chip-id ('base') → wallet, so we can pick a wallet by the
  // target's chain.
  const walletByChip = {};
  for (const w of agent.circleWallets) {
    if (!walletByChip[w.source]) walletByChip[w.source] = w;
  }
  const fallbackWallet = agent.circleWallets[0];

  /**
   * Resolve which Circle wallet should handle a target at index `i`.
   *
   * If the user explicitly chose a destination chain via `targetChains[i]`,
   * we MUST honor that. Returning a wallet on a different chain silently
   * moves USDC to the wrong chain — same EVM address resolves on every
   * chain so the transfer "succeeds" but lands somewhere the user doesn't
   * expect. Real bug observed in prod: agent with sources [base, arc,
   * sepolia] and target on Arc → Arc wallet provisioning failed silently
   * → fallbackWallet was the Sepolia wallet → $10 USDC landed on Sepolia
   * instead of Arc.
   *
   * Returns `null` for "no wallet for this explicit chain" so the caller
   * can surface a clear error instead of routing the wrong way. We keep
   * the fallback ONLY for legacy agents that pre-date `targetChains` —
   * those genuinely had no per-target chain choice, so picking wallets[0]
   * matches their original deploy-time behavior.
   */
  function pickWalletForTarget(i) {
    const chip = (agent.targetChains || [])[i];
    if (!chip) return fallbackWallet;        // legacy agents, no chain field
    return walletByChip[chip] || null;       // explicit chain — must match
  }

  /** Find a source wallet with submitted permit, for cross-chain transfers.
   *  We pull USDC from the user via permit on THIS source chain, then burn
   *  it via CCTP to the dest chain. Returns null if no usable source. */
  function pickCrossChainSourceWallet() {
    for (const w of agent.circleWallets) {
      const arcKey = CHIP_TO_ARC[w.source] || w.source;
      const hasPermit = (agent.permits || []).some(
        pm => pm.sourceChain === arcKey && pm.state === 'submitted',
      );
      if (hasPermit) return w;
    }
    return null;
  }

  /** Same-chain transfer: USDC moves on a single chain via permit transferFrom
   *  (preferred) or direct SCA wallet transfer (legacy / pre-fund pattern). */
  async function moveFunds(wallet, target, amount) {
    const arcKey = CHIP_TO_ARC[wallet.source] || wallet.source;
    const hasPermit = !!(agent.permits || []).find(
      pm => pm.sourceChain === arcKey && pm.state === 'submitted',
    );
    if (hasPermit) {
      const tx = await transferFromUser(env, {
        wallet,
        sourceChain: arcKey,
        owner: agent.owner,
        target,
        amount,
      });
      return { tx, flow: 'permit', source: wallet.source };
    }
    const tx = await transferUSDC(env, {
      walletId: wallet.walletId,
      sourceChain: arcKey,
      blockchain: wallet.blockchain,
      destinationAddress: target,
      amount,
    });
    return { tx, flow: 'wallet', source: wallet.source };
  }

  /**
   * Cross-chain transfer via CCTP V2:
   *   1. transferFrom(user → srcSCA, amount) — pulls user USDC into agent SCA
   *      on source chain. Requires submitted permit on source chain.
   *   2. depositForBurn(amount, destDomain, mintRecipient=userTarget) — burns
   *      srcSCA's USDC, emits CCTP message.
   *   3. (async, cron-driven) IRIS attestation + receiveMessage on dest →
   *      mints native USDC at userTarget.
   *
   * Returns the same shape as moveFunds + a `pending` field with the CCTP
   * state object the caller persists on agent.pendingCctp.
   */
  async function moveFundsCrossChain(srcWallet, destWallet, destChip, target, amount) {
    const srcArcKey = CHIP_TO_ARC[srcWallet.source] || srcWallet.source;
    const destArcKey = CHIP_TO_ARC[destChip] || destChip;
    const C = await cctp();
    if (!C.chainSupportsCctp(srcArcKey) || !C.chainSupportsCctp(destArcKey)) {
      throw new Error(`CCTP not supported on ${srcArcKey} → ${destArcKey}`);
    }

    // We do NOT submit any Circle ops here. The cron-driven state machine
    // handles the whole flow:
    //   permit_pending → pull_pending → burn_pending → burn_confirmed
    //   → attested → mint_pending → done
    //
    // permit_pending is the initial state — it waits for the EIP-2612
    // permit submission on this source chain to finalize on-chain before
    // attempting the pull. Without this delay, pull's pre-flight simulates
    // with allowance=0 (permit not yet mined) and Circle rejects with
    // INSUFFICIENT_TOKEN. Skipping the wait was the bug behind two earlier
    // failed test runs.
    const permit = (agent.permits || []).find(
      pm => pm.sourceChain === srcArcKey && pm.state === 'submitted',
    );
    const pending = await C.initiateCrossChainTransfer(env, {
      srcWallet,
      destWallet,
      srcChainKey: srcArcKey,
      destChainKey: destArcKey,
      amountHuman: String(amount),
      recipient: target,
      permitCircleTxId: permit?.circleTxId || null,
      pullOwner: agent.owner,
      fastMode: true,
    });
    pending.target = target;

    return {
      // No on-chain tx submitted yet — return placeholder. The first real
      // Circle tx (pull) fires from the cron tick once permit COMPLETEs.
      tx: { id: null, state: pending.state },
      flow: 'cctp',
      source: srcWallet.source,
      pending,
    };
  }

  // Same routing for both modes: pickWalletForTarget returns null when the
  // user picked a target chain whose Circle wallet failed to provision. In
  // that case we surface a clear, recoverable error per-tx — NEVER silently
  // route to a different chain (see pickWalletForTarget for the why).
  function noWalletError(chip) {
    return `No Circle wallet for chain "${chip}" — provisioning may have ` +
           `failed. Retry via POST /api/agent/${agent.id}/reprovision or ` +
           `recreate the agent without this chain.`;
  }

  /** Decide whether target i is cross-chain (target chain ∉ agent.sources). */
  function isCrossChainTarget(i) {
    const chip = (agent.targetChains || [])[i];
    if (!chip) return false;
    return !(agent.sources || []).includes(chip);
  }

  /** Execute one logical transfer (same-chain or CCTP cross-chain) and
   *  push result to `txs` + optional pendingCctp entry. */
  async function doOneTransfer(i, target, amount) {
    const chip = (agent.targetChains || [])[i];
    if (isCrossChainTarget(i)) {
      const destWallet = walletByChip[chip];
      if (!destWallet) {
        txs.push({ source: chip || '?', target, amount, error: `Cross-chain target "${chip}" needs a dest wallet — ${noWalletError(chip)}` });
        return;
      }
      const srcWallet = pickCrossChainSourceWallet();
      if (!srcWallet) {
        txs.push({ source: '?', target, amount, error: 'Cross-chain: no source wallet with permit available' });
        return;
      }
      try {
        const { tx, flow, source, pending } = await moveFundsCrossChain(srcWallet, destWallet, chip, target, amount);
        txs.push({ source, target, amount, circleTxId: tx.id, state: tx.state, flow });
        if (pending) pendingCctp.push(pending);
      } catch (e) {
        txs.push({ source: srcWallet.source, target, amount, error: e.message });
      }
      return;
    }

    // Same-chain path (existing behavior)
    const wallet = pickWalletForTarget(i);
    if (!wallet) {
      txs.push({ source: chip || '?', target, amount, error: noWalletError(chip) });
      return;
    }
    try {
      const { tx, flow, source } = await moveFunds(wallet, target, amount);
      txs.push({ source, target, amount, circleTxId: tx.id, state: tx.state, flow });
    } catch (e) {
      txs.push({ source: wallet.source, target, amount, error: e.message });
    }
  }

  if (agent.mode === 'topup') {
    const target = agent.targets[0];
    const amount = String(p.refillAmount || 0);
    await doOneTransfer(0, target, amount);
  } else {
    // schedule mode: one transfer per target, on its chosen destination chain
    const perTarget = p.dist === 'split'
      ? Number(p.sendAmount || 0) / agent.targets.length
      : Number(p.sendAmount || 0);

    for (let i = 0; i < agent.targets.length; i++) {
      await doOneTransfer(i, agent.targets[i], perTarget.toFixed(6));
    }
  }

  // For cross-chain transfers we don't count the amount toward totalSent
  // yet — the burn has fired but the dest mint won't confirm for ~30+s.
  // Cron will bump totalSent when the pendingCctp entry reaches `done`.
  const total = txs
    .filter(t => !t.error && t.flow !== 'cctp')
    .reduce((s, t) => s + Number(t.amount), 0);
  return {
    ok: txs.some(t => !t.error),
    totalSent: total,
    txs,
    pendingCctp,  // caller (handleRunNow / handleCronTick) persists onto agent
  };
}
