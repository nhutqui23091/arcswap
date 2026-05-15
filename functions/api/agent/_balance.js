/**
 * On-chain USDC balance reader — used by the cron tick to decide whether
 * a topup agent actually needs to fire. Without this check, the cron
 * refills wallets on a fixed throttle whether they need it or not, which
 * (a) burns Circle Gas Station credits and (b) burns Workers KV writes.
 *
 * Security:
 *   - Default RPC endpoints below are PUBLIC (no API key, no rate-limit
 *     authentication). It is safe to commit them. They are sufficient
 *     for preview-volume traffic.
 *   - To use private endpoints (Alchemy, Infura, QuickNode, etc.), set
 *     the corresponding env var (see ENV_KEY map below) as a Cloudflare
 *     Pages **secret**, NOT in any committed file. Code will pick them
 *     up at runtime and never see the public default for that chain.
 *
 * Failure mode:
 *   - Any error (network, RPC error, malformed response, timeout) is
 *     swallowed and `getUSDCBalance` returns `null`. Callers MUST treat
 *     `null` as "unknown balance — fire anyway" so a flaky RPC doesn't
 *     strand users with empty wallets. Better to over-refill once during
 *     an RPC blip than to miss a critical refill.
 */

import { USDC_ADDRESS } from './_circle.js';

// Public, keyless RPC endpoints for the testnet chains we operate on.
// Safe to commit. Override via env vars below for higher reliability.
const PUBLIC_RPC = {
  sepolia:         'https://ethereum-sepolia-rpc.publicnode.com',
  baseSepolia:     'https://sepolia.base.org',
  arbitrumSepolia: 'https://sepolia-rollup.arbitrum.io/rpc',
  optimismSepolia: 'https://sepolia.optimism.io',
  polygonAmoy:     'https://rpc-amoy.polygon.technology',
  avalancheFuji:   'https://api.avax-test.network/ext/bc/C/rpc',
  unichainSepolia: 'https://sepolia.unichain.org',
};

// Map ARC canonical chain key → env var that holds an optional override.
// To plug in a private RPC (e.g. Alchemy):
//   wrangler pages secret put RPC_BASE_SEPOLIA --project-name=arcswap
//   (paste the full URL incl. API key when prompted)
// Secrets live on Cloudflare, never in git.
const ENV_KEY = {
  sepolia:         'RPC_SEPOLIA',
  baseSepolia:     'RPC_BASE_SEPOLIA',
  arbitrumSepolia: 'RPC_ARB_SEPOLIA',
  optimismSepolia: 'RPC_OP_SEPOLIA',
  polygonAmoy:     'RPC_POLYGON_AMOY',
  avalancheFuji:   'RPC_AVAX_FUJI',
  unichainSepolia: 'RPC_UNI_SEPOLIA',
};

/**
 * Resolve the RPC URL for a chain. Prefers env override; falls back to
 * the public default. Returns null if the chain is unknown.
 */
function getRpcUrl(env, arcChainKey) {
  const envKey = ENV_KEY[arcChainKey];
  if (envKey && env[envKey]) return env[envKey];
  return PUBLIC_RPC[arcChainKey] || null;
}

/**
 * Read USDC balance for `walletAddress` on `arcChainKey`. Returns the
 * raw balance as a BigInt (USDC has 6 decimals — divide by 1e6 to get
 * dollars). Returns `null` on ANY error so callers can fall through to
 * a safe default (typically: fire anyway).
 *
 *   const raw = await getUSDCBalance(env, 'baseSepolia', '0xabc…');
 *   if (raw === null)         → unknown, fire to be safe
 *   if (Number(raw)/1e6 < 50) → below floor, fire
 *   else                      → above floor, skip
 */
export async function getUSDCBalance(env, arcChainKey, walletAddress) {
  const rpcUrl = getRpcUrl(env, arcChainKey);
  const usdc   = USDC_ADDRESS[arcChainKey];
  if (!rpcUrl || !usdc || !walletAddress) return null;

  // ERC-20 balanceOf(address) ABI:
  //   selector: keccak256("balanceOf(address)")[0:4] = 0x70a08231
  //   arg: 32-byte left-padded address
  const addr = walletAddress.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const data = '0x70a08231' + addr;

  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: usdc, data }, 'latest'],
      }),
      // 3s timeout — public RPCs can be slow. If they don't respond
      // quickly, fall back to "fire anyway" rather than blocking the
      // entire cron tick.
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json?.error) return null;
    const hex = json?.result;
    if (!hex || hex === '0x') return 0n;
    return BigInt(hex);
  } catch {
    return null;
  }
}

/**
 * Helper: convert raw BigInt USDC units to a human dollar number.
 * 1,500,000n → 1.5
 * Safe up to ~$9 billion (Number.MAX_SAFE_INTEGER / 1e6).
 */
export function usdcRawToHuman(raw) {
  if (raw == null) return null;
  return Number(raw) / 1e6;
}
