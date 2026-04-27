// arc-appkit.js — Wrapper around Circle's App Kit for browser-side swap.
//
// Usage (from trade.html):
//   import { initAppKit, appKitSwap, estimateAppKitSwap } from '/assets/arc-appkit.js';
//   await initAppKit();   // once on page load (after wallet connect)
//   const { estimatedOutput } = await estimateAppKitSwap('USDC', 'EURC', '1.00');
//   const result = await appKitSwap('USDC', 'EURC', '1.00');
//
// Requires: window.ARC_APPKIT_CONFIG (loaded from arc-appkit-config.js before this).

// Load App Kit + adapter via esm.sh ESM CDN. No build step required.
import { AppKit } from 'https://esm.sh/@circle-fin/app-kit@latest';
import { createEthersAdapterFromProvider } from 'https://esm.sh/@circle-fin/adapter-ethers-v6@latest';

let kit = null;
let adapter = null;

/**
 * Initialize App Kit with the user's browser wallet (window.ethereum).
 * Must be called AFTER user has connected their wallet.
 * Idempotent — safe to call multiple times.
 */
export async function initAppKit() {
  if (kit && adapter) return { kit, adapter };

  if (!window.ARC_APPKIT_CONFIG || !window.ARC_APPKIT_CONFIG.kitKey) {
    throw new Error('App Kit config missing — load /assets/arc-appkit-config.js before this module');
  }
  if (!window.ethereum) {
    throw new Error('No wallet provider found (window.ethereum). Connect MetaMask/Rabby first.');
  }

  adapter = await createEthersAdapterFromProvider({ provider: window.ethereum });
  kit = new AppKit();

  return { kit, adapter };
}

/**
 * Get a pre-swap estimate: how much tokenOut you'll receive for tokenIn.
 * @param {string} tokenIn  e.g. 'USDC'
 * @param {string} tokenOut e.g. 'EURC'
 * @param {string} amountIn human-readable decimal string e.g. '1.00'
 * @returns {Promise<{estimatedOutput: string}>}
 */
export async function estimateAppKitSwap(tokenIn, tokenOut, amountIn) {
  await initAppKit();
  return kit.estimateSwap({
    from: { adapter, chain: window.ARC_APPKIT_CONFIG.network },
    tokenIn,
    tokenOut,
    amountIn,
    config: { kitKey: window.ARC_APPKIT_CONFIG.kitKey }
  });
}

/**
 * Execute a token-to-token swap on the same chain.
 * Triggers wallet popup for user to sign the swap transaction.
 * @param {string} tokenIn  e.g. 'USDC'
 * @param {string} tokenOut e.g. 'EURC'
 * @param {string} amountIn human-readable decimal string e.g. '1.00'
 * @param {object} [options] - Optional config (slippage, recipient, etc.)
 * @returns {Promise<object>} swap result with txHash, amountOut, etc.
 */
export async function appKitSwap(tokenIn, tokenOut, amountIn, options = {}) {
  await initAppKit();
  return kit.swap({
    from: { adapter, chain: window.ARC_APPKIT_CONFIG.network },
    tokenIn,
    tokenOut,
    amountIn,
    ...options,
    config: { kitKey: window.ARC_APPKIT_CONFIG.kitKey, ...(options.config || {}) }
  });
}

/**
 * Quick health check — verifies the config is loaded and kit can init.
 * Useful for showing UI feedback like "App Kit connected" / "Configure key".
 */
export function isAppKitReady() {
  return Boolean(
    window.ARC_APPKIT_CONFIG &&
    window.ARC_APPKIT_CONFIG.kitKey &&
    !window.ARC_APPKIT_CONFIG.kitKey.includes('PASTE_YOUR_KEY')
  );
}

// Expose globally for debugging in console (NOT for production logic — use imports above)
if (typeof window !== 'undefined') {
  window.ARC_APPKIT = { initAppKit, estimateAppKitSwap, appKitSwap, isAppKitReady };
}
