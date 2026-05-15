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
export const CIRCLE_BLOCKCHAIN = {
  sepolia:         'ETH-SEPOLIA',
  baseSepolia:     'BASE-SEPOLIA',
  arbitrumSepolia: 'ARB-SEPOLIA',
  optimismSepolia: 'OP-SEPOLIA',
  polygonAmoy:     'MATIC-AMOY',
  avalancheFuji:   'AVAX-FUJI',
  unichainSepolia: 'UNI-SEPOLIA',
  // Arc Testnet — Circle's own L1. Not yet documented as a PW-supported
  // blockchain identifier. Filter out when provisioning. We can still RECEIVE
  // USDC on Arc as a target, just don't create agent wallets there.
};

// Native testnet USDC contract addresses (Circle published). Source:
// https://developers.circle.com/stablecoins/usdc-on-test-networks
export const USDC_ADDRESS = {
  sepolia:         '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  baseSepolia:     '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  arbitrumSepolia: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
  optimismSepolia: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
  polygonAmoy:     '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
  avalancheFuji:   '0x5425890298aed601595a70AB815c96711a31Bc65',
  unichainSepolia: '0x31d0220469e10c4E71834a79b1f276d740d3768F',
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
 *   - 'EOA' (default) — externally owned account, cheapest
 *   - 'SCA' — smart contract account, supports gas sponsorship + batch
 *
 * We start with EOA for simplicity. Can switch to SCA later for gas sponsorship.
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
      accountType: opts.accountType || 'EOA',
    },
  });
  // Response shape: { data: { wallets: [{id, address, blockchain, ...}] } }
  return res?.data?.wallets?.[0] || null;
}

/**
 * Provision Circle wallets for every selected source chain on an agent.
 * Returns array of { source, walletId, address, blockchain } — one per chain
 * that Circle supports. Chains we can't provision (e.g. Arc) are skipped.
 */
export async function provisionWalletsForAgent(env, agent) {
  // Create the wallet set first (one per agent for isolation)
  const setName = `arcswap-${agent.id}`;
  const ws = await createWalletSet(env, setName);
  if (!ws?.id) throw new Error('createWalletSet returned no id');
  const walletSetId = ws.id;

  const wallets = [];
  for (const source of agent.sources) {
    const arcKey = CHIP_TO_ARC[source];
    const blockchain = CIRCLE_BLOCKCHAIN[arcKey];
    if (!blockchain) {
      console.log(`[circle] skipping unsupported source chain: ${source}`);
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
      }
    } catch (e) {
      console.error(`[circle] createAgentWallet failed for ${source}/${blockchain}:`, e.message);
      // Don't throw — provision what we can, skip what we can't.
    }
  }

  return { walletSetId, wallets };
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
 * Strategy (MVP simplification):
 *  - Pick the FIRST circle wallet attached to the agent.
 *  - For top-up mode: transfer `refillAmount` to first target.
 *  - For schedule mode: for each target, transfer `sendAmount` (if dist=each)
 *    or `sendAmount / N` (if dist=split).
 *
 * NOTE: This is "first working slice". Real version should:
 *  - Pick the source wallet with sufficient balance, lowest gas
 *  - For top-up: only refill targets actually below the floor (poll balance first)
 *  - For multi-chain destinations: use CCTP V2 burn → mint instead of direct transfer
 *
 * @returns { ok, txs: [{ source, target, amount, circleTxId, error? }] }
 */
export async function executeRefill(env, agent) {
  if (!agent.circleWallets?.length) {
    return { ok: false, error: 'No Circle wallets provisioned for this agent', txs: [] };
  }
  const wallet = agent.circleWallets[0]; // simplistic — just use first
  const p = agent.params || {};

  const txs = [];

  // wallet.source is chip-id ('base'). Map to ARC canonical key
  // ('baseSepolia') so USDC_ADDRESS lookup works.
  const arcKey = CHIP_TO_ARC[wallet.source] || wallet.source;

  if (agent.mode === 'topup') {
    // Refill the FIRST target wallet (proper version: check each target's
    // balance and refill only those below floor)
    const target = agent.targets[0];
    const amount = String(p.refillAmount || 0);
    try {
      const tx = await transferUSDC(env, {
        walletId: wallet.walletId,
        sourceChain: arcKey,
        blockchain: wallet.blockchain,
        destinationAddress: target,
        amount,
      });
      txs.push({ source: wallet.source, target, amount, circleTxId: tx.id, state: tx.state });
    } catch (e) {
      txs.push({ source: wallet.source, target, amount, error: e.message });
    }
  } else {
    // schedule mode: send to each target
    const perTarget = p.dist === 'split'
      ? Number(p.sendAmount || 0) / agent.targets.length
      : Number(p.sendAmount || 0);

    for (const target of agent.targets) {
      try {
        const tx = await transferUSDC(env, {
          walletId: wallet.walletId,
          sourceChain: arcKey,
          blockchain: wallet.blockchain,
          destinationAddress: target,
          amount: perTarget.toFixed(6),
        });
        txs.push({
          source: wallet.source,
          target,
          amount: perTarget.toFixed(6),
          circleTxId: tx.id,
          state: tx.state,
        });
      } catch (e) {
        txs.push({ source: wallet.source, target, error: e.message });
      }
    }
  }

  const total = txs
    .filter(t => !t.error)
    .reduce((s, t) => s + Number(t.amount), 0);
  return { ok: txs.some(t => !t.error), totalSent: total, txs };
}
