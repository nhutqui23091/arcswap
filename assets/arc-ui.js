/* ArcSwap shared UI widgets — navbar, toast, modal, cursor. Requires arc-core.js */
(function (global) {
  'use strict';
  if (!global.ARC) { console.error('[arc-ui] ARC core not loaded'); return; }
  const ARC = global.ARC;

  // ── NAVBAR ─────────────────────────────────────────────
  function renderNav(active) {
    // Central nav — top-level product pages.
    // Balance moved to wallet dropdown (only relevant when connected).
    // Points hidden — page disabled until incentive program ready.
    const tabs = [
      { id: 'trade', label: 'Trade', href: '/trade' },
      { id: 'pool',  label: 'Pool',  href: '/pool'  },
      { id: 'vault', label: 'Vault', href: '/vault' },
      { id: 'token', label: 'Token', href: '/token' },
    ];
    const html = `
      <a class="nav-logo" href="/">
        <span class="logo-name">ArcSwap</span>
        <span class="logo-badge">TESTNET</span>
      </a>
      <div class="nav-tabs">
        ${tabs.map(t => `<a class="nav-tab ${t.id===active?'active':''}" href="${t.href}">${t.label}</a>`).join('')}
        <a class="nav-tab" href="https://faucet.circle.com" target="_blank" rel="noopener">💧 Faucet</a>
      </div>
      <div class="nav-right">
        <span class="nav-pill"><span class="dot"></span>Arc Testnet</span>
        <button id="arc-wallet-btn" class="wallet-btn disconnected">Connect Wallet</button>
      </div>`;
    let nav = document.querySelector('nav.arc-nav');
    if (!nav) {
      nav = document.createElement('nav');
      nav.className = 'arc-nav';
      document.body.insertBefore(nav, document.body.firstChild);
    }
    nav.innerHTML = html;
    document.getElementById('arc-wallet-btn').onclick = onWalletClick;
    window.addEventListener('scroll', () => nav.classList.toggle('scrolled', window.scrollY > 10), { passive: true });
    refreshWalletBtn();
    ARC.wallet.on(refreshWalletBtn);
  }

  function refreshWalletBtn() {
    const btn = document.getElementById('arc-wallet-btn'); if (!btn) return;
    const s = ARC.wallet.snapshot();
    if (s.connected) {
      btn.classList.remove('disconnected');
      btn.innerHTML = `<span class="dot"></span>${ARC.shortAddr(s.address)}`;
      btn.title = s.address;
    } else {
      btn.classList.add('disconnected');
      btn.textContent = 'Connect Wallet';
      btn.title = '';
    }
  }

  async function onWalletClick() {
    const s = ARC.wallet.snapshot();
    if (s.connected) {
      openWalletMenu();
    } else {
      try { await ARC.wallet.connect(); toast('success', 'Connected', ARC.shortAddr(ARC.wallet.address)); }
      catch (e) { toast('error', 'Connect failed', ARC.explainError(e)); }
    }
  }

  function openWalletMenu() {
    const addr = ARC.wallet.address;
    openModal({
      title: 'Account',
      body: `
        <div style="display:flex;flex-direction:column;gap:10px">
          <div style="padding:12px 14px;border:1px solid var(--border);border-radius:12px;background:var(--surface)">
            <div class="label-caps" style="margin-bottom:4px">Address</div>
            <div class="mono" style="font-size:13px;word-break:break-all">${addr}</div>
          </div>
          <a class="btn-ghost" href="/balance" style="display:flex;align-items:center;justify-content:space-between;text-decoration:none">
            <span>💰 Unified Balance</span>
            <span style="font-family:var(--mono);font-size:10px;color:#FFB454;letter-spacing:.12em">// BETA</span>
          </a>
          <div style="display:flex;gap:8px">
            <button class="btn-ghost" style="flex:1" id="arc-copy-addr">Copy</button>
            <a class="btn-ghost" style="flex:1;text-align:center" id="arc-explorer-link" target="_blank" rel="noopener">View on Explorer ↗</a>
          </div>
          <button class="btn-ghost" id="arc-disconnect" style="color:var(--red);border-color:rgba(255,85,119,.3)">Disconnect</button>
        </div>`,
      onOpen: () => {
        document.getElementById('arc-copy-addr').onclick = () => {
          navigator.clipboard.writeText(addr); toast('success', 'Copied');
        };
        const link = document.getElementById('arc-explorer-link');
        const ck = ARC.wallet.chainKey || 'arc';
        link.href = ARC.CHAINS[ck]?.explorerAddr(addr) || '#';
        document.getElementById('arc-disconnect').onclick = () => {
          ARC.wallet.disconnect(); closeModal(); toast('', 'Disconnected');
        };
      },
    });
  }

  // ── TOAST ──────────────────────────────────────────────
  function ensureToastStack() {
    let s = document.querySelector('.toast-stack');
    if (!s) { s = document.createElement('div'); s.className = 'toast-stack'; document.body.appendChild(s); }
    return s;
  }
  function toast(kind, title, sub, opts = {}) {
    const stack = ensureToastStack();
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    const iconMap = { success: '✓', error: '✕', warn: '⚠', '': '•' };
    el.innerHTML = `
      <div class="toast-icon">${opts.icon || iconMap[kind] || '•'}</div>
      <div class="toast-body">
        <div class="toast-title">${title || ''}</div>
        ${sub ? `<div class="toast-sub">${sub}</div>` : ''}
      </div>
      <button class="toast-close" aria-label="close">×</button>`;
    el.querySelector('.toast-close').onclick = () => el.remove();
    stack.appendChild(el);
    const ttl = opts.ttl ?? (kind === 'error' ? 8000 : 5000);
    if (ttl) setTimeout(() => el.remove(), ttl);
    return el;
  }

  // ── MODAL ──────────────────────────────────────────────
  function ensureModalRoot() {
    let m = document.getElementById('arc-modal-root');
    if (!m) {
      m = document.createElement('div');
      m.id = 'arc-modal-root';
      m.className = 'arc-modal-bg';
      m.innerHTML = `<div class="arc-modal"><div class="arc-modal-head"><div class="arc-modal-title"></div><button class="arc-modal-close" aria-label="close">×</button></div><div class="arc-modal-body"></div></div>`;
      document.body.appendChild(m);
      m.addEventListener('click', (e) => { if (e.target === m) closeModal(); });
      m.querySelector('.arc-modal-close').onclick = closeModal;
    }
    return m;
  }
  function openModal({ title, body, onOpen }) {
    const m = ensureModalRoot();
    m.querySelector('.arc-modal-title').textContent = title || '';
    m.querySelector('.arc-modal-body').innerHTML = typeof body === 'string' ? body : '';
    if (body instanceof HTMLElement) { m.querySelector('.arc-modal-body').innerHTML = ''; m.querySelector('.arc-modal-body').appendChild(body); }
    m.classList.add('show');
    onOpen?.(m);
  }
  function closeModal() { document.getElementById('arc-modal-root')?.classList.remove('show'); }

  // ── AURORA + CURSOR ────────────────────────────────────
  function renderAurora() {
    if (document.querySelector('.aurora-bg')) return;
    const d = document.createElement('div');
    d.className = 'aurora-bg';
    d.innerHTML = `<div class="orb orb1"></div><div class="orb orb2"></div><div class="orb orb3"></div><div class="orb orb4"></div>`;
    document.body.insertBefore(d, document.body.firstChild);
  }

  function renderCursor() {
    if (window.matchMedia('(pointer:coarse)').matches) return;
    document.body.classList.add('cursor-none');
    const dot = document.createElement('div'); dot.className = 'cursor-dot';
    const ring = document.createElement('div'); ring.className = 'cursor-ring';
    document.body.appendChild(dot); document.body.appendChild(ring);
    let rx = 0, ry = 0, tx = 0, ty = 0;
    document.addEventListener('mousemove', (e) => {
      dot.style.left = e.clientX + 'px'; dot.style.top = e.clientY + 'px';
      tx = e.clientX; ty = e.clientY;
    });
    function tick() {
      rx += (tx - rx) * 0.2; ry += (ty - ry) * 0.2;
      ring.style.left = rx + 'px'; ring.style.top = ry + 'px';
      requestAnimationFrame(tick);
    } tick();
    document.addEventListener('mouseover', (e) => {
      if (e.target.closest('a,button,input,select,textarea,[data-hover]')) {
        ring.style.width = '56px'; ring.style.height = '56px'; ring.style.borderColor = 'rgba(0,207,255,.6)';
      }
    });
    document.addEventListener('mouseout', () => {
      ring.style.width = '36px'; ring.style.height = '36px'; ring.style.borderColor = 'rgba(255,255,255,.5)';
    });
  }

  // ── BOOT ───────────────────────────────────────────────
  async function boot(activeTab) {
    renderAurora();
    renderCursor();
    renderNav(activeTab);
    await ARC.wallet.autoConnect().catch(() => null);
  }

  global.ArcUI = { boot, renderNav, toast, openModal, closeModal };
})(window);
