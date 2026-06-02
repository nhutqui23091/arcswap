/* OneSet shared UI widgets — navbar, toast, modal, cursor. Requires arc-core.js */
(function (global) {
  'use strict';
  if (!global.ARC) { console.error('[arc-ui] ARC core not loaded'); return; }
  const ARC = global.ARC;

  // ── NAVBAR ─────────────────────────────────────────────
  // Two chrome variants:
  //   1. boot()    — classic top nav. Marketing/landing pages (/, /blog).
  //   2. bootApp() — left sidebar app shell. Operator surfaces (/trade,
  //                  /balance, /agent, /history, /token, etc).
  // Dashboard (the operator one) is still gated in functions/_middleware.js;
  // the sidebar "Dashboard" entry is a public placeholder for the future
  // user dashboard.

  function navTabs(active) {
    return [
      { id: 'trade',     label: 'Trade',        href: '/trade'   },
      { id: 'balance',   label: 'Balance',      href: '/balance' },
      { id: 'agent',     label: 'Agent',        href: '/agent', newBadge: true },
      { id: 'history',   label: 'History',      href: '/history', newBadge: true },
      { id: 'token',     label: 'Create Token', href: '/token'   },
    ];
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
          <img class="logo-img" src="/assets/logos/wordmark-arcswap.png?v=2" alt="OneSet" width="129" height="28"/>
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
    // ARC.wallet.connect() opens the Reown AppKit modal (WalletConnect + injected wallets).
    // Falls back to EIP-6963 if AppKit hasn't loaded yet.
    try {
      await ARC.wallet.connect();
      if (ARC.wallet.address) toast('success', 'Connected', ARC.shortAddr(ARC.wallet.address));
    } catch (e) {
      if (e?.message !== 'Connection cancelled') {
        toast('error', 'Connect failed', ARC.explainError(e));
      }
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

  /**
   * Styled confirmation dialog — replaces window.confirm() for security gates
   * (pre-sign review modals etc.) so the UX matches the rest of the app
   * instead of showing the browser-native generic dialog.
   *
   * Usage:
   *   const ok = await ArcUI.confirm({
   *     title: '🔐 Review',
   *     body: 'Some HTML or text describing the action.',
   *     confirmLabel: 'Sign',
   *     cancelLabel: 'Cancel',
   *     danger: false,   // if true, confirm button is red-tinted
   *   });
   *   if (!ok) return;
   *
   * Returns a Promise that resolves true on Confirm and false on Cancel /
   * Esc / backdrop click / X button. Always closes the modal before resolving.
   */
  function confirm({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
    return new Promise((resolve) => {
      // Build the body as a container with the message + a button row
      const wrap = document.createElement('div');
      const msg = document.createElement('div');
      msg.className = 'arc-confirm-msg';
      // Accept either an HTMLElement or an HTML string for `body`
      if (body instanceof HTMLElement) msg.appendChild(body);
      else msg.innerHTML = typeof body === 'string' ? body : '';
      const row = document.createElement('div');
      row.className = 'arc-confirm-row';
      row.style.cssText = 'display:flex;gap:10px;margin-top:18px;justify-content:flex-end';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn-ghost';
      cancelBtn.textContent = cancelLabel;
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'btn-primary';
      confirmBtn.textContent = confirmLabel;
      if (danger) {
        confirmBtn.style.color = 'var(--red)';
        confirmBtn.style.borderColor = 'rgba(255,85,119,.45)';
      }
      row.appendChild(cancelBtn);
      row.appendChild(confirmBtn);
      wrap.appendChild(msg);
      wrap.appendChild(row);

      let settled = false;
      const finish = (val) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey);
        closeModal();
        resolve(val);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') finish(false);
        else if (e.key === 'Enter') finish(true);
      };
      cancelBtn.onclick = () => finish(false);
      confirmBtn.onclick = () => finish(true);

      openModal({
        title: title || 'Confirm',
        body: wrap,
        onOpen: (m) => {
          // Treat backdrop click + X button as Cancel (not just close)
          m.addEventListener('click', (e) => { if (e.target === m) finish(false); }, { once: true });
          m.querySelector('.arc-modal-close').addEventListener('click', () => finish(false), { once: true });
          document.addEventListener('keydown', onKey);
          // Focus confirm by default — Enter accepts, Esc cancels.
          setTimeout(() => confirmBtn.focus(), 50);
        },
      });
    });
  }

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

  // ── SIDEBAR (app shell) ─────────────────────────────────
  // Used by operator surfaces (/history, future /trade /balance /agent).
  // Marketing pages keep the top nav via boot(). State persists via:
  //   localStorage 'arc.side.collapsed' = '1' | '0'   — desktop collapse
  //   body.arc-side-collapsed                          — applied class
  //   body.arc-side-open                               — mobile drawer open
  const SIDE_SECTIONS = [
    {
      title: 'Products',
      items: [
        { id: 'trade',     label: 'Trade',     icon: '⇄', href: '/trade'   },
        { id: 'balance',   label: 'Balance',   icon: '◈', href: '/balance' },
        { id: 'agent',     label: 'Agent',     icon: '∞', href: '/agent',   badge: 'NEW'  },
        { id: 'history',   label: 'History',   icon: '⏱', href: '/history', badge: 'NEW'  },
        { id: 'payment',   label: 'Payment',   icon: '⇢',                    badge: 'SOON', soon: true },
        { id: 'dashboard', label: 'Dashboard', icon: '▦',                    badge: 'SOON', soon: true },
      ],
    },
    {
      title: 'Tools',
      items: [
        { id: 'token',  label: 'Create Token', icon: '⊕', href: '/token'  },
        { id: 'faucet', label: 'Faucet',       icon: '💧', href: 'https://faucet.circle.com', external: true },
        { id: 'blog',   label: 'Blog',         icon: '✎', href: '/blog'   },
      ],
    },
  ];

  function renderSidebar(active) {
    // Initial collapsed state (desktop only; mobile ignores via CSS)
    const collapsed = localStorage.getItem('arc.side.collapsed') === '1';
    document.body.classList.toggle('arc-side-collapsed', collapsed);

    // Sidebar shell
    let side = document.querySelector('aside.arc-side');
    if (!side) {
      side = document.createElement('aside');
      side.className = 'arc-side';
      side.setAttribute('aria-label', 'Primary');
      document.body.insertBefore(side, document.body.firstChild);
    }

    // Mobile backdrop
    let backdrop = document.querySelector('.arc-side-backdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.className = 'arc-side-backdrop';
      backdrop.addEventListener('click', () => document.body.classList.remove('arc-side-open'));
      document.body.appendChild(backdrop);
    }

    // Mobile hamburger trigger (top-left, only visible <900px)
    let hamb = document.querySelector('.arc-side-hamb');
    if (!hamb) {
      hamb = document.createElement('button');
      hamb.type = 'button';
      hamb.className = 'arc-side-hamb';
      hamb.setAttribute('aria-label', 'Open menu');
      hamb.innerHTML = '<svg width="16" height="12" viewBox="0 0 16 12" fill="none" aria-hidden="true"><path d="M1 1h14M1 6h14M1 11h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
      hamb.addEventListener('click', () => document.body.classList.add('arc-side-open'));
      document.body.appendChild(hamb);
    }

    const paint = () => {
      const sectionsHtml = SIDE_SECTIONS.map(sec => `
        <div class="arc-side-section">
          <div class="arc-side-sectitle">${sec.title}</div>
          ${sec.items.map(it => {
            const isActive = it.id === active;
            const cls = ['arc-side-item', isActive ? 'active' : '', it.soon ? 'soon' : ''].filter(Boolean).join(' ');
            const badge = it.badge
              ? `<span class="arc-side-badge ${it.badge.toLowerCase()}">${it.badge}</span>`
              : '';
            const inner = `
              <span class="arc-side-ico" aria-hidden="true">${it.icon}</span>
              <span class="arc-side-label">${it.label}</span>
              ${badge}`;
            if (it.soon) {
              return `<button type="button" class="${cls}" data-soon="${it.label}" title="${it.label} — Coming soon">${inner}</button>`;
            }
            const ext = it.external ? ' target="_blank" rel="noopener"' : '';
            return `<a class="${cls}" href="${it.href}"${ext} title="${it.label}">${inner}</a>`;
          }).join('')}
        </div>`).join('');

      side.innerHTML = `
        <div class="arc-side-head">
          <a class="arc-side-brand" href="/" aria-label="OneSet home">
            <img class="arc-side-logo" src="/assets/logos/wordmark-arcswap.png?v=2" alt="OneSet" width="138" height="30"/>
            <span class="arc-side-pill">TESTNET</span>
          </a>
          <button class="arc-side-toggle" type="button" aria-label="Toggle sidebar">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M9 3L5 7l4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
        <nav class="arc-side-nav">${sectionsHtml}</nav>
        <div class="arc-side-foot">
          <div class="arc-side-chain" title="Arc Testnet"><span class="dot"></span><span class="arc-side-chain-label">Arc Testnet</span></div>
          <button id="arc-wallet-btn" class="wallet-btn disconnected" title="Connect Wallet">Connect Wallet</button>
        </div>`;

      // Toggle (desktop collapse / expand)
      side.querySelector('.arc-side-toggle').addEventListener('click', () => {
        const isNow = document.body.classList.toggle('arc-side-collapsed');
        localStorage.setItem('arc.side.collapsed', isNow ? '1' : '0');
      });

      // Coming-soon items → toast feedback
      side.querySelectorAll('[data-soon]').forEach(btn => {
        btn.addEventListener('click', () => {
          const name = btn.dataset.soon;
          toast('', `${name} — Coming soon`, "It's on the roadmap. We'll announce when it ships.");
          document.body.classList.remove('arc-side-open');
        });
      });

      // Auto-close mobile drawer when a real link is tapped
      side.querySelectorAll('a.arc-side-item').forEach(a => {
        a.addEventListener('click', () => {
          if (window.innerWidth <= 900) document.body.classList.remove('arc-side-open');
        });
      });

      // Wallet button (same handler as top-nav variant)
      const wb = document.getElementById('arc-wallet-btn');
      if (wb) wb.onclick = onWalletClick;
      refreshWalletBtn();
    };

    paint();
    ARC.wallet.on(paint);
  }

  // ── BOOT ───────────────────────────────────────────────
  async function boot(activeTab) {
    renderAurora();
    renderCursor();
    renderNav(activeTab);
    await ARC.wallet.autoConnect().catch(() => null);
  }

  // App-shell variant: left sidebar + content area. Sets body.arc-app so
  // pages can style around the sidebar's reserved width.
  async function bootApp(activeTab) {
    renderAurora();
    renderCursor();
    document.body.classList.add('arc-app');
    renderSidebar(activeTab);
    await ARC.wallet.autoConnect().catch(() => null);
  }

  global.ArcUI = { boot, bootApp, renderNav, renderSidebar, toast, openModal, closeModal, confirm };
})(window);
