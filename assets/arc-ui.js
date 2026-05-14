/* ArcSwap shared UI widgets — navbar, toast, modal, cursor. Requires arc-core.js */
(function (global) {
  'use strict';
  if (!global.ARC) { console.error('[arc-ui] ARC core not loaded'); return; }
  const ARC = global.ARC;

  // ── NAVBAR ─────────────────────────────────────────────
  // Whitelist: addresses allowed to see Pool while it's still in development.
  // Direct URL (/pool) still resolves — gating is nav-only so bookmarks keep
  // working for testers.
  const TESTER_ADDRESSES = new Set([
    '0x738722f22ef4fb6abc3ac69bbc30f77b2b6bc762',
  ]);
  function isTester(addr) {
    return !!addr && TESTER_ADDRESSES.has(String(addr).toLowerCase());
  }

  function navTabs(active) {
    const base = [
      { id: 'trade',   label: 'Trade',        href: '/trade'   },
      { id: 'balance', label: 'Balance',      href: '/balance' },
      { id: 'agent',   label: 'Agent',        href: '/agent', newBadge: true },
      { id: 'token',   label: 'Create Token', href: '/token'   },
    ];
    const gated = isTester(ARC.wallet.address)
      ? [
          { id: 'pool',  label: 'Pool',  href: '/pool'  },
        ]
      : [];
    return [...base, ...gated];
  }

  function renderNav(active) {
    let nav = document.querySelector('nav.arc-nav');
    if (!nav) {
      nav = document.createElement('nav');
      nav.className = 'arc-nav';
      document.body.insertBefore(nav, document.body.firstChild);
    }
    const paint = () => {
      const tabs = navTabs(active);
      nav.innerHTML = `
        <a class="nav-logo" href="/">
          <span class="logo-name">ArcSwap</span>
          <span class="logo-badge">TESTNET</span>
        </a>
        <div class="nav-tabs">
          ${tabs.map(t => `<a class="nav-tab ${t.id===active?'active':''}${t.newBadge?' new-pill':''}" href="${t.href}">${t.label}</a>`).join('')}
          <a class="nav-tab" href="https://faucet.circle.com" target="_blank" rel="noopener">💧 Faucet</a>
          <a class="nav-tab ${active==='blog'?'active':''}" href="/blog">Blog</a>
        </div>
        <div class="nav-right">
          <span class="nav-pill"><span class="dot"></span>Arc Testnet</span>
          <button id="arc-wallet-btn" class="wallet-btn disconnected">Connect Wallet</button>
        </div>`;
      document.getElementById('arc-wallet-btn').onclick = onWalletClick;
      refreshWalletBtn();
    };
    paint();
    window.addEventListener('scroll', () => nav.classList.toggle('scrolled', window.scrollY > 10), { passive: true });
    // Re-paint when wallet changes — gated tabs depend on the connected address
    ARC.wallet.on(paint);
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
    if (s.connected) { openWalletMenu(); return; }
    // Always open the picker — even with 0 detected wallets, the picker shows
    // install links for popular wallets so the user has a path forward instead
    // of a dead-end toast. With 1 wallet they still get a one-click confirm.
    const providers = ARC.wallet.listProviders();
    openWalletPicker(providers);
  }

  // Curated catalog of popular EVM wallets. Used to surface install links for
  // wallets the user DOESN'T have yet (greys them out below the installed list).
  // Order here matches the priority order in arc-core.js _PROVIDER_PRIORITY.
  const WALLET_CATALOG = [
    { rdns: 'io.metamask',          name: 'MetaMask',     install: 'https://metamask.io/download/',
      icon: 'data:image/svg+xml;utf8,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Cpath fill=%22%23E2761B%22 d=%22M28.7 4 17.5 12.3l2-4.9z%22/%3E%3Cpath fill=%22%23E4761B%22 d=%22m3.3 4 11 8.4-1.9-5zM24.6 22.2l-3 4.5 6.4 1.8 1.8-6.2zM2.2 22.3 4 28.5l6.4-1.8-3-4.5z%22/%3E%3Cpath fill=%22%23F6851B%22 d=%22M16 14 13.7 17l5 .2-.2-5.4zM21.4 21.5l-1.7-1 1.2-1z%22/%3E%3C/svg%3E' },
    { rdns: 'com.okxwallet',        name: 'OKX Wallet',   install: 'https://www.okx.com/web3' },
    { rdns: 'io.rabby',             name: 'Rabby',        install: 'https://rabby.io' },
    { rdns: 'com.coinbase.wallet',  name: 'Coinbase Wallet', install: 'https://www.coinbase.com/wallet' },
    { rdns: 'com.trustwallet.app',  name: 'Trust Wallet', install: 'https://trustwallet.com/download' },
    { rdns: 'com.brave.wallet',     name: 'Brave Wallet', install: 'https://brave.com/wallet/' },
    { rdns: 'app.phantom',          name: 'Phantom',      install: 'https://phantom.app/download' },
    { rdns: 'app.keplr',            name: 'Keplr',        install: 'https://www.keplr.app/download' },
  ];

  function openWalletPicker(providers) {
    const installedRdns = new Set(providers.map(p => p.info?.rdns).filter(Boolean));

    function iconFor(p) {
      if (p.info?.icon) return `<img src="${p.info.icon}" alt="" style="width:36px;height:36px;border-radius:9px;flex-shrink:0;object-fit:cover"/>`;
      const cat = WALLET_CATALOG.find(c => c.rdns === p.info?.rdns);
      if (cat?.icon) return `<img src="${cat.icon}" alt="" style="width:36px;height:36px;border-radius:9px;flex-shrink:0;background:#fff;padding:4px"/>`;
      return `<div style="width:36px;height:36px;border-radius:9px;background:linear-gradient(135deg,#4DD6DB,#4A7BEC);display:flex;align-items:center;justify-content:center;color:#0A1628;font-weight:800;font-size:15px;flex-shrink:0">${(p.info?.name?.[0] || 'W').toUpperCase()}</div>`;
    }

    const installedRows = providers.map(p => {
      const name = p.info?.name || 'Wallet';
      const rdns = p.info?.rdns || '';
      return `
        <button class="arc-wp-row arc-wp-installed" data-rdns="${rdns}" type="button">
          ${iconFor(p)}
          <div style="flex:1;min-width:0;text-align:left">
            <div style="font-size:14px;font-weight:600;color:var(--text)">${name}</div>
          </div>
          <span class="arc-wp-badge installed">INSTALLED</span>
        </button>`;
    }).join('');

    const notInstalled = WALLET_CATALOG.filter(c => !installedRdns.has(c.rdns));
    const suggestRows = notInstalled.map(c => {
      const iconHtml = c.icon
        ? `<img src="${c.icon}" alt="" style="width:36px;height:36px;border-radius:9px;flex-shrink:0;background:#fff;padding:4px"/>`
        : `<div style="width:36px;height:36px;border-radius:9px;background:rgba(255,255,255,.05);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;color:var(--muted);font-weight:700;font-size:14px;flex-shrink:0">${c.name[0]}</div>`;
      return `
        <a class="arc-wp-row arc-wp-suggest" href="${c.install}" target="_blank" rel="noopener noreferrer">
          ${iconHtml}
          <div style="flex:1;min-width:0;text-align:left">
            <div style="font-size:14px;font-weight:500;color:var(--muted)">${c.name}</div>
          </div>
          <span class="arc-wp-badge">Install ↗</span>
        </a>`;
    }).join('');

    openModal({
      title: 'Connect a wallet',
      body: `
        <style>
          .arc-wp-row{display:flex;align-items:center;gap:12px;padding:11px 12px;border-radius:12px;background:var(--surface);border:1px solid var(--border);cursor:pointer;transition:all .15s;width:100%;margin-bottom:6px;font-family:inherit;text-decoration:none}
          .arc-wp-row:hover{border-color:var(--border2);background:rgba(255,255,255,.06);transform:translateX(2px)}
          .arc-wp-row:active{transform:translateX(0)}
          .arc-wp-installed{border-color:rgba(123,228,149,.25);background:rgba(123,228,149,.04)}
          .arc-wp-installed:hover{border-color:rgba(123,228,149,.5);background:rgba(123,228,149,.08)}
          .arc-wp-suggest{opacity:.7}
          .arc-wp-suggest:hover{opacity:1;transform:translateX(2px)}
          .arc-wp-badge{font-size:10px;font-weight:700;letter-spacing:.06em;padding:3px 8px;border-radius:6px;background:var(--surface2);color:var(--muted);font-family:var(--mono);white-space:nowrap}
          .arc-wp-badge.installed{background:rgba(123,228,149,.15);color:#7BE495}
          .arc-wp-section{font-family:var(--mono);font-size:10.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:14px 4px 8px;display:block}
          .arc-wp-section:first-child{margin-top:0}
        </style>
        ${providers.length ? `
          <div class="arc-wp-section">${providers.length === 1 ? '1 wallet' : providers.length + ' wallets'} detected</div>
          ${installedRows}` : ''}
        ${notInstalled.length ? `
          <div class="arc-wp-section">More options</div>
          ${suggestRows}` : ''}
        <div style="margin-top:14px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,.025);border:1px solid var(--border);font-size:11.5px;color:var(--muted);line-height:1.55">
          <strong style="color:var(--text)">EVM-first ordering.</strong> MetaMask, OKX, Rabby, Coinbase top the list. Phantom / Keplr work too but are deprioritized — they're primarily Solana / Cosmos wallets.
        </div>`,
      onOpen: () => {
        document.querySelectorAll('.arc-wp-installed').forEach(btn => {
          btn.onclick = async () => {
            const rdns = btn.dataset.rdns;
            closeModal();
            try {
              await ARC.wallet.connect(rdns);
              toast('success', 'Connected', ARC.shortAddr(ARC.wallet.address));
            } catch (e) {
              toast('error', 'Connect failed', ARC.explainError(e));
            }
          };
        });
      },
    });
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
