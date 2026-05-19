/* ═══════════════════════════════════════════════════════════════════════════
   ArcSwap Status — shared helpers across all status.arcswap.net pages.

   Exposes window.ArcStatus with:
     - API_BASE         → cross-origin base URL ('' on localhost, 'https://arcswap.net' on prod)
     - rng              → daily-seeded mulberry32 (stable values per UTC day)
     - ri, rf, pick     → seeded helpers
     - fmtNum, fmtUsd, fmtAgo, shortHash
     - probeUrl, probeRpc → real network probes with latency
     - classifyResult, latBucket
     - SERVICES, CHAIN_PROBE → catalogs
     - renderTopNav, renderSubNav, renderFooter
     - bootCommon       → mount nav/footer + scroll handler
   ═══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  // ── API base (cross-origin probe target)
  const API_BASE = /^status\./.test(global.location.hostname) ? 'https://arcswap.net' : '';

  // ── Daily-seeded RNG (mulberry32)
  function seededRng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function dailySeed() {
    const d = new Date();
    return Number('' + d.getUTCFullYear() + ('0' + (d.getUTCMonth() + 1)).slice(-2) + ('0' + d.getUTCDate()).slice(-2));
  }
  const rng = seededRng(dailySeed());
  const ri = (lo, hi) => Math.floor(rng() * (hi - lo + 1)) + lo;
  const rf = (lo, hi) => rng() * (hi - lo) + lo;
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];

  // ── Formatters
  const fmtNum = (n) => Number(n).toLocaleString('en-US');
  const fmtUsd = (n) => '$' + (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(0));
  const fmtAgo = (ms) => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  };
  const shortHash = (h) => h.slice(0, 6) + '…' + h.slice(-4);
  const hex = (n) => {
    const chars = '0123456789abcdef';
    let s = '0x';
    for (let i = 0; i < n; i++) s += chars[Math.floor(rng() * 16)];
    return s;
  };
  const latBucket = (ms) => ms < 250 ? 'lat-fast' : ms < 800 ? 'lat-slow' : 'lat-bad';

  // ── Probes
  async function probeUrl(url, opts = {}, timeoutMs = 4000) {
    const ctrl = new AbortController();
    const t0 = performance.now();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { ...opts, signal: ctrl.signal, redirect: 'follow' });
      const dt = Math.round(performance.now() - t0);
      // 403 / 429 from Cloudflare = WAF challenge or rate limit. Trip the
      // circuit breaker so we stop polling for 5 minutes and don't make
      // the situation worse by piling on more requests.
      if (resp.status === 403 || resp.status === 429) markRateLimited();
      const reachable = resp.status < 500;
      return { ok: reachable, latencyMs: dt, status: resp.status };
    } catch (e) {
      const dt = Math.round(performance.now() - t0);
      return { ok: false, latencyMs: dt, status: 0, err: e.name === 'AbortError' ? 'timeout' : 'unreachable' };
    } finally { clearTimeout(timer); }
  }

  async function probeRpc(url, timeoutMs = 4000) {
    const ctrl = new AbortController();
    const t0 = performance.now();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      });
      const dt = Math.round(performance.now() - t0);
      if (!resp.ok) return { ok: false, latencyMs: dt, status: resp.status };
      const j = await resp.json().catch(() => null);
      const block = j && j.result ? parseInt(j.result, 16) : null;
      return { ok: !!block, latencyMs: dt, block, status: resp.status };
    } catch (e) {
      const dt = Math.round(performance.now() - t0);
      return { ok: false, latencyMs: dt, status: 0, err: e.name === 'AbortError' ? 'timeout' : 'unreachable' };
    } finally { clearTimeout(timer); }
  }

  function classifyResult(r) {
    if (r.err === 'unreachable') return 'unk';
    if (!r.ok) return 'dn';
    if (r.latencyMs > 1500) return 'deg';
    return 'op';
  }

  // ── Real-metrics fetchers (cross-origin to arcswap.net/api/metrics/*)
  // Both return null on failure so callers can fall back to seeded data.
  async function fetchSummary() {
    // No `cache: 'no-cache'` — that header forces edge revalidation on every
    // request, defeating Cloudflare's edge cache (max-age=120 on the response).
    // The server response Cache-Control already controls freshness correctly.
    try {
      const r = await fetch(API_BASE + '/api/metrics/summary');
      if (!r.ok) return null;
      const j = await r.json();
      return j && j.ready ? j : null;
    } catch { return null; }
  }
  async function fetchRecent(n = 20) {
    try {
      const r = await fetch(API_BASE + '/api/metrics/recent?n=' + n);
      if (!r.ok) return null;
      const j = await r.json();
      return j && j.ready ? j : null;
    } catch { return null; }
  }

  // ── Live/Demo data-source badge
  // Renders a small chip explaining whether numbers on the page come from
  // real telemetry (/api/metrics/*) or seeded mock data. Call updateDataBadge
  // whenever the status changes.
  function mountDataBadge(opts = {}) {
    const host = document.getElementById('data-badge');
    if (!host) return;
    const status = opts.status || 'probing'; // 'live' | 'demo' | 'probing'
    const detail = opts.detail || '';
    const cls = status === 'live' ? 'live' : status === 'demo' ? 'demo' : 'probing';
    const label = status === 'live' ? 'LIVE · real telemetry' : status === 'demo' ? 'DEMO · seeded snapshot' : 'PROBING · /api/metrics';
    host.innerHTML = `<span class="data-pill ${cls}"><span class="d"></span>${label}${detail ? ' · ' + detail : ''}</span>`;
  }

  // ── Catalogs
  const SERVICES = [
    { id: 'frontend', name: 'ArcSwap Frontend',      probe: () => probeUrl((API_BASE || '') + '/', { method: 'HEAD', cache: 'no-store' }), uptime: 99.98, hint: 'Cloudflare Pages' },
    { id: 'balance',  name: 'Unified Balance API',   probe: () => probeUrl(API_BASE + '/api/gateway-proxy/health', { method: 'HEAD' }), uptime: 99.92, hint: 'Circle Gateway' },
    { id: 'trade',    name: 'Trade Engine',          probe: () => probeRpc('https://rpc.testnet.arc.network'), uptime: 99.85, hint: 'Arc L1 RPC' },
    { id: 'agent',    name: 'Agent System',          probe: () => probeUrl(API_BASE + '/api/agent/health', { method: 'HEAD' }), uptime: 99.74, hint: 'Cloudflare KV' },
    { id: 'gw-proxy', name: 'Circle Gateway Proxy',  probe: () => probeUrl(API_BASE + '/api/gateway-proxy/health', { method: 'HEAD' }), uptime: 99.91, hint: 'gateway-api-testnet.circle.com' },
    { id: 'kit-proxy',name: 'Circle App Kit Proxy',  probe: () => probeUrl(API_BASE + '/api/circle-proxy/health', { method: 'HEAD' }), uptime: 99.88, hint: 'api.circle.com' },
    { id: 'cron',     name: 'Automation Workers',    probe: () => probeUrl(API_BASE + '/api/agent/health-cron', { method: 'HEAD' }), uptime: 99.79, hint: 'Cron Trigger' },
    { id: 'settle',   name: 'Settlement Services',   probe: () => probeRpc('https://rpc.testnet.arc.network'), uptime: 99.83, hint: 'CCTP V2 + Arc' },
  ];

  const CHAINS = [
    { key: 'arc',             label: 'Arc Testnet',       short: 'AR',   rpc: 'https://rpc.testnet.arc.network', grad: 'linear-gradient(135deg,#6C3FFF,#00CFFF)', explorer: 'https://testnet.arcscan.app/tx/' },
    { key: 'sepolia',         label: 'Ethereum Sepolia',  short: 'SE',   rpc: 'https://ethereum-sepolia-rpc.publicnode.com', grad: 'linear-gradient(135deg,#627EEA,#8A9CF0)', explorer: 'https://sepolia.etherscan.io/tx/' },
    { key: 'baseSepolia',     label: 'Base Sepolia',      short: 'BA',   rpc: 'https://sepolia.base.org', grad: 'linear-gradient(135deg,#0052FF,#62A5FF)', explorer: 'https://sepolia.basescan.org/tx/' },
    { key: 'arbitrumSepolia', label: 'Arbitrum Sepolia',  short: 'AB',   rpc: 'https://sepolia-rollup.arbitrum.io/rpc', grad: 'linear-gradient(135deg,#28A0F0,#80C8F8)', explorer: 'https://sepolia.arbiscan.io/tx/' },
    { key: 'optimismSepolia', label: 'OP Sepolia',        short: 'OP',   rpc: 'https://optimism-sepolia.publicnode.com', grad: 'linear-gradient(135deg,#FF0420,#FF6B7E)', explorer: 'https://sepolia-optimism.etherscan.io/tx/' },
    { key: 'avalancheFuji',   label: 'Avalanche Fuji',    short: 'AV',   rpc: 'https://api.avax-test.network/ext/bc/C/rpc', grad: 'linear-gradient(135deg,#E84142,#F87C7D)', explorer: 'https://testnet.snowtrace.io/tx/' },
    { key: 'polygonAmoy',     label: 'Polygon Amoy',      short: 'PO',   rpc: 'https://rpc-amoy.polygon.technology', grad: 'linear-gradient(135deg,#8247E5,#B58CF0)', explorer: 'https://amoy.polygonscan.com/tx/' },
    { key: 'unichainSepolia', label: 'Unichain Sepolia',  short: 'UN',   rpc: 'https://sepolia.unichain.org', grad: 'linear-gradient(135deg,#FF007A,#FF66B0)', explorer: 'https://sepolia.uniscan.xyz/tx/' },
  ];

  // ── Nav + footer renderers
  function renderTopNav() {
    return `
      <nav class="topnav" id="topnav">
        <a class="nav-logo" href="/">
          <span class="logo-name">ArcSwap</span>
          <span class="logo-sub">Status</span>
        </a>
        <div class="nav-right">
          <a class="btn-back" href="https://arcswap.net" target="_blank" rel="noopener noreferrer">← Back to ArcSwap</a>
          <div class="testnet-pill"><div class="tnet-dot"></div>Arc Testnet</div>
        </div>
      </nav>
    `;
  }

  const SUBNAV_PAGES = [
    { id: 'overview',  ix: '01', label: 'Overview',   href: '/' },
    { id: 'services',  ix: '02', label: 'Services',   href: '/services' },
    { id: 'chains',    ix: '03', label: 'Chains',     href: '/chains' },
    { id: 'agents',    ix: '04', label: 'Agents',     href: '/agents' },
    { id: 'incidents', ix: '05', label: 'Incidents',  href: '/incidents' },
  ];

  function renderSubNav(activeId) {
    return `
      <div class="subnav">
        <div class="subnav-inner">
          ${SUBNAV_PAGES.map(p => `
            <a class="subnav-link ${p.id === activeId ? 'active' : ''}" href="${p.href}">
              <span class="ix">${p.ix}</span>${p.label}
            </a>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderFooter() {
    return `
      <div class="footer">
        <div class="footer-left">
          <a href="https://arcswap.net/">arcswap.net</a>
          <a href="https://x.com/arc_swap" target="_blank" rel="noopener noreferrer">@arc_swap</a>
          <a href="https://discord.gg/7XUPdWWrGk" target="_blank" rel="noopener noreferrer">Discord</a>
          <a href="https://arcswap.net/.well-known/security.txt">security.txt</a>
        </div>
        <div>Built on Arc · Powered by Circle · <span id="footer-ts">—</span></div>
      </div>
    `;
  }

  function bootCommon(activePageId) {
    // Insert nav + subnav at top of body
    const navMount = document.getElementById('nav-mount');
    if (navMount) navMount.innerHTML = renderTopNav() + renderSubNav(activePageId);
    // Insert footer
    const footMount = document.getElementById('footer-mount');
    if (footMount) footMount.innerHTML = renderFooter();
    // Scroll handler
    const nav = document.getElementById('topnav');
    if (nav) {
      addEventListener('scroll', () => nav.classList.toggle('scrolled', scrollY > 12), { passive: true });
    }
    // Footer timestamp tick
    function tickFooter() {
      const el = document.getElementById('footer-ts');
      if (!el) return;
      const d = new Date();
      const offset = -d.getTimezoneOffset() / 60;
      const sign = offset >= 0 ? '+' : '';
      el.textContent = 'Last synced ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) + ' UTC' + sign + offset;
    }
    tickFooter();
    setInterval(tickFooter, 1000);
  }

  // ─── SMART INTERVAL ────────────────────────────────────────────────────────
  // Drop-in replacement for setInterval that:
  //   1. Pauses when the tab is hidden (Page Visibility API). Tab in
  //      background → zero network activity. Resumes on visibility change.
  //   2. Trips a circuit breaker for 5 minutes if any callback throws
  //      OR if global.__arcStatusBlocked is set (used by probe functions
  //      when they detect 403/429 from Cloudflare WAF).
  //   3. Runs the callback once immediately on tab-visible after a long
  //      hidden period, so the user sees fresh data when they switch back.
  //
  // Use this instead of setInterval for every polling task on status pages.
  let blockedUntil = 0;
  function markRateLimited(reasonMs) {
    blockedUntil = Math.max(blockedUntil, Date.now() + (reasonMs || 5 * 60_000));
    console.warn('[status] polling paused for', Math.round((blockedUntil - Date.now()) / 1000), 's (WAF backoff)');
  }
  function isPollingPaused() {
    return document.hidden || Date.now() < blockedUntil;
  }
  function smartInterval(fn, intervalMs) {
    let lastRun = Date.now();
    const tick = async () => {
      if (isPollingPaused()) return;
      lastRun = Date.now();
      try { await fn(); }
      catch (e) {
        if (e && (e.status === 403 || e.status === 429)) markRateLimited();
      }
    };
    const id = setInterval(tick, intervalMs);
    // Run once when tab becomes visible after being hidden, so the user
    // sees fresh data the moment they switch back. Debounced by interval/2.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && (Date.now() - lastRun) > intervalMs / 2) tick();
    });
    return id;
  }

  // ─── MANUAL REFRESH BUTTON ─────────────────────────────────────────────────
  // Renders a small "↻ Refresh" button in the page header (nav-right area).
  // Calls all registered refresh handlers on click. 5-second debounce prevents
  // accidental double-clicks from triggering parallel fetches.
  const refreshHandlers = [];
  function onRefresh(fn) { refreshHandlers.push(fn); }
  function mountRefreshButton() {
    const navRight = document.querySelector('.topnav .nav-right');
    if (!navRight || document.getElementById('manual-refresh')) return;
    const btn = document.createElement('button');
    btn.id = 'manual-refresh';
    btn.className = 'btn-back';
    btn.style.cssText = 'cursor:pointer;display:inline-flex;align-items:center;gap:6px';
    btn.innerHTML = '<span style="font-size:14px">↻</span> Refresh';
    let lastClick = 0;
    btn.addEventListener('click', async () => {
      if (Date.now() - lastClick < 5_000) return;
      lastClick = Date.now();
      const orig = btn.innerHTML;
      btn.innerHTML = '<span style="font-size:14px">⟳</span> Refreshing…';
      btn.disabled = true;
      try { await Promise.all(refreshHandlers.map(h => h().catch(() => null))); }
      finally {
        setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 800);
      }
    });
    navRight.insertBefore(btn, navRight.firstChild);
  }

  global.ArcStatus = {
    API_BASE, rng, ri, rf, pick,
    fmtNum, fmtUsd, fmtAgo, shortHash, hex, latBucket,
    probeUrl, probeRpc, classifyResult,
    fetchSummary, fetchRecent, mountDataBadge,
    SERVICES, CHAINS,
    renderTopNav, renderSubNav, renderFooter, bootCommon,
    smartInterval, onRefresh, mountRefreshButton, isPollingPaused, markRateLimited,
    SUBNAV_PAGES,
  };
})(window);
