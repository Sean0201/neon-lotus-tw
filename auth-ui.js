/**
 * auth-ui.js — NEON LOTUS TW
 * ─────────────────────────────────────────────────────────────────
 * 登入 UI:nav 按鈕 + modal + 會員資訊 badge。
 * 依賴:auth.js (window.AuthSystem)
 *
 * 訪客結帳完全不受影響 — 沒登入也可以正常購物;登入是「可選的加值」。
 * ─────────────────────────────────────────────────────────────────
 */
'use strict';

(function () {
  /* ─── Feature flag ────────────────────────────────────────
   * Sean 還在設定 Supabase Auth providers (Google / Facebook / Email),
   * 在 provider 還沒接通之前,登入按鈕點下去會跳 "Invalid login provider"。
   * 暫時把整個 nav 登入 UI 隱藏 — 改成 true 即可重新啟用。
   * (modal API 仍然透過 window.AuthUI 暴露,僅 nav 按鈕被隱藏) */
  const AUTH_UI_ENABLED = true;

  /* 等級顯示對照表 — schema 用的 key 是 bronze/silver/gold/diamond/black
     (與 discount-engine.js DEFAULT_CONFIG.tier_thresholds 同步) */
  const TIER_LABELS = {
    bronze:  { emoji: '🥉', label: '銅卡' },
    silver:  { emoji: '🥈', label: '銀卡' },
    gold:    { emoji: '🥇', label: '金卡' },
    diamond: { emoji: '💎', label: '鑽石卡' },
    black:   { emoji: '🖤', label: '黑卡' },
  };

  /* 格式化 TWD 數字 — 1234 → "1,234" */
  function fmtNT(n) {
    const v = Number(n || 0);
    return v.toLocaleString('en-US');
  }

  const colors = {
    bg:       '#0a0a0f',
    panel:    'rgba(22,20,30,0.92)',
    border:   'rgba(192,132,252,0.22)',
    accent:   '#c084fc',
    accent2:  '#a855f7',
    white:    '#f5f4f0',
    muted:    '#9ca3af',
  };

  let _stylesInjected = false;
  function injectStyles() {
    if (_stylesInjected) return;
    _stylesInjected = true;
    const style = document.createElement('style');
    style.id = 'neon-auth-styles';
    style.textContent = `
      .neon-auth-btn {
        background: rgba(192,132,252,0.08);
        border: 1px solid ${colors.border};
        color: ${colors.white};
        padding: 6px 12px;
        border-radius: 6px;
        font-size: 13px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        transition: all 0.2s ease;
      }
      .neon-auth-btn:hover { background: rgba(192,132,252,0.18); border-color: ${colors.accent}; }

      .neon-auth-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border-radius: 6px;
        background: rgba(192,132,252,0.06);
        border: 1px solid ${colors.border};
        font-size: 12px;
        color: ${colors.white};
        cursor: pointer;
      }

      /* Modal */
      .neon-auth-overlay {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.6);
        backdrop-filter: blur(4px);
        z-index: 10000;
        display: flex; align-items: center; justify-content: center;
        padding: 16px;
      }
      .neon-auth-modal {
        background: ${colors.panel};
        backdrop-filter: blur(24px);
        border: 1px solid ${colors.border};
        border-radius: 14px;
        width: 100%; max-width: 420px;
        padding: 28px 24px;
        color: ${colors.white};
        position: relative;
        max-height: 90vh;
        overflow-y: auto;
      }
      .neon-auth-modal-close {
        position: absolute; top: 12px; right: 12px;
        background: none; border: none; color: ${colors.muted};
        font-size: 22px; cursor: pointer; width: 32px; height: 32px;
      }
      .neon-auth-modal-close:hover { color: ${colors.white}; }

      .neon-auth-title {
        font-size: 20px; font-weight: 600; margin: 0 0 6px 0;
      }
      .neon-auth-subtitle {
        font-size: 13px; color: ${colors.muted}; margin: 0 0 22px 0;
      }

      .neon-auth-provider-btn {
        display: flex; align-items: center; gap: 10px;
        width: 100%;
        background: rgba(255,255,255,0.04);
        border: 1px solid ${colors.border};
        color: ${colors.white};
        padding: 12px 14px;
        border-radius: 8px;
        font-size: 14px; font-weight: 500;
        cursor: pointer;
        margin-bottom: 10px;
        transition: all 0.2s ease;
      }
      .neon-auth-provider-btn:hover:not(:disabled) {
        background: rgba(192,132,252,0.10);
        border-color: ${colors.accent};
      }
      .neon-auth-provider-btn:disabled {
        opacity: 0.55; cursor: not-allowed;
      }
      .neon-auth-provider-btn img,
      .neon-auth-provider-btn svg {
        width: 20px; height: 20px;
      }

      .neon-auth-divider {
        display: flex; align-items: center;
        text-align: center;
        color: ${colors.muted}; font-size: 12px;
        margin: 18px 0 14px 0;
      }
      .neon-auth-divider::before,
      .neon-auth-divider::after {
        content: ''; flex: 1; height: 1px;
        background: ${colors.border};
      }
      .neon-auth-divider span { padding: 0 12px; }

      .neon-auth-email-form {
        display: flex; flex-direction: column; gap: 8px;
      }
      .neon-auth-email-input {
        width: 100%;
        background: rgba(0,0,0,0.35);
        border: 1px solid ${colors.border};
        color: ${colors.white};
        padding: 12px 14px;
        border-radius: 8px;
        font-size: 14px;
        outline: none;
        transition: border-color 0.2s ease;
      }
      .neon-auth-email-input:focus { border-color: ${colors.accent}; }

      .neon-auth-email-submit {
        background: ${colors.accent2};
        color: ${colors.white};
        border: none;
        padding: 12px 14px;
        border-radius: 8px;
        font-size: 14px; font-weight: 600;
        cursor: pointer;
        transition: background 0.2s ease;
      }
      .neon-auth-email-submit:hover { background: ${colors.accent}; }
      .neon-auth-email-submit:disabled { opacity: 0.55; cursor: not-allowed; }

      .neon-auth-msg {
        margin-top: 14px; padding: 10px 12px;
        border-radius: 8px;
        font-size: 13px;
      }
      .neon-auth-msg.success {
        background: rgba(74,222,128,0.10);
        border: 1px solid rgba(74,222,128,0.35);
        color: #4ade80;
      }
      .neon-auth-msg.error {
        background: rgba(248,113,113,0.10);
        border: 1px solid rgba(248,113,113,0.35);
        color: #f87171;
      }

      .neon-auth-footer {
        margin-top: 18px;
        font-size: 11px;
        color: ${colors.muted};
        line-height: 1.6;
        text-align: center;
      }

      /* Logged-in dropdown */
      .neon-auth-menu {
        position: absolute;
        top: calc(100% + 6px);
        right: 0;
        min-width: 220px;
        background: ${colors.panel};
        backdrop-filter: blur(24px);
        border: 1px solid ${colors.border};
        border-radius: 10px;
        padding: 8px;
        z-index: 9999;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      }
      .neon-auth-menu-item {
        display: block;
        width: 100%;
        text-align: left;
        background: none;
        border: none;
        color: ${colors.white};
        padding: 10px 12px;
        border-radius: 6px;
        font-size: 13px;
        cursor: pointer;
      }
      .neon-auth-menu-item:hover { background: rgba(192,132,252,0.10); }
      .neon-auth-menu-info {
        padding: 10px 12px;
        border-bottom: 1px solid ${colors.border};
        margin-bottom: 6px;
      }
      .neon-auth-menu-info-email { font-size: 12px; color: ${colors.muted}; }
      .neon-auth-menu-info-tier { font-size: 14px; margin-top: 4px; font-weight: 600; }
      .neon-auth-menu-info-spend { font-size: 12px; color: ${colors.muted}; margin-top: 2px; }
    `;
    document.head.appendChild(style);
  }

  // ── Modal ──────────────────────────────────────────
  let _modal = null;

  function openModal() {
    injectStyles();
    if (_modal) return;

    _modal = document.createElement('div');
    _modal.className = 'neon-auth-overlay';
    _modal.innerHTML = `
      <div class="neon-auth-modal" role="dialog">
        <button class="neon-auth-modal-close" aria-label="關閉">×</button>
        <h2 class="neon-auth-title">登入 / 註冊 NEON LOTUS</h2>
        <p class="neon-auth-subtitle">登入即可累積消費次數、生日月享 9 折優惠 🎂</p>

        <button class="neon-auth-provider-btn" data-provider="google">
          <svg viewBox="0 0 48 48"><path fill="#fbc02d" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20c11 0 19.7-8 19.7-20 0-1.2-.1-2.3-.3-3.5z"/><path fill="#e53935" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4caf50" d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.3C29.3 35 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1565c0" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.3 5.6l6.3 5.3C40.7 35 44 30 44 24c0-1.2-.1-2.4-.4-3.5z"/></svg>
          使用 Google 登入
        </button>

        <button class="neon-auth-provider-btn" data-provider="facebook" disabled title="即將推出">
          <svg viewBox="0 0 24 24"><path fill="#1877F2" d="M24 12.073C24 5.405 18.627 0 12 0 5.373 0 0 5.405 0 12.073c0 6.019 4.388 11.011 10.125 11.927v-8.437H7.078v-3.49h3.047V9.418c0-3.017 1.792-4.687 4.533-4.687 1.312 0 2.686.235 2.686.235v2.971h-1.513c-1.491 0-1.953.93-1.953 1.886v2.252h3.328l-.532 3.49h-2.796v8.437C19.612 23.084 24 18.092 24 12.073z"/></svg>
          使用 Facebook 登入(即將推出)
        </button>

        <button class="neon-auth-provider-btn" data-provider="line" disabled title="即將推出">
          <svg viewBox="0 0 24 24"><path fill="#06c755" d="M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63h2.386c.346 0 .627.285.627.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.104.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63.346 0 .628.285.628.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.282.629-.629.629M24 10.314C24 4.943 18.615.572 12 .572S0 4.943 0 10.314c0 4.811 4.27 8.842 10.035 9.608.391.082.923.258 1.058.59.12.301.079.766.038 1.08l-.164 1.02c-.045.301-.24 1.186 1.049.645 1.291-.539 6.916-4.078 9.436-6.975C23.176 14.393 24 12.458 24 10.314"/></svg>
          使用 LINE 登入(即將推出)
        </button>

        <div class="neon-auth-msg" id="neon-auth-msg" style="display:none"></div>

        <div class="neon-auth-footer">
          登入即同意 NEON LOTUS 個資使用條款。<br/>
          登入後可累積消費次數,並於生日月享 9 折優惠 🎂
        </div>
      </div>
    `;

    document.body.appendChild(_modal);
    document.body.style.overflow = 'hidden';

    // Event handlers
    const close = () => closeModal();
    _modal.querySelector('.neon-auth-modal-close').addEventListener('click', close);
    _modal.addEventListener('click', (e) => {
      if (e.target === _modal) close();
    });

    _modal.querySelectorAll('.neon-auth-provider-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        const provider = btn.dataset.provider;
        try {
          if (provider === 'google')   await window.AuthSystem.signInWithGoogle();
          if (provider === 'facebook') await window.AuthSystem.signInWithFacebook();
          if (provider === 'line')     await window.AuthSystem.signInWithLine();
        } catch (err) {
          showMsg(err.message || '登入失敗', 'error');
        }
      });
    });
  }

  function showMsg(text, kind) {
    if (!_modal) return;
    const el = _modal.querySelector('#neon-auth-msg');
    if (!el) return;
    el.style.display = 'block';
    el.className = `neon-auth-msg ${kind}`;
    el.textContent = text;
  }

  function closeModal() {
    if (!_modal) return;
    _modal.remove();
    _modal = null;
    document.body.style.overflow = '';
  }

  // ── Nav button (logged-out) / Badge (logged-in) ─────
  let _navContainer = null;
  let _menuOpen = false;

  function ensureNavContainer() {
    if (_navContainer && document.body.contains(_navContainer)) return _navContainer;
    _navContainer = document.createElement('div');
    _navContainer.id = 'neon-auth-nav';
    _navContainer.style.cssText = 'position:relative;display:inline-block;margin:0 10px;';

    // 嘗試掛到購物車圖示旁邊 — index.html 用 #nav-cart-icon
    const cartIcon = document.querySelector('#nav-cart-icon, .neon-cart-icon, #neon-cart-icon, .cart-icon');
    if (cartIcon && cartIcon.parentElement) {
      cartIcon.parentElement.insertBefore(_navContainer, cartIcon);
    } else {
      // Fallback: 固定右上角(往左挪避開 EN 切換按鈕)
      _navContainer.style.cssText = 'position:fixed;top:14px;right:120px;z-index:9000;';
      document.body.appendChild(_navContainer);
    }
    return _navContainer;
  }

  function renderNav(state) {
    injectStyles();
    const container = ensureNavContainer();
    const member = state.member;
    const user = state.user;

    if (!user) {
      container.innerHTML = `<button class="neon-auth-btn" id="neon-auth-login-btn">👤 登入</button>`;
      container.querySelector('#neon-auth-login-btn').addEventListener('click', openModal);
      return;
    }

    // Logged in — show badge + dropdown menu
    // badge 顯示「等級 emoji + 顯示名稱」
    const tierKey = (member && member.tier) || 'bronze';
    const tier = TIER_LABELS[tierKey] || TIER_LABELS.bronze;
    const displayName = (member && member.display_name) || (user.email || '').split('@')[0] || '會員';

    container.innerHTML = `
      <button class="neon-auth-badge" id="neon-auth-badge" title="${tier.label}">
        <span style="font-size:14px">${tier.emoji}</span>
        <span style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${displayName}</span>
      </button>
    `;
    const badge = container.querySelector('#neon-auth-badge');
    badge.addEventListener('click', () => toggleMenu(state));
  }

  function toggleMenu(state) {
    const container = ensureNavContainer();
    const existing = container.querySelector('.neon-auth-menu');
    if (existing) {
      existing.remove();
      _menuOpen = false;
      return;
    }

    const member = state.member;
    const user = state.user;
    const tierKey = (member && member.tier) || 'bronze';
    const tier = TIER_LABELS[tierKey] || TIER_LABELS.bronze;
    const displayName = (member && member.display_name) || (user.email || '').split('@')[0] || '會員';
    const accSpend = member ? Number(member.accumulated_spend || 0) : 0;
    const purchaseCount = member ? (member.purchase_count || 0) : 0;
    const creditBalance = member ? Number(member.founding_credit_balance || 0) : 0;
    const phone = (member && member.phone) || '';
    const birthday = (member && member.birthday) || '';

    const menu = document.createElement('div');
    menu.className = 'neon-auth-menu';
    menu.innerHTML = `
      <div class="neon-auth-menu-info">
        <div style="font-size:14px;font-weight:600;margin-bottom:4px">${tier.emoji} ${displayName}</div>
        <div class="neon-auth-menu-info-tier">${tier.label}</div>
        <div class="neon-auth-menu-info-spend">累積消費 NT$ ${fmtNT(accSpend)}</div>
        <div class="neon-auth-menu-info-spend">消費次數 ${purchaseCount} 次</div>
        <div class="neon-auth-menu-info-spend">折抵金 NT$ ${fmtNT(creditBalance)}</div>
        <div class="neon-auth-menu-info-spend">電話 ${phone || '尚未填寫'}</div>
        <div class="neon-auth-menu-info-spend">生日 ${birthday || '尚未設定'}</div>
      </div>
      <button class="neon-auth-menu-item" data-action="profile">會員中心</button>
      <button class="neon-auth-menu-item" data-action="logout">登出</button>
    `;
    container.appendChild(menu);
    _menuOpen = true;

    // 「會員中心」按鈕 — 開啟 MemberCenter modal (member-center.js)
    const profileBtn = menu.querySelector('[data-action="profile"]');
    if (profileBtn) {
      profileBtn.addEventListener('click', () => {
        // 先把 dropdown 關掉
        menu.remove();
        _menuOpen = false;
        if (window.MemberCenter && typeof window.MemberCenter.open === 'function') {
          window.MemberCenter.open();
        } else {
          alert('會員中心載入中,請稍候再試 🙏');
        }
      });
    }

    menu.querySelector('[data-action="logout"]').addEventListener('click', async () => {
      await window.AuthSystem.signOut();
      menu.remove();
      _menuOpen = false;
    });

    // Click-outside to close
    const onClickAway = (e) => {
      if (!container.contains(e.target)) {
        menu.remove();
        _menuOpen = false;
        document.removeEventListener('click', onClickAway);
      }
    };
    setTimeout(() => document.addEventListener('click', onClickAway), 50);
  }

  // ── Boot ────────────────────────────────────────────
  function boot() {
    // Feature flag: 還在設定 provider 時不顯示登入按鈕
    if (!AUTH_UI_ENABLED) {
      console.log('[AuthUI] Disabled (AUTH_UI_ENABLED=false). Modal API 仍可用: window.AuthUI.openModal()');
      return;
    }
    if (!window.AuthSystem) {
      setTimeout(boot, 100);
      return;
    }
    window.AuthSystem.init().then(() => {
      window.AuthSystem.onAuthChange((state) => {
        renderNav(state);
      });
    });
  }

  // 暴露給其他模組(購物車 / 結帳)使用
  window.AuthUI = {
    openModal,
    closeModal,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
