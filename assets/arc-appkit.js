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

// ── Server-side proxy reroute ───────────────────────────────────────────────
// Browser-side kit key is risky (visible in view-source, attacker can use from
// curl/Postman to drain rate limit). Solution: route ALL Circle API calls
// through our Cloudflare Pages Function at /api/circle-proxy/*, which adds the
// real KIT_KEY server-side from an encrypted env var. Browser never sees key.
//
// Bonus: this also fixes the x-user-agent CORS issue automatically — proxy is
// same-origin so no CORS preflight needed at all.
const CIRCLE_API_HOST = 'https://api.circle.com';
const PROXY_PREFIX = '/api/circle-proxy';

let _fetchPatched = false;
function patchFetchForCircle() {
  if (_fetchPatched) return;
  _fetchPatched = true;
  const origFetch = window.fetch.bind(window);
  window.fetch = function patchedFetch(input, init) {
    try {
      let url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.startsWith(CIRCLE_API_HOST)) {
        // Reroute Circle API calls through our same-origin proxy.
        const proxiedUrl = url.replace(CIRCLE_API_HOST, PROXY_PREFIX);
        // Strip Authorization — proxy adds the real KIT_KEY server-side.
        if (init && init.headers) {
          if (init.headers instanceof Headers) {
            init.headers.delete('Authorization');
            init.headers.delete('authorization');
            init.headers.delete('x-user-agent');
            init.headers.delete('X-User-Agent');
          } else if (typeof init.headers === 'object') {
            delete init.headers.Authorization;
            delete init.headers.authorization;
            delete init.headers['x-user-agent'];
            delete init.headers['X-User-Agent'];
          }
        }
        console.debug('[arc-appkit] → proxy:', { from: url, to: proxiedUrl, method: init?.method });
        // If input was a Request object, rebuild with new URL
        if (typeof input === 'string') {
          return origFetch(proxiedUrl, init);
        } else if (input && input.url) {
          return origFetch(new Request(proxiedUrl, input), init);
        }
      }
    } catch (e) {
      console.warn('[arc-appkit] fetch patch error:', e?.message);
    }
    return origFetch(input, init);
  };
  console.info('[arc-appkit] fetch() patched: api.circle.com → /api/circle-proxy (server-side KIT_KEY)');
}

let _sdkPromise = null;
async function loadSdk() {
  if (_sdkPromise) return _sdkPromise;
  _sdkPromise = (async () => {
    try {
      patchFetchForCircle();   // Apply CORS workaround before SDK initializes
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
  const params = {
    from: { adapter, chain: window.ARC_APPKIT_CONFIG.network },
    tokenIn,
    tokenOut,
    amountIn,
    config: { kitKey: window.ARC_APPKIT_CONFIG.kitKey }
  };
  console.log('[arc-appkit] estimateSwap params:', { ...params, config: { kitKey: '***' } });
  let res;
  try {
    res = await kit.estimateSwap(params);
  } catch (err) {
    console.error('[arc-appkit] estimateSwap THREW:', err);
    throw err;
  }
  // Diagnostic: log multiple ways so something is always visible (object refs need expanding in console)
  console.log('[arc-appkit] estimateSwap raw response (object):', res);
  console.log('[arc-appkit] estimateSwap raw response (typeof):', typeof res, '· isNull:', res === null);
  try {
    console.log('[arc-appkit] estimateSwap raw response (JSON):', JSON.stringify(res));
    console.log('[arc-appkit] estimateSwap raw response (keys):', res && typeof res === 'object' ? Object.keys(res) : '(not object)');
  } catch (e) {
    console.log('[arc-appkit] estimateSwap stringify failed:', e?.message);
  }
  return res;
}

// Helper: normalize a value that might be a string, number, or {amount, token}
// object (Circle's "Money" shape) into a plain decimal string.
function _toAmountStr(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return /^[0-9]/.test(v) ? v : null;
  if (typeof v === 'object' && v.amount !== undefined && v.amount !== null) {
    return _toAmountStr(v.amount);  // unwrap {amount, token}
  }
  return null;
}

// Helper: extract amount-out from the various possible response shapes
export function extractEstimatedOutput(estResponse) {
  if (!estResponse || typeof estResponse !== 'object') return '0';
  const candidates = [
    estResponse.estimatedOutput,            // Circle App Kit shape: {amount, token}
    estResponse.amountOut,
    estResponse.output,
    estResponse.estimate?.output,
    estResponse.estimate?.estimatedOutput,
    estResponse.data?.estimatedOutput,
    estResponse.data?.amountOut,
    estResponse.result?.estimatedOutput,
    estResponse.result?.amountOut,
    estResponse.tokenOut?.amount,
    estResponse.to?.amount,
    estResponse.quote?.estimatedOutput,
    estResponse.quote?.amountOut,
  ];
  for (const v of candidates) {
    const s = _toAmountStr(v);
    if (s !== null) return s;
  }
  console.warn('[arc-appkit] Could not find output field in response:', Object.keys(estResponse));
  return '0';
}

// Helper: extract minimum-output (stop-limit / slippage floor) from response
export function extractStopLimit(estResponse) {
  if (!estResponse || typeof estResponse !== 'object') return null;
  return _toAmountStr(estResponse.stopLimit) || _toAmountStr(estResponse.minOutput) || null;
}

// Helper: extract fee breakdown ([{token, amount, type}, ...]) → human-readable summary
export function extractFees(estResponse) {
  if (!estResponse || !Array.isArray(estResponse.fees)) return [];
  return estResponse.fees.map(f => ({
    type: f.type || 'fee',
    amount: _toAmountStr(f.amount) || '0',
    token: f.token || '',
  }));
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
  if (!window.ARC_APPKIT_CONFIG) return false;
  // New flow: proxy is the source of truth. Real KIT_KEY lives in Cloudflare
  // env (server-side) and is injected by /api/circle-proxy at request time.
  // The client just needs `proxyHealthy: true` (set by build-config.sh when
  // KIT_KEY env var is present in Cloudflare).
  if (window.ARC_APPKIT_CONFIG.proxyHealthy === true) return true;
  // Backward-compat: legacy local-dev configs may still have a real kitKey.
  // Accept these too, but the proxy is preferred.
  const k = window.ARC_APPKIT_CONFIG.kitKey;
  return Boolean(
    k && !k.includes('PASTE_YOUR_KEY') && !k.includes('PROXIED_VIA_')
  );
}

// Expose globally for debugging in console (NOT for production logic — use imports above)
if (typeof window !== 'undefined') {
  window.ARC_APPKIT = { initAppKit, estimateAppKitSwap, appKitSwap, isAppKitReady };
}
