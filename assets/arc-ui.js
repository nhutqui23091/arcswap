/* Oneliq shared UI widgets - navbar, toast, modal, cursor. Requires arc-core.js */
(function (global) {
  'use strict';
  if (!global.ARC) { console.error('[arc-ui] ARC core not loaded'); return; }
  const ARC = global.ARC;

  // ── NAVBAR ─────────────────────────────────────────────
  // Two chrome variants:
  //   1. boot()    - classic top nav. Marketing/landing pages (/, /blog).
  //   2. bootApp() - left sidebar app shell. Operator surfaces (/trade,
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
          <img class="logo-img" src="/assets/logos/wordmark-oneliq.png" alt="Oneliq" height="28"/>
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
    // Re-paint when wallet changes - gated tabs depend on the connected address
    ARC.wallet.on(paint);
  }

  function refreshWalletBtn() {
    const s = ARC.wallet.snapshot();
    ['arc-wallet-btn', 'arc-wallet-btn-mob'].forEach(id => {
      const btn = document.getElementById(id); if (!btn) return;
      if (s.connected) {
        btn.classList.remove('disconnected');
        btn.innerHTML = '<span class="dot"></span>Profile';
        btn.title = s.address;
      } else {
        btn.classList.add('disconnected');
        btn.textContent = 'Connect Wallet';
        btn.title = '';
      }
    });
  }

  async function onWalletClick() {
    const s = ARC.wallet.snapshot();
    if (s.connected) { openProfileModal(); return; }
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

  function loadQrCode(cb) {
    if (typeof QRCode !== 'undefined') { cb(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js';
    s.crossOrigin = 'anonymous';
    s.referrerPolicy = 'no-referrer';
    s.onload = cb;
    s.onerror = function() {};
    document.head.appendChild(s);
  }

  function openProfileModal() {
    const addr = ARC.wallet.address;
    const ck = ARC.wallet.chainKey || 'arc';
    const explorerUrl = ARC.CHAINS[ck]?.explorerAddr?.(addr) || '#';
    const savedX = (localStorage.getItem('oneliq_profile_x_' + addr.toLowerCase()) || '').replace(/^@/, '');
    const clientId = document.querySelector('meta[name="oneliq-discord-client-id"]')?.content || '';
    const redirectUri = document.querySelector('meta[name="oneliq-discord-redirect"]')?.content
      || (window.location.origin + '/auth/discord/callback');
    const escapedX = savedX.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

    openModal({
      title: 'Profile',
      body: `
        <div style="display:flex;flex-direction:column;gap:16px">
          <div>
            <div style="font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--muted);margin-bottom:6px">Address</div>
            <div style="padding:10px 12px;background:var(--surface);border:1px solid var(--border);border-radius:10px;font-family:var(--mono);font-size:12px;word-break:break-all;color:var(--text);line-height:1.55">${addr}</div>
            <div style="display:flex;gap:6px;margin-top:8px">
              <button id="pm-copy" style="flex:1;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--muted);font-size:12.5px;font-weight:600;cursor:pointer;font-family:var(--font);transition:all .15s">Copy</button>
              <a href="${explorerUrl}" target="_blank" rel="noopener" style="flex:1;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--muted);font-size:12.5px;font-weight:600;font-family:var(--font);text-align:center;text-decoration:none;display:block;transition:all .15s">Explorer</a>
            </div>
            <div id="pm-qr" style="display:flex;justify-content:center;margin-top:12px"></div>
          </div>
          <div id="pm-streak-row"></div>
          <div>
            <div style="font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--muted);margin-bottom:6px">Discord</div>
            <div id="pm-discord"><div style="font-size:13px;color:var(--muted)">Loading...</div></div>
          </div>
          <div>
            <div style="font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--muted);margin-bottom:6px">X / Twitter</div>
            <div style="display:flex;gap:8px">
              <input id="pm-x" type="text" placeholder="your_handle" maxlength="50" value="${escapedX}" style="flex:1;padding:9px 12px;border-radius:10px;background:var(--surface);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:13px;outline:none;transition:border .15s"/>
              <button id="pm-x-save" style="padding:9px 14px;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--muted);font-size:12.5px;font-weight:600;cursor:pointer;font-family:var(--font);transition:all .15s;white-space:nowrap">Save</button>
            </div>
            <div id="pm-x-hint" style="font-size:11px;margin-top:5px;min-height:15px"></div>
          </div>
          <button id="pm-disconnect" style="width:100%;padding:10px;border-radius:10px;border:1px solid rgba(255,85,119,.3);background:rgba(255,85,119,.06);color:#FF5577;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font);transition:all .15s">Disconnect Wallet</button>
        </div>`,
      onOpen: () => {
        // Copy address
        document.getElementById('pm-copy').onclick = () => {
          navigator.clipboard.writeText(addr).catch(() => {});
          toast('success', 'Copied');
        };
        // Disconnect
        document.getElementById('pm-disconnect').onclick = () => {
          ARC.wallet.disconnect(); closeModal(); toast('', 'Disconnected');
        };
        // X handle
        const xInp = document.getElementById('pm-x');
        const xHint = document.getElementById('pm-x-hint');
        const saveX = () => {
          const v = xInp.value.trim().replace(/^@/, '');
          xInp.value = v;
          localStorage.setItem('oneliq_profile_x_' + addr.toLowerCase(), v);
          xHint.textContent = v ? 'Saved.' : 'Cleared.';
          xHint.style.color = 'var(--arc4,#7BE495)';
          setTimeout(() => { xHint.textContent = ''; }, 2000);
        };
        document.getElementById('pm-x-save').onclick = saveX;
        xInp.addEventListener('keydown', e => { if (e.key === 'Enter') saveX(); });
        xInp.addEventListener('focus', () => { xInp.style.borderColor = 'var(--arc1)'; });
        xInp.addEventListener('blur', () => { xInp.style.borderColor = 'var(--border)'; });
        // Discord
        const discordEl = document.getElementById('pm-discord');
        function dcBtn() {
          return '<button id="pm-dc-btn" style="width:100%;padding:10px 16px;border-radius:10px;background:rgba(88,101,242,0.12);border:1px solid rgba(88,101,242,0.40);color:#7289DA;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font);transition:all .15s">Connect Discord</button>';
        }
        function dcWire() {
          const btn = document.getElementById('pm-dc-btn');
          if (!btn) return;
          btn.onclick = () => {
            if (!clientId) {
              toast('warn', 'Not configured', 'Add DISCORD_CLIENT_ID to Cloudflare Pages environment variables to enable Discord.');
              return;
            }
            window.location.href = 'https://discord.com/oauth2/authorize?client_id=' + encodeURIComponent(clientId)
              + '&redirect_uri=' + encodeURIComponent(redirectUri)
              + '&response_type=code&scope=identify&state=' + encodeURIComponent(addr.toLowerCase());
          };
        }
        // Streak row (async, non-blocking)
        fetch('/auth/gm?address=' + addr.toLowerCase())
          .then(r => r.ok ? r.json() : null)
          .then(gm => {
            const el = document.getElementById('pm-streak-row');
            if (!el) return;
            if (gm && gm.streak > 0) {
              el.innerHTML = '<a href="/gm" style="display:flex;align-items:center;gap:10px;padding:9px 12px;background:var(--surface);border:1px solid var(--border);border-radius:10px;text-decoration:none;margin-bottom:2px"><span style="font-size:18px">🔥</span><span style="font-size:14px;font-weight:600;color:var(--text)">' + gm.streak + ' day streak</span><span style="margin-left:auto;font-size:11px;color:var(--arc1)">GM</span></a>';
            } else {
              el.innerHTML = '<a href="/gm" style="display:flex;align-items:center;padding:9px 12px;background:var(--surface);border:1px solid var(--border);border-radius:10px;text-decoration:none;font-size:13px;color:var(--muted);margin-bottom:2px">No streak yet. Check in daily →</a>';
            }
          })
          .catch(() => {});
        fetch('/auth/profile/' + addr.toLowerCase())
          .then(r => r.ok ? r.json() : null)
          .then(profile => {
            if (profile && profile.discord_username) {
              discordEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;padding:9px 12px;background:var(--surface);border:1px solid var(--border);border-radius:10px"><span style="font-family:var(--mono);font-size:13px;color:var(--text)">' + (profile.discord_global_name || profile.discord_username) + '</span><button id="pm-dc-unlink" style="background:none;border:none;color:var(--muted);font-size:12px;cursor:pointer;font-family:var(--font);padding:2px 6px">Unlink</button></div>';
              document.getElementById('pm-dc-unlink').onclick = () => {
                fetch('/auth/profile/' + addr.toLowerCase(), { method: 'DELETE' }).catch(() => {});
                toast('', 'Discord unlinked');
                discordEl.innerHTML = dcBtn();
                dcWire();
              };
            } else {
              discordEl.innerHTML = dcBtn();
              dcWire();
            }
          })
          .catch(() => {
            discordEl.innerHTML = dcBtn();
            dcWire();
          });
        // QR code (lazy-loaded from CDN)
        const qrEl = document.getElementById('pm-qr');
        loadQrCode(() => {
          try {
            const canvas = document.createElement('canvas');
            qrEl.appendChild(canvas);
            QRCode.toCanvas(canvas, addr, { width: 128, margin: 1 }, err => {
              if (err) qrEl.innerHTML = '';
            });
          } catch (e) { qrEl.innerHTML = ''; }
        });
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
   * Styled confirmation dialog - replaces window.confirm() for security gates
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
          // Focus confirm by default - Enter accepts, Esc cancels.
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



  // ── SIDEBAR (app shell) ─────────────────────────────────
  // Used by operator surfaces (/history, future /trade /balance /agent).
  // Marketing pages keep the top nav via boot(). State persists via:
  //   localStorage 'arc.side.collapsed' = '1' | '0'   - desktop collapse
  //   body.arc-side-collapsed                          - applied class
  //   body.arc-side-open                               - mobile drawer open
  const svgClock = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-4px"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 16 14"/></svg>`;

  const SIDE_SECTIONS = [
    {
      title: 'Products',
      items: [
        { id: 'trade',     label: 'Trade',     icon: '⇄', href: '/trade'   },
        { id: 'balance',   label: 'Balance',   icon: '◈', href: '/balance' },
        { id: 'agent',     label: 'Agent',     icon: '∞', href: '/agent',   badge: 'NEW'  },
        { id: 'history',   label: 'History',   icon: svgClock, href: '/history', badge: 'NEW'  },
        { id: 'gm',        label: 'GM',        icon: '☕', href: '/gm', badge: 'NEW'  },
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
    if (!window._arcEscAdded) {
      window._arcEscAdded = true;
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape') document.body.classList.remove('arc-side-open');
      });
    }

    // Mobile hamburger trigger (top-left, only visible <900px)
    let hamb = document.querySelector('.arc-side-hamb');
    if (!hamb) {
      hamb = document.createElement('button');
      hamb.type = 'button';
      hamb.className = 'arc-side-hamb';
      hamb.setAttribute('aria-label', 'Open menu');
      hamb.innerHTML = '<svg width="16" height="12" viewBox="0 0 16 12" fill="none" aria-hidden="true"><path d="M1 1h14M1 6h14M1 11h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
      hamb.addEventListener('click', () => document.body.classList.toggle('arc-side-open'));
      document.body.appendChild(hamb);
    }

    // Mobile wallet CTA (top-right, mirrors hamburger - always visible on mobile)
    if (!document.getElementById('arc-wallet-btn-mob')) {
      const mobW = document.createElement('button');
      mobW.type = 'button';
      mobW.id = 'arc-wallet-btn-mob';
      mobW.className = 'wallet-btn disconnected arc-mob-wallet';
      mobW.textContent = 'Connect Wallet';
      mobW.onclick = onWalletClick;
      document.body.appendChild(mobW);
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
              return `<button type="button" class="${cls}" data-soon="${it.label}" title="${it.label}: Coming soon">${inner}</button>`;
            }
            const ext = it.external ? ' target="_blank" rel="noopener"' : '';
            return `<a class="${cls}" href="${it.href}"${ext} title="${it.label}">${inner}</a>`;
          }).join('')}
        </div>`).join('');

      side.innerHTML = `
        <div class="arc-side-head">
          <a class="arc-side-brand" href="/" aria-label="Oneliq home">
            <img class="arc-side-logo" src="/assets/logos/wordmark-oneliq.png" alt="Oneliq" height="30"/>
            <span class="arc-side-pill">TESTNET</span>
          </a>
          <button class="arc-side-toggle" type="button" aria-label="Toggle sidebar">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M9 3L5 7l4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <button class="arc-side-close" type="button" aria-label="Close menu">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 2l12 12M14 2L2 14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          </button>
        </div>
        <nav class="arc-side-nav">${sectionsHtml}</nav>
        <div class="arc-side-foot">
          <div class="arc-side-chain" title="Arc Testnet"><span class="dot"></span><span class="arc-side-chain-label">Arc Testnet</span></div>
          <button id="arc-wallet-btn" class="wallet-btn disconnected" title="Connect Wallet">Connect Wallet</button>
        </div>`;

      // Mobile close button
      const closeBtn = side.querySelector('.arc-side-close');
      if (closeBtn) closeBtn.addEventListener('click', () => document.body.classList.remove('arc-side-open'));

      // Toggle (desktop collapse / expand)
      side.querySelector('.arc-side-toggle').addEventListener('click', () => {
        const isNow = document.body.classList.toggle('arc-side-collapsed');
        localStorage.setItem('arc.side.collapsed', isNow ? '1' : '0');
      });

      // Coming-soon items → toast feedback
      side.querySelectorAll('[data-soon]').forEach(btn => {
        btn.addEventListener('click', () => {
          const name = btn.dataset.soon;
          toast('', `${name}: Coming soon`, "It's on the roadmap. We'll announce when it ships.");
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
    renderNav(activeTab);
    await ARC.wallet.autoConnect().catch(() => null);
  }

  // App-shell variant: left sidebar + content area. Sets body.arc-app so
  // pages can style around the sidebar's reserved width.
  async function bootApp(activeTab) {
    renderAurora();
    document.body.classList.add('arc-app');
    renderSidebar(activeTab);
    await ARC.wallet.autoConnect().catch(() => null);
    if (new URLSearchParams(window.location.search).get('discord_linked') === '1') {
      toast('success', 'Discord linked', 'Your Discord account is connected to this wallet.');
      const u = new URL(window.location.href);
      u.searchParams.delete('discord_linked');
      history.replaceState({}, '', u.toString());
    }
  }

  global.ArcUI = { boot, bootApp, renderNav, renderSidebar, toast, openModal, closeModal, confirm };
})(window);
