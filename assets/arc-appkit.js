// arc-appkit.js - Wrapper around Circle's App Kit for browser-side swap.
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
// Note: app-kit and adapter packages have INDEPENDENT versioning - don't share!
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
// Bonus: this also fixes the x-user-agent CORS issue automatically - proxy is
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
        // Strip Authorization - proxy adds the real KIT_KEY server-side.
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
 * Idempotent - safe to call multiple times.
 */
export async function initAppKit() {
  if (kit && adapter) return { kit, adapter };

  if (!window.ARC_APPKIT_CONFIG || !window.ARC_APPKIT_CONFIG.kitKey) {
    throw new Error('App Kit config missing - load /assets/arc-appkit-config.js before this module');
  }
  // Prefer the provider from Reown AppKit (the wallet the user actually
  // connected to). window.ethereum may be a different extension entirely
  // when multiple wallets are installed (e.g. MetaMask + OKX).
  const provider = window.ethereum; // diagnostic: bypass Reown wrapper, use native injected provider
  if (!provider) {
    throw new Error('No wallet provider found. Please connect a wallet first.');
  }

  // Lazy-load SDK (with detailed error if CDN fails)
  const { AppKit, createEthersAdapterFromProvider } = await loadSdk();

  adapter = await createEthersAdapterFromProvider({ provider });
  kit = new AppKit();

  return { kit, adapter };
}

/**
 * Pre-warm the App Kit SDK CDN bundle. Safe to call before the wallet is
 * connected - only triggers the dynamic import (esm.sh download + parse),
 * which is the dominant fixed cost (~500-1500ms cold) for the first quote.
 * Idempotent: subsequent calls hit the cached `_sdkPromise`.
 * Errors are swallowed - this is a best-effort optimization, never a blocker.
 */
export async function prefetchSdk() {
  try { await loadSdk(); } catch { /* best-effort */ }
}

/**
 * Get a pre-swap estimate: how much tokenOut you'll receive for tokenIn.
 * @param {string} tokenIn  e.g. 'USDC'
 * @param {string} tokenOut e.g. 'EURC'
 * @param {string} amountIn human-readable decimal string e.g. '1.00'
 * @param {{ tokenInAddress?: string, tokenOutAddress?: string, chain?: string }} [opts]
 * @returns {Promise<object>}
 */
// Pick the scale divisor for Circle's quote `estimatedAmount` so the resulting
// rate (out/in) lands inside the plausible stablecoin-FX band. Handles raw
// (human), 6-decimal and 18-decimal responses without hard-coding which one
// Circle returns. Returns the divisor, or null if no scale gives a sane rate.
function _pickQuoteScale(rawAmount, inFloat) {
  const v = parseFloat(rawAmount);
  if (!isFinite(v) || v <= 0 || !isFinite(inFloat) || inFloat <= 0) return null;
  const SCALES = [1, 1e6, 1e18];
  const LO = 0.5, HI = 2.0; // USDC<->EURC sits at ~0.92 / ~1.08
  let best = null;
  for (const s of SCALES) {
    const rate = (v / s) / inFloat;
    if (rate >= LO && rate <= HI) {
      const dist = Math.abs(Math.log(rate)); // closest to peg 1.0 wins ties
      if (!best || dist < best.dist) best = { scale: s, dist };
    }
  }
  return best ? best.scale : null;
}

