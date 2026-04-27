// arc-appkit.js — Wrapper around Circle's App Kit for browser-side swap.
//
// Usage (from trade.html):
//   const m = await import('/assets/arc-appkit.js');
//   if (m.isAppKitReady()) await m.initAppKit();
//   const { estimatedOutput } = await m.estimateAppKitSwap('USDC', 'EURC', '1.00');
//   const result = await m.appKitSwap('USDC', 'EURC', '1.00');
//
// Requires: window.ARC_APPKIT_CONFIG (loaded from arc-appkit-config.js before this).

// Lazy-load App Kit + adapter from CDN to avoid module-init failures crashing
// the page. Pin to specific versions to avoid silent breakage on `@latest`.
// Note: app-kit and adapter packages have INDEPENDENT versioning — don't share!
const APPKIT_VERSION = '1.4.1';
const ADAPTER_VERSION = '1.6.5';
const APPKIT_URL = `https://esm.sh/@circle-fin/app-kit@${APPKIT_VERSION}`;
const ADAPTER_URL = `https://esm.sh/@circle-fin/adapter-ethers-v6@${ADAPTER_VERSION}`;

let _sdkPromise = null;
async function loadSdk() {
  if (_sdkPromise) return _sdkPromise;
  _sdkPromise = (async () => {
    try {
      const [appKitMod, adapterMod] = await Promise.all([
        import(APPKIT_URL),
        import(ADAPTER_URL),
      ]);
      const AppKit = appKitMod.AppKit || appKitMod.default;
      const createEthersAdapterFromProvider =
        adapterMod.createEthersAdapterFromProvider || adapterMod.default;
      if (!AppKit) throw new Error('AppKit class not found in @circle-fin/app-kit export');
      if (!createEthersAdapterFromProvider) throw new Error('createEthersAdapterFromProvider not found');
      console.info('[arc-appkit] SDK loaded:', { appKit: APPKIT_VERSION, adapter: ADAPTER_VERSION });
      return { AppKit, createEthersAdapterFromProvider };
    } catch (e) {
      console.error('[arc-appkit] SDK load failed:', e);
      _sdkPromise = null;  // allow retry
      throw e;
    }
  })();
  return _sdkPromise;
}

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

  // Lazy-load SDK (with detailed error if CDN fails)
  const { AppKit, createEthersAdapterFromProvider } = await loadSdk();

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
