/**
 * member-center.js — NEON LOTUS TW
 * ─────────────────────────────────────────────────────────────────
 * 會員中心 modal:
 *   ① 個人資料編輯區 — 顯示名稱 / 電話 (隨時改) + 生日 (只能填一次)
 *   ② 等級進度條    — 距離下一階還差多少
 *   ③ 折抵金餘額 + 使用歷史 (from member_audit_log)
 *   ④ 歷史訂單列表 (from orders where member_id = me)
 *
 * 依賴:auth.js (window.AuthSystem)、auth-ui.js (modal/overlay 樣式)
 *
 * 暴露:window.MemberCenter.open()  /  .close()
 * ─────────────────────────────────────────────────────────────────
 */
'use strict';

(function () {
  /* 等級門檻 (累積消費 TWD)
   *   bronze   0 起跳
   *   silver   5,000
   *   gold     15,000
   *   diamond  30,000
   * Phase 2.2 可改成從 site_config 讀。 */
  const TIER_THRESHOLDS = {
    bronze:  0,
    silver:  5000,
    gold:    15000,
    diamond: 30000,
  };

  const TIER_LABELS = {
    bronze:  { emoji: '🥉', label: '銅卡',   next: 'silver'  },
    silver:  { emoji: '🥈', label: '銀卡',   next: 'gold'    },
    gold:    { emoji: '🥇', label: '金卡',   next: 'diamond' },
    diamond: { emoji: '💎', label: '鑽石卡', next: null      },
  };

  const STATUS_LABELS = {
    pending:   { emoji: '⏳', text: '處理中',   color: '#fbbf24' },
    paid:      { emoji: '✓',  text: '已付款',   color: '#4ade80' },
    shipped:   { emoji: '📦', text: '已出貨',   color: '#60a5fa' },
    delivered: { emoji: '🎉', text: '已送達',   color: '#4ade80' },
    cancelled: { emoji: '✕',  text: '已取消',   color: '#9ca3af' },
    refunded:  { emoji: '↩',  text: '已退款',   color: '#f87171' },
  };

  function fmtNT(n) {
    return Number(n || 0).toLocaleString('en-US');
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  let _modal = null;
  let _styled = false;

  function injectStyles() {
    if (_styled) return;
    _styled = true;
    const style = document.createElement('style');
    style.id = 'neon-mc-styles';
    style.textContent = `
      .neon-mc-modal {
        background: rgba(22,20,30,0.95);
        backdrop-filter: blur(24px);
        border: 1px solid rgba(192,132,252,0.22);
        border-radius: 14px;
        width: 100%; max-width: 560px;
        padding: 28px 24px 24px;
        color: #f5f4f0;
        position: relative;
        max-height: 90vh;
        overflow-y: auto;
      }
      .neon-mc-close {
        position: absolute; top: 12px; right: 12px;
        background: none; border: none; color: #9ca3af;
        font-size: 24px; cursor: pointer; width: 32px; height: 32px;
      }
      .neon-mc-close:hover { color: #f5f4f0; }

      .neon-mc-title {
        font-size: 20px; font-weight: 600; margin: 0 0 4px 0;
      }
      .neon-mc-subtitle {
        font-size: 12px; color: #9ca3af; margin: 0 0 20px 0;
      }

      .neon-mc-section {
        margin-bottom: 22px;
        padding: 16px;
        background: rgba(0,0,0,0.25);
        border: 1px solid rgba(192,132,252,0.15);
        border-radius: 10px;
      }
      .neon-mc-section-title {
        font-size: 13px;
        font-weight: 600;
        color: #c084fc;
        margin: 0 0 10px 0;
        letter-spacing: 0.5px;
      }

      .neon-mc-row {
        display: flex; align-items: center; gap: 8px;
        margin-bottom: 8px;
      }
      .neon-mc-row label {
        font-size: 12px; color: #9ca3af;
        min-width: 70px;
      }
      .neon-mc-row input {
        flex: 1;
        background: rgba(0,0,0,0.4);
        border: 1px solid rgba(192,132,252,0.22);
        color: #f5f4f0;
        padding: 8px 10px;
        border-radius: 6px;
        font-size: 13px;
        outline: none;
      }
      .neon-mc-row input:focus { border-color: #c084fc; }
      .neon-mc-row input:disabled {
        opacity: 0.55;
        cursor: not-allowed;
        background: rgba(0,0,0,0.2);
      }
      .neon-mc-row button {
        background: #a855f7;
        color: #fff;
        border: none;
        padding: 8px 14px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .neon-mc-row button:hover { background: #c084fc; }
      .neon-mc-row button:disabled { opacity: 0.5; cursor: not-allowed; }

      .neon-mc-hint {
        font-size: 11px; color: #9ca3af;
        margin: 4px 0 8px 78px;
        line-height: 1.5;
      }
      .neon-mc-hint.warning { color: #fbbf24; }

      .neon-mc-progress-wrap {
        margin-top: 10px;
      }
      .neon-mc-progress-bar {
        height: 8px;
        background: rgba(255,255,255,0.08);
        border-radius: 4px;
        overflow: hidden;
        margin: 8px 0;
      }
      .neon-mc-progress-fill {
        height: 100%;
        background: linear-gradient(90deg, #a855f7, #c084fc);
        transition: width 0.5s ease;
      }
      .neon-mc-progress-text {
        font-size: 12px;
        color: #9ca3af;
        margin-top: 4px;
      }

      .neon-mc-credit-balance {
        font-size: 24px; font-weight: 600;
        color: #c084fc;
        margin: 4px 0;
      }
      .neon-mc-credit-balance .currency {
        font-size: 13px; color: #9ca3af; font-weight: 400;
      }

      .neon-mc-history-list {
        margin-top: 8px;
      }
      .neon-mc-history-item {
        display: flex; align-items: center; gap: 10px;
        padding: 8px 0;
        border-bottom: 1px solid rgba(255,255,255,0.06);
        font-size: 12px;
      }
      .neon-mc-history-item:last-child { border-bottom: none; }
      .neon-mc-history-date { color: #9ca3af; min-width: 80px; }
      .neon-mc-history-amount { font-weight: 600; min-width: 64px; text-align: right; }
      .neon-mc-history-amount.pos { color: #4ade80; }
      .neon-mc-history-amount.neg { color: #f87171; }
      .neon-mc-history-reason { color: #d1d5db; flex: 1; }

      .neon-mc-order-list { margin-top: 6px; }
      .neon-mc-order-item {
        display: grid;
        grid-template-columns: 90px 1fr 90px 70px;
        gap: 8px;
        padding: 10px 0;
        border-bottom: 1px solid rgba(255,255,255,0.06);
        font-size: 12px;
        align-items: center;
      }
      .neon-mc-order-item:last-child { border-bottom: none; }
      .neon-mc-order-date { color: #9ca3af; font-size: 11px; }
      .neon-mc-order-number { color: #d1d5db; font-family: monospace; font-size: 11px; }
      .neon-mc-order-total { font-weight: 600; text-align: right; }
      .neon-mc-order-status { font-size: 11px; text-align: right; }

      .neon-mc-empty {
        text-align: center;
        color: #9ca3af;
        font-size: 12px;
        padding: 12px 0;
      }

      .neon-mc-msg {
        margin-top: 8px; padding: 8px 10px;
        border-radius: 6px; font-size: 12px;
      }
      .neon-mc-msg.success {
        background: rgba(74,222,128,0.10);
        color: #4ade80;
      }
      .neon-mc-msg.error {
        background: rgba(248,113,113,0.10);
        color: #f87171;
      }

      @media (max-width: 480px) {
        .neon-mc-order-item {
          grid-template-columns: 1fr 80px;
          grid-template-rows: auto auto;
        }
        .neon-mc-order-date,
        .neon-mc-order-status {
          grid-row: 2;
        }
        .neon-mc-order-number { grid-column: 1; }
        .neon-mc-order-total { grid-column: 2; grid-row: 1; }
      }
    `;
    document.head.appendChild(style);
  }

  /* ── 取得 supabase client (via AuthSystem) ── */
  function getSb() {
    return window.AuthSystem && window.AuthSystem._getClient
      ? window.AuthSystem._getClient()
      : null;
  }

  /* ── 開啟 modal ── */
  async function open() {
    injectStyles();
    if (_modal) return;

    if (!window.AuthSystem) {
      console.warn('[MemberCenter] AuthSystem 還沒載入');
      return;
    }
    const user = window.AuthSystem.getUser();
    let member = window.AuthSystem.getMember();
    if (!user) {
      alert('請先登入');
      return;
    }
    // 若 member 還沒抓到,等一次 fetchMember
    if (!member) {
      member = await window.AuthSystem.fetchMember();
    }
    if (!member) {
      alert('會員資料載入失敗,請重新整理後再試');
      return;
    }

    _modal = document.createElement('div');
    _modal.className = 'neon-auth-overlay'; // 重用 auth-ui.js 的覆蓋層樣式
    _modal.innerHTML = `
      <div class="neon-mc-modal" role="dialog">
        <button class="neon-mc-close" aria-label="關閉">×</button>
        <h2 class="neon-mc-title">會員中心</h2>
        <p class="neon-mc-subtitle">${user.email || ''}</p>

        <div class="neon-mc-section" data-section="profile">
          <h3 class="neon-mc-section-title">個人資料</h3>
          ${renderProfileForm(member)}
          <div class="neon-mc-msg" id="mc-profile-msg" style="display:none"></div>
        </div>

        <div class="neon-mc-section" data-section="tier">
          <h3 class="neon-mc-section-title">等級進度</h3>
          ${renderTierProgress(member)}
        </div>

        <div class="neon-mc-section" data-section="credit">
          <h3 class="neon-mc-section-title">折抵金</h3>
          <div class="neon-mc-credit-balance">
            <span class="currency">NT$</span> ${fmtNT(member.founding_credit_balance)}
          </div>
          <div class="neon-mc-history-list" id="mc-credit-history">
            <div class="neon-mc-empty">載入中…</div>
          </div>
        </div>

        <div class="neon-mc-section" data-section="orders">
          <h3 class="neon-mc-section-title">歷史訂單</h3>
          <div class="neon-mc-order-list" id="mc-order-list">
            <div class="neon-mc-empty">載入中…</div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(_modal);
    document.body.style.overflow = 'hidden';

    // 關閉
    _modal.querySelector('.neon-mc-close').addEventListener('click', close);
    _modal.addEventListener('click', (e) => {
      if (e.target === _modal) close();
    });

    // 綁定編輯按鈕
    bindEditHandlers(member);

    // 非同步抓資料
    loadCreditHistory(member.id);
    loadOrders(member.id);
  }

  function close() {
    if (!_modal) return;
    _modal.remove();
    _modal = null;
    document.body.style.overflow = '';
  }

  /* ── 個人資料表單 ── */
  function renderProfileForm(member) {
    const birthdayLocked = !!member.birthday;
    return `
      <div class="neon-mc-row">
        <label>顯示名稱</label>
        <input type="text" id="mc-name" value="${escapeHtml(member.display_name || '')}" maxlength="40" />
        <button data-action="save-name">更新</button>
      </div>
      <div class="neon-mc-row">
        <label>電話</label>
        <input type="tel" id="mc-phone" value="${escapeHtml(member.phone || '')}" placeholder="0912345678" maxlength="20" />
        <button data-action="save-phone">更新</button>
      </div>
      <div class="neon-mc-row">
        <label>生日</label>
        <input type="date" id="mc-birthday" value="${escapeHtml(member.birthday || '')}" ${birthdayLocked ? 'disabled' : ''} />
        ${birthdayLocked ? '' : '<button data-action="save-birthday">儲存</button>'}
      </div>
      <div class="neon-mc-hint ${birthdayLocked ? '' : 'warning'}">
        ${birthdayLocked
          ? '生日已鎖定,如需修改請透過 IG / Email 聯絡客服。'
          : '⚠️ 生日只能設定一次,儲存後將鎖定 — 確認正確再按儲存。'}
      </div>
    `;
  }

  /* ── 等級進度條 ── */
  function renderTierProgress(member) {
    const currentTier = member.tier || 'bronze';
    const tierInfo = TIER_LABELS[currentTier] || TIER_LABELS.bronze;
    const accSpend = Number(member.accumulated_spend || 0);
    const purchaseCount = Number(member.purchase_count || 0);

    const nextTier = tierInfo.next;
    if (!nextTier) {
      // 已達最高等級
      return `
        <div style="font-size:16px;font-weight:600;margin-bottom:6px">${tierInfo.emoji} ${tierInfo.label}</div>
        <div style="font-size:12px;color:#9ca3af">累積消費 NT$ ${fmtNT(accSpend)} · 消費次數 ${purchaseCount} 次</div>
        <div style="font-size:12px;color:#c084fc;margin-top:6px">🎉 已達最高等級,感謝您的支持</div>
      `;
    }

    const nextThreshold = TIER_THRESHOLDS[nextTier];
    const currentThreshold = TIER_THRESHOLDS[currentTier];
    const span = nextThreshold - currentThreshold;
    const progress = Math.min(100, Math.max(0, ((accSpend - currentThreshold) / span) * 100));
    const remaining = Math.max(0, nextThreshold - accSpend);
    const nextLabel = TIER_LABELS[nextTier];

    return `
      <div style="font-size:16px;font-weight:600;margin-bottom:2px">${tierInfo.emoji} ${tierInfo.label}</div>
      <div style="font-size:12px;color:#9ca3af">累積消費 NT$ ${fmtNT(accSpend)} · 消費次數 ${purchaseCount} 次</div>
      <div class="neon-mc-progress-wrap">
        <div class="neon-mc-progress-bar">
          <div class="neon-mc-progress-fill" style="width:${progress.toFixed(1)}%"></div>
        </div>
        <div class="neon-mc-progress-text">
          再累積 <strong style="color:#c084fc">NT$ ${fmtNT(remaining)}</strong>
          即可升 ${nextLabel.emoji} ${nextLabel.label}
        </div>
      </div>
    `;
  }

  /* ── 抓折抵金 audit log ── */
  async function loadCreditHistory(memberId) {
    const sb = getSb();
    if (!sb || !memberId) return;
    try {
      const { data, error } = await sb
        .from('member_audit_log')
        .select('created_at, delta, field, reason, ref_order_number')
        .eq('member_id', memberId)
        .eq('field', 'founding_credit_balance')
        .order('created_at', { ascending: false })
        .limit(20);

      const el = _modal && _modal.querySelector('#mc-credit-history');
      if (!el) return;

      if (error) {
        el.innerHTML = `<div class="neon-mc-empty">載入失敗 (${escapeHtml(error.message || '')})</div>`;
        return;
      }
      if (!data || !data.length) {
        el.innerHTML = '<div class="neon-mc-empty">尚無折抵金紀錄</div>';
        return;
      }
      el.innerHTML = data.map((row) => `
        <div class="neon-mc-history-item">
          <div class="neon-mc-history-date">${fmtDate(row.created_at)}</div>
          <div class="neon-mc-history-reason">${escapeHtml(row.reason || '')}</div>
          <div class="neon-mc-history-amount ${row.delta >= 0 ? 'pos' : 'neg'}">
            ${row.delta >= 0 ? '+' : ''}${fmtNT(row.delta)}
          </div>
        </div>
      `).join('');
    } catch (e) {
      console.warn('[MemberCenter] loadCreditHistory error', e);
    }
  }

  /* ── 抓歷史訂單 ── */
  async function loadOrders(memberId) {
    const sb = getSb();
    if (!sb || !memberId) return;
    try {
      const { data, error } = await sb
        .from('orders')
        .select('order_number, created_at, total, status, shipping_method')
        .eq('member_id', memberId)
        .order('created_at', { ascending: false })
        .limit(20);

      const el = _modal && _modal.querySelector('#mc-order-list');
      if (!el) return;

      if (error) {
        el.innerHTML = `<div class="neon-mc-empty">載入失敗 (${escapeHtml(error.message || '')})</div>`;
        return;
      }
      if (!data || !data.length) {
        el.innerHTML = '<div class="neon-mc-empty">尚無訂單紀錄</div>';
        return;
      }
      el.innerHTML = data.map((row) => {
        const status = STATUS_LABELS[row.status] || { emoji: '·', text: row.status || '', color: '#9ca3af' };
        return `
          <div class="neon-mc-order-item">
            <div class="neon-mc-order-date">${fmtDate(row.created_at)}</div>
            <div class="neon-mc-order-number">${escapeHtml(row.order_number || '')}</div>
            <div class="neon-mc-order-total">NT$ ${fmtNT(row.total)}</div>
            <div class="neon-mc-order-status" style="color:${status.color}">${status.emoji} ${status.text}</div>
          </div>
        `;
      }).join('');
    } catch (e) {
      console.warn('[MemberCenter] loadOrders error', e);
    }
  }

  /* ── 編輯儲存按鈕綁定 ── */
  function bindEditHandlers(member) {
    const buttons = _modal.querySelectorAll('[data-action]');
    buttons.forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        if (action === 'save-name')     await saveField('display_name', '#mc-name', '顯示名稱', btn);
        if (action === 'save-phone')    await saveField('phone', '#mc-phone', '電話', btn);
        if (action === 'save-birthday') await saveField('birthday', '#mc-birthday', '生日', btn, true);
      });
    });
  }

  async function saveField(field, inputSelector, fieldLabel, btn, isBirthday) {
    const sb = getSb();
    const user = window.AuthSystem.getUser();
    if (!sb || !user) return;

    const input = _modal.querySelector(inputSelector);
    const newValue = input.value.trim();
    const msgEl = _modal.querySelector('#mc-profile-msg');

    // 生日確認
    if (isBirthday) {
      if (!newValue) {
        showProfileMsg('請選擇日期', 'error');
        return;
      }
      const ok = window.confirm('生日設定後就會鎖定,之後要改要透過客服。\n確定要儲存 ' + newValue + ' 嗎?');
      if (!ok) return;
    }

    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = '...';

    try {
      const updateObj = {};
      updateObj[field] = newValue || null;

      const { error } = await sb
        .from('members')
        .update(updateObj)
        .eq('user_id', user.id);

      if (error) throw error;

      // 重新抓 member
      await window.AuthSystem.fetchMember();
      showProfileMsg(fieldLabel + ' 已更新 ✓', 'success');

      // 若是生日,鎖定 input + 移除按鈕 + 切換提示文字
      if (isBirthday) {
        input.disabled = true;
        btn.remove();
        const hint = _modal.querySelector('[data-section="profile"] .neon-mc-hint');
        if (hint) {
          hint.classList.remove('warning');
          hint.textContent = '生日已鎖定,如需修改請透過 IG / Email 聯絡客服。';
        }
      }
    } catch (e) {
      showProfileMsg('更新失敗:' + (e.message || e), 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  function showProfileMsg(text, kind) {
    const el = _modal && _modal.querySelector('#mc-profile-msg');
    if (!el) return;
    el.style.display = 'block';
    el.className = 'neon-mc-msg ' + kind;
    el.textContent = text;
    if (kind === 'success') {
      setTimeout(() => { if (el) el.style.display = 'none'; }, 3000);
    }
  }

  /* ── HTML escape (避免 XSS 在 innerHTML 插值) ── */
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ── Public API ── */
  window.MemberCenter = {
    open,
    close,
  };
})();