export async function estimateAppKitSwap(tokenIn, tokenOut, amountIn, opts = {}) {
  // Circle SDK v1.4.1 token registry lacks EURC on Arc_Testnet, so
  // kit.estimateSwap() builds a malformed body and Circle returns 331001.
  // Use GET /quote with explicit on-chain addresses instead.
  if (opts.tokenInAddress && opts.tokenOutAddress) {
    const chainName = opts.chain || window.ARC_APPKIT_CONFIG?.network || 'Arc_Testnet';
    // GET /quote works fine with a dummy address - confirmed on Arc Testnet.
    // Do NOT call window.ethereum.request() here: that can hang if the wallet
    // extension is initializing, freezing the entire quote pipeline.
    const addr = '0x0000000000000000000000000000000000000001';
    // REQUEST scale: human-readable decimal (same convention as kit.swap()).
    // Confirmed empirically - sending base units ("1000000") made Circle quote for
    // 1,000,000 USDC, exhausting the testnet pool and returning ~79 EURC.
    const amountHuman = parseFloat(amountIn).toString();
    const qs = new URLSearchParams({
      tokenInAddress: opts.tokenInAddress,
      tokenInChain: chainName,
      tokenOutAddress: opts.tokenOutAddress,
      tokenOutChain: chainName,
      fromAddress: addr,
      toAddress: addr,
      amount: amountHuman,
    });
    console.log('[arc-appkit] estimateSwap via GET /quote:', { tokenIn, tokenOut, amountHuman, chainName });
    const resp = await fetch(`${PROXY_PREFIX}/v1/stablecoinKits/quote?${qs}`, {
      signal: AbortSignal.timeout(5000),
    });
    const json = await resp.json();
    if (!resp.ok) throw new Error(`Circle quote ${resp.status}: ${json.message || JSON.stringify(json)}`);
    const q = json?.quote;
    if (!q || !q.estimatedAmount) throw new Error(`No route: ${JSON.stringify(json)}`);
    // RESPONSE scale: NOT documented for Arc Testnet and has flip-flopped between
    // releases. Instead of hard-coding a divisor, auto-detect it: try the raw value
    // and common base-unit scales, then keep whichever yields a rate inside the
    // plausible stablecoin-FX band. We always return Circle's REAL number - just
    // correctly scaled - never a faked peg.
    const _scale = _pickQuoteScale(q.estimatedAmount, parseFloat(amountIn));
    if (!_scale) throw new Error(`Circle quote out of range (raw=${q.estimatedAmount}, in=${amountIn})`);
    const humanOut = (parseFloat(q.estimatedAmount) / _scale).toFixed(6);
    const humanMin = q.minAmount ? (parseFloat(q.minAmount) / _scale).toFixed(6) : undefined;
    console.log('[arc-appkit] quote result:', { estimatedAmount: q.estimatedAmount, scale: _scale, humanOut, humanMin });
    return {
      estimatedOutput: { amount: humanOut, token: tokenOut },
      stopLimit: humanMin ? { amount: humanMin, token: tokenOut } : undefined,
      fees: q.fees || [],
    };
  }

  // Fallback: use kit.estimateSwap() (SDK-based, may fail if token not in registry)
  await initAppKit();
  const params = {
    from: { adapter, chain: window.ARC_APPKIT_CONFIG.network },
    tokenIn,
    tokenOut,
    amountIn,
    config: { kitKey: window.ARC_APPKIT_CONFIG.kitKey }
  };
  console.log('[arc-appkit] estimateSwap via SDK:', { ...params, config: { kitKey: '***' } });
  const res = await kit.estimateSwap(params);
  console.log('[arc-appkit] estimateSwap SDK response:', JSON.stringify(res));
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

// ─── BRIDGE (App Kit Bridge wrapping CCTP V2) ─────────────────────────────
/**
 * Bridge USDC across chains via App Kit (handles burn + attestation + mint).
 * @param {string} fromChain - e.g. 'Arc_Testnet'
 * @param {string} toChain   - e.g. 'Ethereum_Sepolia'
 * @param {string} amount    - human-readable decimal e.g. '1.00'
 * @param {string} [recipient] - destination address (defaults to same wallet)
 */
export async function appKitBridge(fromChain, toChain, amount, recipient) {
  await initAppKit();
  const params = {
    from: { adapter, chain: fromChain },
    to: { adapter, chain: toChain, recipientAddress: recipient || undefined },
    amount,
    config: { kitKey: window.ARC_APPKIT_CONFIG.kitKey }
  };
  console.log('[arc-appkit] bridge params:', { ...params, config: { kitKey: '***' } });
  return kit.bridge(params);
}

export async function estimateAppKitBridge(fromChain, toChain, amount) {
  await initAppKit();
  // App Kit bridge typically auto-estimates; expose for UI preview if SDK supports
  if (typeof kit.estimateBridge !== 'function') {
    return { estimatedOutput: { amount, token: 'USDC' }, fees: [] };
  }
  return kit.estimateBridge({
    from: { adapter, chain: fromChain },
    to: { adapter, chain: toChain },
    amount,
    config: { kitKey: window.ARC_APPKIT_CONFIG.kitKey }
  });
}

// ─── UNIFIED BALANCE (Circle Gateway) ─────────────────────────────────────
/**
 * Deposit USDC from a source chain into the user's chain-agnostic Unified Balance.
 * @param {string} fromChain - e.g. 'Base_Sepolia', 'Arbitrum_Sepolia'
 * @param {string} amount    - decimal string e.g. '1.00'
 */
export async function ubDeposit(fromChain, amount) {
  await initAppKit();
  if (!kit.unifiedBalance) throw new Error('Unified Balance not available in this SDK version');
  return kit.unifiedBalance.deposit({
    from: { adapter, chain: fromChain },
    amount,
    token: 'USDC',
    config: { kitKey: window.ARC_APPKIT_CONFIG.kitKey }
  });
}

/**
 * Spend from Unified Balance to a recipient on a destination chain.
 * @param {string} amount       - decimal string
 * @param {string} toChain      - e.g. 'Arc_Testnet'
 * @param {string} recipient    - destination address (0x...)
 */
export async function ubSpend(amount, toChain, recipient) {
  await initAppKit();
  if (!kit.unifiedBalance) throw new Error('Unified Balance not available in this SDK version');
  return kit.unifiedBalance.spend({
    amount,
    from: { adapter },
    to: { adapter, chain: toChain, recipientAddress: recipient },
    token: 'USDC',
    config: { kitKey: window.ARC_APPKIT_CONFIG.kitKey }
  });
}

/**
 * Get current Unified Balance across all chains.
 */
export async function ubGetBalance() {
  await initAppKit();
  if (!kit.unifiedBalance) throw new Error('Unified Balance not available in this SDK version');
  return kit.unifiedBalance.getBalance({
    from: { adapter },
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
 * Quick health check - verifies the config is loaded and kit can init.
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
    k && !k.includes('PASTE_YOUR_KEY') &&
    !k.includes('PROXIED_VIA_') &&
    !k.includes('proxied_in_cloudflare_function')
  );
}

// Expose globally for debugging in console (NOT for production logic - use imports above)
if (typeof window !== 'undefined') {
  window.ARC_APPKIT = {
    initAppKit, isAppKitReady, prefetchSdk,
    estimateAppKitSwap, appKitSwap,
    appKitBridge, estimateAppKitBridge,
    ubDeposit, ubSpend, ubGetBalance,
  };
}
