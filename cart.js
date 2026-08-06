/**
 * cart.js — NEON LOTUS TW
 * ─────────────────────────────────────────────────────────────────
 * Complete e-commerce cart + checkout system
 *
 * Features:
 * - localStorage-based cart state
 * - Cart drawer UI (slide-in from right)
 * - Size + shipping method selection modal
 * - Checkout page with customer form
 * - Order confirmation page
 * - Supabase integration for order persistence
 *
 * Exposes:
 * - window.CartSystem.{add,remove,update,get,clear,getCount,getTotal}
 * - window.renderCartIcon()
 * - window.renderAddToCartButton(product)
 * ─────────────────────────────────────────────────────────────────
 */

'use strict';

(function() {
  // ─────────────────────────────────────────────────────────────────
  // CONFIG & CONSTANTS
  // ─────────────────────────────────────────────────────────────────

  const CART_KEY = 'NEON_LOTUS_CART';
  const USE_CREDIT_KEY = 'NEON_LOTUS_USE_CREDIT';  // Phase 2.2 — 客戶是否使用折抵金 (預設 true)
  const LINE_OFFICIAL = '@590eckna';
  const LINE_URL = 'https://line.me/R/ti/p/@590eckna';

  // ───────────────────────────────────────────────────────────────
  // 折扣 — Phase 2.2 (五階等級 + 雙軌滿額 + 生日 + 折抵金 + 樓地板)
  // ───────────────────────────────────────────────────────────────
  // 折扣計算全部移到 window.DiscountEngine (discount-engine.js),
  // 是前端與後端共用的單一信任來源 (lib/discount.js 是同一份 Node 移植版)。
  // 此處只留下 SHIPPING_GROUP_LABELS,給 UI 顯示「親自帶回 / 國際運費」之類的標籤用。
  const SHIPPING_GROUP_LABELS = {
    shipping:  '國際運費',
    carryback: '親自帶回',
    default:   '一般出貨',
  };

  // Color scheme (matches main site)
  const colors = {
    black: '#0a0a0f',
    white: '#f5f4f0',
    accent: '#c084fc',
    accent2: '#a855f7',
    grey: '#16141e',
    lightgrey: '#9ca3af',
    border: 'rgba(192,132,252,0.18)',
    glassBg: 'rgba(22,20,30,0.65)',
    glassBorder: 'rgba(192,132,252,0.12)',
  };

  // ─────────────────────────────────────────────────────────────────
  // CART STATE MANAGEMENT
  // ─────────────────────────────────────────────────────────────────

  const CartState = {
    load() {
      try {
        const raw = localStorage.getItem(CART_KEY);
        return raw ? JSON.parse(raw) : [];
      } catch (e) {
        console.warn('[CartSystem] Failed to load cart:', e);
        return [];
      }
    },

    save(items) {
      try {
        localStorage.setItem(CART_KEY, JSON.stringify(items));
      } catch (e) {
        console.warn('[CartSystem] Failed to save cart:', e);
      }
    },

    /* 解析商品圖片 — 只收 http 開頭的網址 (與 main.js 商品卡片一致)。
       資料庫 cover_image 可能存本地相對路徑,部署後不存在會 404。 */
    resolveImageUrl(product) {
      const httpOnly = (u) => (typeof u === 'string' && u.startsWith('http')) ? u : '';
      const gallery = Array.isArray(product.images?.gallery) ? product.images.gallery : [];
      const fromGallery = gallery.map(g => httpOnly(g?.original_url || g?.url)).find(Boolean) || '';
      return fromGallery
        || httpOnly(product.original_cover_url)
        || httpOnly(product.images?.cover)
        || httpOnly(product.cover_image)
        || '';
    },

    add(product, size, shippingMethod) {
      const items = this.load();
      // Find unit_price from product.price (shipping_method dependent)
      let unit_price = 0;
      if (shippingMethod === 'shipping' && product.price?.twd_shipping) {
        unit_price = product.price.twd_shipping;
      } else if (shippingMethod === 'carryback' && product.price?.twd_carryback) {
        unit_price = product.price.twd_carryback;
      } else {
        // Fallback
        unit_price = product.price?.twd_shipping || product.price?.twd_carryback || 0;
      }

      const item = {
        product_id: product.id,
        product_name: product.name,
        brand_id: product.brand_id,
        size: size || null,
        quantity: 1,
        unit_price,
        shipping_method: shippingMethod,
        note: '',
        image_url: this.resolveImageUrl(product),
        // 品牌方特價旗標 (migration 014) — 不享會員折扣 (tier/birthday/bulk),但入會折抵金可用
        is_promo: !!product.is_promo,
        promo_note: product.promo_note || '',
      };

      items.push(item);
      this.save(items);
      return items;
    },

    /* Update an arbitrary set of fields on a cart item.
       If shipping_method is changed, recalculates unit_price from the
       referenced product (looked up via window.findProductById). */
    updateField(index, patch) {
      const items = this.load();
      if (!items[index]) return items;
      const next = { ...items[index], ...patch };
      if (patch.shipping_method && patch.shipping_method !== items[index].shipping_method) {
        const prod = (typeof window !== 'undefined' && window.findProductById)
          ? window.findProductById(items[index].product_id) : null;
        if (prod && prod.price) {
          if (patch.shipping_method === 'shipping' && prod.price.twd_shipping) {
            next.unit_price = prod.price.twd_shipping;
          } else if (patch.shipping_method === 'carryback' && prod.price.twd_carryback) {
            next.unit_price = prod.price.twd_carryback;
          }
        }
      }
      items[index] = next;
      this.save(items);
      return items;
    },

    remove(index) {
      const items = this.load();
      items.splice(index, 1);
      this.save(items);
      return items;
    },

    update(index, qty) {
      const items = this.load();
      if (qty <= 0) {
        items.splice(index, 1);
      } else {
        items[index].quantity = qty;
      }
      this.save(items);
      return items;
    },

    clear() {
      localStorage.removeItem(CART_KEY);
      return [];
    },

    get() {
      return this.load();
    },

    getCount() {
      return this.load().reduce((sum, item) => sum + (item.quantity || 0), 0);
    },

    getTotal() {
      return this.load().reduce(
        (sum, item) => sum + ((item.unit_price || 0) * (item.quantity || 1)),
        0
      );
    },

    // ── 折扣支援 (Phase 2.2 — DiscountEngine 接管) ──────────
    // Group cart items by shipping_method, returning
    // { [shipping_method]: [items] }.
    groupByShipping() {
      const items = this.load();
      const groups = {};
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const key = it.shipping_method || 'default';
        if (!groups[key]) groups[key] = [];
        groups[key].push(it);
      }
      return groups;
    },

    // 取得目前登入會員 (沒登入 = null)。若 AuthSystem 還沒初始化也回 null。
    _getMember() {
      try {
        return (window.AuthSystem && typeof window.AuthSystem.getMember === 'function')
          ? (window.AuthSystem.getMember() || null)
          : null;
      } catch { return null; }
    },

    /**
     * 折抵金開關 — 客戶可在購物車 / 結帳頁勾選是否使用註冊禮金折抵。
     * 預設 true (保留舊行為:有禮金就自動扣),沒勾就跳過折抵步驟。
     * 用 localStorage 持久化,避免重新整理就重置造成體驗不一致。
     */
    getUseCredit() {
      try {
        const v = localStorage.getItem(USE_CREDIT_KEY);
        return v === null ? true : v !== 'false';   // 預設 true
      } catch { return true; }
    },
    setUseCredit(use) {
      try { localStorage.setItem(USE_CREDIT_KEY, use ? 'true' : 'false'); } catch {}
    },

    /**
     * 完整折扣計算結果 — 委派給 DiscountEngine。
     * 若 DiscountEngine 還沒載入,使用內建 fallback (純加總,沒折扣)。
     */
    getDiscountResult() {
      const items = this.load();
      if (window.DiscountEngine && typeof window.DiscountEngine.computeCart === 'function') {
        return window.DiscountEngine.computeCart({
          items,
          member: this._getMember(),
          useCredit: this.getUseCredit(),
          // migration 015 — 品牌活動促銷。engine 內部會 pre-process items
          // 標記+改單價,is_active=false 的 row 已被 supabase-client 過濾掉。
          brandPromos: (typeof window !== 'undefined' && Array.isArray(window.BRAND_PROMOS))
            ? window.BRAND_PROMOS
            : [],
        });
      }
      // Fallback — 引擎沒載入,純加總
      const raw = items.reduce((s, it) => s + ((it.unit_price || 0) * (it.quantity || 1)), 0);
      return {
        raw_subtotal: raw,
        tier_key: 'bronze', tier_rate: 1.0, tier_eligible: false,
        groups: { carryback: { raw: 0, after_tier: 0, after_birthday: 0, bulk_discount: 0, after_bulk: 0 },
                  shipping:  { raw: 0, after_tier: 0, after_birthday: 0, bulk_discount: 0, after_bulk: 0 } },
        tier_discount: 0,
        birthday_eligible: false, birthday_discount: 0,
        bulk_eligible: false, bulk_discount_total: 0,
        credit_balance: 0, credit_used: 0,
        floor_rate: 0.75, floor_amount: 0, floor_clamped: false, floor_refund: 0,
        subtotal_after_tier: raw, subtotal_after_birthday: raw,
        subtotal_after_bulk: raw, subtotal_after_credit: raw,
        final_subtotal: raw,
        total_savings: 0,
      };
    },

    // ── 舊 API 兼容 (footer / order-insert 內仍用這些名字) ──
    // Returns per-shipping-group breakdown 用於 UI 顯示分軌小計。
    // 特價品 (is_promo=true) 不參與折扣,在 groups 內單獨列為 promo_items + promo_subtotal。
    getDiscountBreakdown() {
      const result = this.getDiscountResult();
      const groups = this.groupByShipping();
      return Object.keys(groups).map((sm) => {
        const allItems = groups[sm];
        // 分流 — regular 走折扣 pipeline,promo 走原價
        const regularItems = allItems.filter(it => !it.is_promo);
        const promoItems   = allItems.filter(it => !!it.is_promo);
        const regularSubtotal = regularItems.reduce(
          (s, it) => s + ((it.unit_price || 0) * (it.quantity || 1)),
          0
        );
        const promoSubtotal = promoItems.reduce(
          (s, it) => s + ((it.unit_price || 0) * (it.quantity || 1)),
          0
        );
        const gKey = (sm === 'carryback') ? 'carryback' : 'shipping';
        const g = result.groups[gKey] || { after_tier: regularSubtotal, after_birthday: regularSubtotal, bulk_discount: 0, after_bulk: regularSubtotal };
        // 升下一階提示 — 用 regular 部分 (after_birthday) 判定,promo 不計入門檻
        let nextRung = null;
        if (window.DiscountEngine && typeof window.DiscountEngine.nextBulkRung === 'function' && result.bulk_eligible) {
          nextRung = window.DiscountEngine.nextBulkRung(gKey, g.after_birthday);
        }
        return {
          shipping_method: sm,
          items: allItems,                    // 全部 line items (UI 列出用)
          regular_items: regularItems,        // 折扣計算用
          promo_items:   promoItems,          // 特價品 (UI 加標籤用)
          subtotal:        regularSubtotal,   // 此組正常品小計 (折扣分母)
          promo_subtotal:  promoSubtotal,     // 此組特價品原價合計
          after_tier:      g.after_tier,
          after_birthday:  g.after_birthday,
          bulk_discount:   g.bulk_discount,
          total:           g.after_bulk + promoSubtotal,  // 此組折後總額 (regular 折完 + promo 原價)
          discount:        regularSubtotal - g.after_bulk,
          nextRung,                           // {threshold, discount, gap} or null
        };
      });
    },

    getRawSubtotal()        { return this.getTotal(); },
    getDiscountedSubtotal() { return this.getDiscountResult().final_subtotal; },
    getTotalDiscount()      { return this.getDiscountResult().total_savings; },
  };

  // ─────────────────────────────────────────────────────────────────
  // INJECT STYLES
  // ─────────────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById('neon-lotus-cart-styles')) return;

    const style = document.createElement('style');
    style.id = 'neon-lotus-cart-styles';
    style.textContent = `
      /* Cart Drawer */
      .neon-cart-drawer {
        position: fixed;
        right: 0;
        top: 0;
        bottom: 0;
        width: 100%;
        max-width: 450px;
        background: ${colors.glassBg};
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border-left: 1px solid ${colors.glassBorder};
        z-index: 9999;
        display: flex;
        flex-direction: column;
        transform: translateX(100%);
        transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        overflow-y: auto;
        box-shadow: -8px 0 32px rgba(0, 0, 0, 0.4);
      }

      .neon-cart-drawer.open {
        transform: translateX(0);
      }

      .neon-cart-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        backdrop-filter: blur(2px);
        z-index: 9998;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.3s ease;
      }

      .neon-cart-overlay.open {
        opacity: 1;
        pointer-events: auto;
      }

      .neon-cart-header {
        padding: 20px;
        border-bottom: 1px solid ${colors.border};
        display: flex;
        justify-content: space-between;
        align-items: center;
      }

      .neon-cart-title {
        font-size: 18px;
        font-weight: 600;
        color: ${colors.white};
      }

      .neon-cart-close {
        background: none;
        border: none;
        color: ${colors.white};
        cursor: pointer;
        font-size: 24px;
        padding: 0;
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: color 0.2s ease;
      }

      .neon-cart-close:hover {
        color: ${colors.accent};
      }

      .neon-cart-content {
        flex: 1;
        overflow-y: auto;
        padding: 16px;
      }

      .neon-cart-empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 300px;
        color: ${colors.lightgrey};
        text-align: center;
      }

      .neon-cart-empty-icon {
        font-size: 48px;
        margin-bottom: 16px;
        opacity: 0.5;
      }

      .neon-cart-item {
        display: flex;
        gap: 12px;
        padding: 12px;
        border: 1px solid ${colors.border};
        border-radius: 8px;
        margin-bottom: 12px;
        background: rgba(255, 255, 255, 0.02);
        transition: border-color 0.2s ease;
      }

      .neon-cart-item:hover {
        border-color: ${colors.accent};
      }

      .neon-cart-item-image {
        width: 80px;
        height: 80px;
        border-radius: 6px;
        overflow: hidden;
        flex-shrink: 0;
        background: ${colors.grey};
      }

      .neon-cart-item-image img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      .neon-cart-item-details {
        flex: 1;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      }

      .neon-cart-item-name {
        font-size: 14px;
        font-weight: 600;
        color: ${colors.white};
        line-height: 1.3;
      }

      .neon-cart-item-meta {
        font-size: 12px;
        color: ${colors.lightgrey};
        margin-top: 4px;
      }

      .neon-cart-item-price {
        font-size: 13px;
        font-weight: 600;
        color: ${colors.accent};
      }

      .neon-cart-item-qty {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 8px;
      }

      .neon-cart-qty-btn {
        background: ${colors.grey};
        border: 1px solid ${colors.border};
        color: ${colors.white};
        width: 24px;
        height: 24px;
        border-radius: 4px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        transition: all 0.2s ease;
      }

      .neon-cart-qty-btn:hover {
        background: ${colors.accent};
        border-color: ${colors.accent};
      }

      .neon-cart-qty-display {
        min-width: 20px;
        text-align: center;
        font-size: 12px;
        color: ${colors.white};
      }

      .neon-cart-item-remove {
        color: ${colors.lightgrey};
        cursor: pointer;
        font-size: 12px;
        padding: 2px 4px;
        transition: color 0.2s ease;
      }

      .neon-cart-item-remove:hover {
        color: #ff6b6b;
      }

      /* ── Editable fields per cart item ── */
      .neon-cart-edit-row {
        display: flex;
        gap: 6px;
        margin-top: 6px;
        flex-wrap: wrap;
      }
      .neon-cart-edit-row .neon-cart-edit-field {
        flex: 1;
        min-width: 0;
      }
      .neon-cart-edit-label {
        display: block;
        font-size: 10px;
        color: ${colors.lightgrey};
        letter-spacing: 0.05em;
        margin-bottom: 2px;
        text-transform: uppercase;
      }
      .neon-cart-edit-select,
      .neon-cart-edit-note {
        width: 100%;
        background: ${colors.grey};
        border: 1px solid ${colors.border};
        color: ${colors.white};
        font-size: 12px;
        padding: 5px 8px;
        border-radius: 4px;
        font-family: inherit;
        outline: none;
        transition: border-color 0.2s ease;
        box-sizing: border-box;
      }
      .neon-cart-edit-select:focus,
      .neon-cart-edit-note:focus {
        border-color: ${colors.accent};
      }
      .neon-cart-edit-note {
        resize: vertical;
        min-height: 28px;
        max-height: 80px;
        line-height: 1.4;
      }
      .neon-cart-edit-note::placeholder {
        color: rgba(255,255,255,0.3);
      }

      .neon-cart-footer {
        padding: 16px;
        border-top: 1px solid ${colors.border};
        background: rgba(255, 255, 255, 0.01);
      }

      .neon-cart-subtotal {
        display: flex;
        justify-content: space-between;
        margin-bottom: 16px;
        font-size: 14px;
      }

      .neon-cart-subtotal-label {
        color: ${colors.lightgrey};
      }

      .neon-cart-subtotal-value {
        color: ${colors.accent};
        font-weight: 600;
      }

      .neon-cart-actions {
        display: flex;
        gap: 8px;
      }

      .neon-cart-btn {
        flex: 1;
        padding: 12px 16px;
        border-radius: 6px;
        border: none;
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
        transition: all 0.2s ease;
      }

      .neon-cart-btn-checkout {
        background: linear-gradient(135deg, #f472b6, #a855f7);
        color: white;
      }

      .neon-cart-btn-checkout:hover {
        box-shadow: 0 0 20px rgba(168, 85, 247, 0.4);
        transform: translateY(-2px);
      }

      .neon-cart-btn-continue {
        background: transparent;
        color: ${colors.accent};
        border: 1px solid ${colors.accent};
      }

      .neon-cart-btn-continue:hover {
        background: rgba(192, 132, 252, 0.1);
      }

      /* Cart Icon Badge */
      .neon-cart-icon-wrapper {
        position: relative;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .neon-cart-badge {
        position: absolute;
        top: -8px;
        right: -8px;
        background: ${colors.accent};
        color: ${colors.black};
        border-radius: 50%;
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: 700;
        animation: badgePulse 0.3s ease;
      }

      @keyframes badgePulse {
        0% { transform: scale(0.8); opacity: 0; }
        50% { transform: scale(1.15); }
        100% { transform: scale(1); opacity: 1; }
      }

      /* Size/Shipping Selection Modal */
      .neon-modal-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.6);
        backdrop-filter: blur(4px);
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s ease;
      }

      .neon-modal-overlay.open {
        opacity: 1;
        pointer-events: auto;
      }

      .neon-modal {
        background: ${colors.glassBg};
        border: 1px solid ${colors.glassBorder};
        border-radius: 12px;
        padding: 32px;
        max-width: 400px;
        width: 90%;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
      }

      .neon-modal-title {
        font-size: 18px;
        font-weight: 600;
        color: ${colors.white};
        margin-bottom: 20px;
      }

      .neon-modal-section {
        margin-bottom: 20px;
      }

      .neon-modal-label {
        font-size: 13px;
        color: ${colors.lightgrey};
        margin-bottom: 8px;
        display: block;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .neon-size-group,
      .neon-shipping-group {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .neon-size-btn,
      .neon-shipping-btn {
        flex: 1;
        min-width: 80px;
        padding: 10px 12px;
        border: 1px solid ${colors.border};
        background: transparent;
        color: ${colors.white};
        border-radius: 6px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 500;
        transition: all 0.2s ease;
      }

      .neon-size-btn:hover:not(:disabled),
      .neon-shipping-btn:hover:not(:disabled) {
        border-color: ${colors.accent};
        color: ${colors.accent};
      }

      .neon-size-btn.active,
      .neon-shipping-btn.active {
        background: ${colors.accent};
        border-color: ${colors.accent};
        color: ${colors.black};
      }

      .neon-size-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      .neon-modal-actions {
        display: flex;
        gap: 12px;
        margin-top: 24px;
      }

      .neon-modal-btn {
        flex: 1;
        padding: 12px 16px;
        border-radius: 6px;
        border: none;
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
        transition: all 0.2s ease;
      }

      .neon-modal-btn-confirm {
        background: linear-gradient(135deg, #f472b6, #a855f7);
        color: white;
      }

      .neon-modal-btn-confirm:hover:not(:disabled) {
        box-shadow: 0 0 20px rgba(168, 85, 247, 0.4);
      }

      .neon-modal-btn-confirm:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .neon-modal-btn-cancel {
        background: transparent;
        border: 1px solid ${colors.border};
        color: ${colors.white};
      }

      .neon-modal-btn-cancel:hover {
        border-color: ${colors.accent};
        color: ${colors.accent};
      }

      /* Checkout Page */
      .neon-checkout-page {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        overflow-y: auto;
        z-index: 10000;
        background: ${colors.black};
        color: ${colors.white};
        padding-bottom: 40px;
      }

      .neon-checkout-header {
        position: relative;
        padding: 40px 20px;
        text-align: center;
        border-bottom: 1px solid ${colors.border};
      }

      .neon-checkout-title {
        font-size: 32px;
        font-weight: 700;
        margin-bottom: 8px;
      }

      .neon-checkout-container {
        max-width: 900px;
        margin: 0 auto;
        padding: 40px 20px;
      }

      .neon-checkout-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 40px;
      }

      @media (max-width: 768px) {
        .neon-checkout-grid {
          grid-template-columns: 1fr;
          gap: 32px;
        }
      }

      .neon-checkout-form-section {
        display: flex;
        flex-direction: column;
        gap: 24px;
      }

      .neon-checkout-form-group {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .neon-checkout-form-label {
        font-size: 13px;
        color: ${colors.lightgrey};
        text-transform: uppercase;
        letter-spacing: 0.5px;
        font-weight: 600;
      }

      .neon-checkout-form-input,
      .neon-checkout-form-textarea {
        background: ${colors.grey};
        border: 1px solid ${colors.border};
        color: ${colors.white};
        padding: 12px 16px;
        border-radius: 6px;
        font-size: 14px;
        font-family: inherit;
        transition: border-color 0.2s ease;
      }

      .neon-checkout-form-input:focus,
      .neon-checkout-form-textarea:focus {
        outline: none;
        border-color: ${colors.accent};
        box-shadow: 0 0 12px rgba(192, 132, 252, 0.2);
      }

      .neon-checkout-form-textarea {
        resize: vertical;
        min-height: 100px;
      }

      .neon-shipping-toggle {
        display: flex;
        gap: 12px;
        margin-top: 8px;
      }

      .neon-shipping-option {
        flex: 1;
        padding: 12px 16px;
        border: 1px solid ${colors.border};
        background: transparent;
        color: ${colors.white};
        border-radius: 6px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
        transition: all 0.2s ease;
      }

      .neon-shipping-option:hover {
        border-color: ${colors.accent};
      }

      .neon-shipping-option.active {
        background: ${colors.accent};
        border-color: ${colors.accent};
        color: ${colors.black};
      }

      /* CVS Brand Selector */
      .neon-cvs-brands {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-top: 8px;
      }

      .neon-cvs-brand-btn {
        padding: 10px 12px;
        border: 1px solid ${colors.border};
        background: transparent;
        color: ${colors.white};
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
        transition: all 0.2s ease;
        text-align: center;
      }

      .neon-cvs-brand-btn:hover {
        border-color: ${colors.accent};
        color: ${colors.accent};
      }

      .neon-cvs-brand-btn.active {
        background: ${colors.accent};
        border-color: ${colors.accent};
        color: ${colors.black};
      }

      /* Store Picker */
      .neon-store-picker {
        margin-top: 12px;
      }

      .neon-store-pick-btn {
        width: 100%;
        padding: 12px 16px;
        background: transparent;
        border: 1px dashed ${colors.accent};
        color: ${colors.accent};
        border-radius: 6px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
        transition: all 0.2s ease;
      }

      .neon-store-pick-btn:hover {
        background: rgba(192, 132, 252, 0.1);
      }

      .neon-store-info {
        margin-top: 8px;
        padding: 12px;
        background: rgba(192, 132, 252, 0.06);
        border: 1px solid ${colors.border};
        border-radius: 6px;
        font-size: 13px;
        color: ${colors.lightgrey};
        line-height: 1.6;
      }

      .neon-store-info strong {
        color: ${colors.white};
      }

      .neon-checkout-summary {
        background: rgba(255, 255, 255, 0.02);
        border: 1px solid ${colors.border};
        border-radius: 12px;
        padding: 24px;
      }

      .neon-checkout-summary-title {
        font-size: 16px;
        font-weight: 600;
        margin-bottom: 16px;
      }

      .neon-checkout-summary-items {
        display: flex;
        flex-direction: column;
        gap: 12px;
        margin-bottom: 16px;
        padding-bottom: 16px;
        border-bottom: 1px solid ${colors.border};
      }

      .neon-checkout-summary-item {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        font-size: 13px;
      }

      .neon-checkout-summary-item-name {
        flex: 1;
        color: ${colors.white};
      }

      .neon-checkout-summary-item-qty {
        color: ${colors.lightgrey};
        margin: 0 12px;
      }

      .neon-checkout-summary-item-price {
        color: ${colors.accent};
        font-weight: 600;
      }

      .neon-checkout-summary-totals {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .neon-checkout-summary-row {
        display: flex;
        justify-content: space-between;
        font-size: 13px;
      }

      .neon-checkout-summary-label {
        color: ${colors.lightgrey};
      }

      .neon-checkout-summary-value {
        color: ${colors.white};
        font-weight: 500;
      }

      .neon-checkout-summary-total {
        display: flex;
        justify-content: space-between;
        font-size: 18px;
        font-weight: 700;
        margin-top: 12px;
        padding-top: 12px;
        border-top: 1px solid ${colors.border};
      }

      .neon-checkout-summary-total-value {
        color: ${colors.accent};
      }

      .neon-checkout-btn {
        width: 100%;
        padding: 14px 20px;
        background: linear-gradient(135deg, #f472b6, #a855f7);
        color: white;
        border: none;
        border-radius: 6px;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
        margin-top: 20px;
        transition: all 0.2s ease;
      }

      .neon-checkout-btn:hover:not(:disabled) {
        box-shadow: 0 0 24px rgba(168, 85, 247, 0.5);
        transform: translateY(-2px);
      }

      .neon-checkout-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      /* Confirmation Page */
      .neon-confirmation-page {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        overflow-y: auto;
        z-index: 10001;
        background: ${colors.black};
        color: ${colors.white};
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
      }

      .neon-confirmation-content {
        text-align: center;
        max-width: 500px;
      }

      .neon-confirmation-icon {
        font-size: 64px;
        margin-bottom: 24px;
        animation: confirmationBounce 0.6s ease;
      }

      @keyframes confirmationBounce {
        0% { transform: scale(0); }
        50% { transform: scale(1.1); }
        100% { transform: scale(1); }
      }

      .neon-confirmation-title {
        font-size: 28px;
        font-weight: 700;
        margin-bottom: 12px;
      }

      .neon-confirmation-order-num {
        font-size: 16px;
        color: ${colors.accent};
        margin-bottom: 8px;
        font-family: 'Space Mono', monospace;
        font-weight: 600;
      }

      .neon-confirmation-subtitle {
        font-size: 14px;
        color: ${colors.lightgrey};
        margin-bottom: 32px;
      }

      .neon-confirmation-actions {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .neon-confirmation-btn {
        padding: 14px 20px;
        border-radius: 6px;
        border: none;
        cursor: pointer;
        font-size: 14px;
        font-weight: 600;
        transition: all 0.2s ease;
      }

      .neon-confirmation-btn-line {
        background: #00b900;
        color: white;
      }

      .neon-confirmation-btn-line:hover {
        box-shadow: 0 0 20px rgba(0, 185, 0, 0.4);
      }

      .neon-confirmation-btn-home {
        background: transparent;
        border: 1px solid ${colors.accent};
        color: ${colors.accent};
      }

      .neon-confirmation-btn-home:hover {
        background: rgba(192, 132, 252, 0.1);
      }

      /* Responsive adjustments */
      @media (max-width: 768px) {
        .neon-cart-drawer {
          max-width: 100%;
        }

        .neon-modal {
          padding: 24px;
        }

        .neon-checkout-header {
          padding: 24px 16px;
        }

        .neon-checkout-title {
          font-size: 24px;
        }

        .neon-checkout-container {
          padding: 24px 16px;
        }
      }
    `;

    document.head.appendChild(style);
  }

  // ─────────────────────────────────────────────────────────────────
  // CART DRAWER UI
  // ─────────────────────────────────────────────────────────────────

  let cartDrawerOpen = false;

  function createCartDrawer() {
    if (document.getElementById('neon-cart-drawer')) {
      return document.getElementById('neon-cart-drawer');
    }

    const overlay = document.createElement('div');
    overlay.id = 'neon-cart-overlay';
    overlay.className = 'neon-cart-overlay';
    overlay.addEventListener('click', closeCartDrawer);

    const drawer = document.createElement('div');
    drawer.id = 'neon-cart-drawer';
    drawer.className = 'neon-cart-drawer';

    const header = document.createElement('div');
    header.className = 'neon-cart-header';
    header.innerHTML = `
      <div class="neon-cart-title">購物車</div>
      <button class="neon-cart-close">&times;</button>
    `;
    header.querySelector('.neon-cart-close').addEventListener('click', closeCartDrawer);

    const content = document.createElement('div');
    content.id = 'neon-cart-content';
    content.className = 'neon-cart-content';

    const footer = document.createElement('div');
    footer.id = 'neon-cart-footer';
    footer.className = 'neon-cart-footer';

    drawer.appendChild(header);
    drawer.appendChild(content);
    drawer.appendChild(footer);

    document.body.appendChild(overlay);
    document.body.appendChild(drawer);

    return drawer;
  }

  function renderCartContent() {
    const drawer = createCartDrawer();
    const content = drawer.querySelector('#neon-cart-content');
    const footer = drawer.querySelector('#neon-cart-footer');
    const items = CartState.get();

    // Render items
    content.innerHTML = '';
    if (items.length === 0) {
      content.innerHTML = `
        <div class="neon-cart-empty">
          <div class="neon-cart-empty-icon">🛒</div>
          <p>購物車是空的</p>
        </div>
      `;
    } else {
      items.forEach((item, idx) => {
        /* Look up the original product to get available sizes + both prices */
        const prod = (typeof window.findProductById === 'function')
          ? window.findProductById(item.product_id) : null;
        /* Normalize sizes: handle both string[] and [{label, available}] shapes.
           Prod.sizes from Supabase is [{label,available}]; legacy fallback may be string[]. */
        const normalizeSize = (s) => {
          if (!s) return null;
          if (typeof s === 'string') return { label: s, available: true };
          if (typeof s === 'object') return { label: String(s.label || s.size || ''), available: s.available !== false };
          return null;
        };
        let sizeList = [];
        if (prod && Array.isArray(prod.sizes) && prod.sizes.length) {
          sizeList = prod.sizes.map(normalizeSize).filter(Boolean).filter(s => s.label);
        }
        /* Cart items may have item.size as a string (new) or accidentally an object (legacy bug).
           Coerce to a label string for display + comparison. */
        const itemSizeLabel = (typeof item.size === 'object' && item.size !== null)
          ? String(item.size.label || item.size.size || '')
          : (item.size || '');
        /* Only show sizes flagged available; if none survive, fall back to itemSize/FREE. */
        let availableSizes = sizeList.filter(s => s.available !== false);
        if (availableSizes.length === 0) {
          availableSizes = itemSizeLabel ? [{ label: itemSizeLabel, available: true }] : [{ label: 'FREE', available: true }];
        }
        /* If the item's current size isn't in the available list, prepend it so the user sees it. */
        if (itemSizeLabel && !availableSizes.some(s => s.label === itemSizeLabel)) {
          availableSizes.unshift({ label: itemSizeLabel, available: true });
        }
        const priceShipping  = prod && prod.price && prod.price.twd_shipping  ? prod.price.twd_shipping  : null;
        const priceCarryback = prod && prod.price && prod.price.twd_carryback ? prod.price.twd_carryback : null;
        const canSwitch = !!(priceShipping && priceCarryback);

        const sizeOptions = availableSizes.map(s =>
          `<option value="${s.label}"${s.label === itemSizeLabel ? ' selected' : ''}>${s.label}</option>`
        ).join('');

        const shippingOptions = `
          <option value="shipping"${item.shipping_method === 'shipping' ? ' selected' : ''}>
            🚚 國際配送${priceShipping ? ` (NT$${priceShipping.toLocaleString()})` : ''}
          </option>
          <option value="carryback"${item.shipping_method === 'carryback' ? ' selected' : ''}>
            🧳 親自運送${priceCarryback ? ` (NT$${priceCarryback.toLocaleString()})` : ''}
          </option>
        `;

        const noteVal = (item.note || '').replace(/"/g, '&quot;');

        // 補救舊 cart：凍結的 image_url 空的或失效時，用 live product 的圖補上
        // 只收 http 開頭的網址 (與 main.js 商品卡片邏輯一致) —
        // 資料庫可能存本地相對路徑 (images/products/...),部署後不存在會 404
        const _httpOnly = (u) => (typeof u === 'string' && u.startsWith('http')) ? u : '';
        const liveImg = (prod && (
  (Array.isArray(prod.images?.gallery) && _httpOnly(prod.images.gallery[0]?.original_url || prod.images.gallery[0]?.url)) ||
  _httpOnly(prod.original_cover_url) ||
  _httpOnly(prod.images?.cover) ||
  _httpOnly(prod.cover_image) ||
  ''
)) || '';
        const displayImg = _httpOnly(item.image_url) || liveImg || '';
        const fallbackSvg = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2280%22 height=%2280%22%3E%3Crect fill=%22%23333%22 width=%2280%22 height=%2280%22/%3E%3C/svg%3E';

        const itemEl = document.createElement('div');
        itemEl.className = 'neon-cart-item';
        itemEl.innerHTML = `
          <div class="neon-cart-item-image">
            <img src="${displayImg}" alt="${item.product_name}" data-live-img="${liveImg}" data-fallback="${fallbackSvg}" onerror="if(this.dataset.tried!=='1'&&this.dataset.liveImg){this.dataset.tried='1';this.src=this.dataset.liveImg;}else{this.src=this.dataset.fallback;}" />
          </div>
          <div class="neon-cart-item-details">
            <div>
              <div class="neon-cart-item-name">${item.product_name}</div>
              <div class="neon-cart-item-price">NT$ ${(item.unit_price || 0).toLocaleString()}</div>

              <div class="neon-cart-edit-row">
                <div class="neon-cart-edit-field">
                  <label class="neon-cart-edit-label">尺寸</label>
                  <select class="neon-cart-edit-select" data-field="size" data-idx="${idx}">
                    ${sizeOptions}
                  </select>
                </div>
                <div class="neon-cart-edit-field" style="flex:1.6">
                  <label class="neon-cart-edit-label">運送方式${canSwitch ? '' : ' (此商品僅單一)'}</label>
                  <select class="neon-cart-edit-select" data-field="shipping_method" data-idx="${idx}"${canSwitch ? '' : ' disabled'}>
                    ${shippingOptions}
                  </select>
                </div>
              </div>

              <div class="neon-cart-edit-row">
                <div class="neon-cart-edit-field">
                  <label class="neon-cart-edit-label">備註 (選填)</label>
                  <input type="text" class="neon-cart-edit-note" data-field="note" data-idx="${idx}"
                         placeholder="例: 想要全新或近全新" value="${noteVal}" maxlength="80" />
                </div>
              </div>
            </div>
            <div class="neon-cart-item-qty">
              <button class="neon-cart-qty-btn" data-idx="${idx}" data-action="minus">−</button>
              <span class="neon-cart-qty-display">${item.quantity}</span>
              <button class="neon-cart-qty-btn" data-idx="${idx}" data-action="plus">+</button>
              <span class="neon-cart-item-remove" data-idx="${idx}">移除</span>
            </div>
          </div>
        `;

        itemEl.querySelector('[data-action="minus"]').addEventListener('click', () => {
          CartState.update(idx, item.quantity - 1);
          renderCartContent();
          updateCartIcon();
        });

        itemEl.querySelector('[data-action="plus"]').addEventListener('click', () => {
          CartState.update(idx, item.quantity + 1);
          renderCartContent();
          updateCartIcon();
        });

        itemEl.querySelector('.neon-cart-item-remove').addEventListener('click', () => {
          CartState.remove(idx);
          renderCartContent();
          updateCartIcon();
        });

        /* Size & shipping selects → updateField on change. Re-render so the
           subtotal & price-row reflect any unit_price recalculation. */
        itemEl.querySelectorAll('select[data-field]').forEach(sel => {
          sel.addEventListener('change', (e) => {
            const field = e.target.dataset.field;
            CartState.updateField(idx, { [field]: e.target.value });
            renderCartContent();
            updateCartIcon();
          });
        });

        /* Note input → save on blur (don't re-render while typing) */
        const noteEl = itemEl.querySelector('input[data-field="note"]');
        if (noteEl) {
          noteEl.addEventListener('blur', (e) => {
            CartState.updateField(idx, { note: e.target.value });
          });
        }

        content.appendChild(itemEl);
      });
    }

    // Render footer (Phase 2.2 — 五階等級 + 雙軌滿額現折 + 生日 + 折抵金 + 樓地板)
    const rawSubtotal      = CartState.getRawSubtotal();
    const discountResult   = CartState.getDiscountResult();
    const totalDiscount    = discountResult.total_savings;
    const discountedTotal  = discountResult.final_subtotal;
    const breakdown        = CartState.getDiscountBreakdown();
    const member           = CartState._getMember();

    // Tier label lookup
    const TIER_LBL = (window.DiscountEngine && window.DiscountEngine.TIER_LABELS) || {
      bronze:  { emoji: '🥉', label: '銅卡' },
      silver:  { emoji: '🥈', label: '銀卡' },
      gold:    { emoji: '🥇', label: '金卡' },
      diamond: { emoji: '💎', label: '鑽石卡' },
      black:   { emoji: '🖤', label: '黑卡' },
    };
    const tierMeta = TIER_LBL[discountResult.tier_key] || TIER_LBL.bronze;
    const tierPct = Math.round(discountResult.tier_rate * 100);

    // Per-group upsell hint (差 X 升 LX) — 只對會員顯示
    let groupsHtml = '';
    if (member && breakdown.length > 0) {
      groupsHtml = breakdown.map(g => {
        const label = SHIPPING_GROUP_LABELS[g.shipping_method] || g.shipping_method;
        // 升下一階滿額現折提示
        let nextLine = '';
        if (g.nextRung) {
          nextLine = `<div style="font-size:12px;color:${colors.accent};margin-top:2px">
            🛍 再買 NT$ ${g.nextRung.gap.toLocaleString()} 即可享滿額現折 -NT$ ${g.nextRung.discount.toLocaleString()}
          </div>`;
        }
        // 已套用的滿額現折金額統一顯示在下方「滿額現折」行,
        // 這裡不重複列出,避免客人誤以為折了兩次
        let appliedLine = '';
        if (!appliedLine && !nextLine) return ''; // 沒可顯示就跳過
        // 會員價後小計 — 讓「再買 X」的計算基準清楚
        const memberLine = (g.after_birthday !== undefined && g.after_birthday < g.subtotal) ? `
          <div style="display:flex;justify-content:space-between;font-size:12px;color:${colors.lightgrey};margin-top:2px">
            <span>└ 會員價後</span>
            <span>NT$ ${g.after_birthday.toLocaleString()}</span>
          </div>
        ` : '';
        return `
          <div style="padding:8px 0;border-top:1px dashed ${colors.glassBorder}">
            <div style="display:flex;justify-content:space-between;font-size:13px;color:${colors.white}">
              <span>${label} 小計</span>
              <span>NT$ ${g.subtotal.toLocaleString()}</span>
            </div>
            ${memberLine}
            ${appliedLine}
            ${nextLine}
          </div>
        `;
      }).filter(Boolean).join('');
    }

    // 訪客誘因 banner
    const guestBanner = (!member) ? `
      <div style="margin-top:8px;padding:10px 12px;background:rgba(192,132,252,0.08);border:1px solid ${colors.border};border-radius:8px;font-size:12px;color:${colors.accent};line-height:1.5">
        🔓 登入會員享 95–85 折 + 滿額現折最高 -NT$2,500 + 註冊禮金 NT$100
      </div>
    ` : '';

    // 等級折扣行 (僅會員 + 有折扣率時顯示)
    const tierRow = (member && discountResult.tier_discount > 0) ? `
      <div class="neon-cart-subtotal" style="margin-top:6px;color:#4ade80">
        <span class="neon-cart-subtotal-label">${tierMeta.emoji} ${tierMeta.label} 折扣 (${tierPct}折):</span>
        <span class="neon-cart-subtotal-value">- NT$ ${discountResult.tier_discount.toLocaleString()}</span>
      </div>
    ` : '';

    // 生日 9 折行
    const birthdayRow = discountResult.birthday_discount > 0 ? `
      <div class="neon-cart-subtotal" style="margin-top:6px;color:#4ade80">
        <span class="neon-cart-subtotal-label">🎂 生日月 9 折:</span>
        <span class="neon-cart-subtotal-value">- NT$ ${discountResult.birthday_discount.toLocaleString()}</span>
      </div>
    ` : '';

    // 滿額現折行
    const bulkRow = discountResult.bulk_discount_total > 0 ? `
      <div class="neon-cart-subtotal" style="margin-top:6px;color:#4ade80">
        <span class="neon-cart-subtotal-label">🛍 滿額現折:</span>
        <span class="neon-cart-subtotal-value">- NT$ ${discountResult.bulk_discount_total.toLocaleString()}</span>
      </div>
    ` : '';

    // 折抵金行 — 只要有餘額就顯示 toggle (含未使用狀態),讓客戶自行選擇
    const _useCreditNow = CartState.getUseCredit();
    const _creditBalance = Number(discountResult.credit_balance) || 0;
    const _creditUsed    = Number(discountResult.credit_used) || 0;
    let creditRow = '';
    if (_creditBalance > 0) {
      const checkedAttr = _useCreditNow ? 'checked' : '';
      const valueColor  = _useCreditNow && _creditUsed > 0 ? '#4ade80' : colors.lightgrey;
      const valueText   = _useCreditNow && _creditUsed > 0 ? '- NT$ ' + _creditUsed.toLocaleString() : '未使用';
      // 樓地板把折抵金擠掉的提示 (有勾選但實際扣 0)
      const cappedHint = (_useCreditNow && _creditUsed === 0)
        ? `<div style="font-size:11px;color:#fbbf24;margin-top:2px">已勾選,但折扣已達樓地板無法再扣抵</div>`
        : '';
      creditRow = `
        <div class="neon-cart-subtotal" style="margin-top:6px;display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;color:${colors.white};line-height:1.4">
            <input type="checkbox" ${checkedAttr}
                   onchange="window.CartSystem.setUseCredit(this.checked)"
                   style="width:14px;height:14px;cursor:pointer;accent-color:${colors.accent}">
            <span>💴 折抵金 (餘額 NT$ ${_creditBalance.toLocaleString()})</span>
          </label>
          <span style="color:${valueColor};font-size:13px;text-align:right;white-space:nowrap">${valueText}</span>
        </div>
        ${cappedHint}
      `;
    }

    // 樓地板拉回行 (有觸發時顯示為「保護線」)
    const floorRow = discountResult.floor_clamped ? `
      <div class="neon-cart-subtotal" style="margin-top:6px;color:#fbbf24;font-size:12px">
        <span class="neon-cart-subtotal-label">⛔ 等級樓地板 (${Math.round(discountResult.floor_rate * 100)}%):</span>
        <span class="neon-cart-subtotal-value">折扣已封頂</span>
      </div>
    ` : '';

    // 品牌活動促銷行 (migration 015) — 每個受影響品牌一行,明確告訴客人「為什麼折了」
    const brandPromoRow = (discountResult.brand_promo && discountResult.brand_promo.brand_summary)
      ? Object.entries(discountResult.brand_promo.brand_summary).map(([bid, s]) => {
          const pct       = 100 - (Number(s.discount_percent) || 0);
          const pctText   = s.discount_percent > 0 ? `${pct} 折` : '促銷價';
          const shipText  = s.free_shipping ? ' + 免運' : '';
          const savingTxt = s.savings > 0
            ? `- NT$ ${s.savings.toLocaleString()}`
            : (s.free_shipping ? '免運' : '');
          return `
            <div class="neon-cart-subtotal" style="margin-top:6px;color:#fb7185">
              <span class="neon-cart-subtotal-label">🔥 ${s.label} (${s.qty} 件,${pctText}${shipText}):</span>
              <span class="neon-cart-subtotal-value">${savingTxt}</span>
            </div>
          `;
        }).join('')
      : '';

    // 總共省下行
    const savingsRow = totalDiscount > 0 ? `
      <div class="neon-cart-subtotal" style="margin-top:4px;color:${colors.accent};font-size:12px">
        <span class="neon-cart-subtotal-label">您共省下:</span>
        <span class="neon-cart-subtotal-value">NT$ ${totalDiscount.toLocaleString()}</span>
      </div>
    ` : '';

    footer.innerHTML = `
      ${guestBanner}
      ${groupsHtml}
      <div class="neon-cart-subtotal" style="margin-top:8px">
        <span class="neon-cart-subtotal-label">商品小計:</span>
        <span class="neon-cart-subtotal-value">NT$ ${rawSubtotal.toLocaleString()}</span>
      </div>
      ${brandPromoRow}
      ${tierRow}
      ${birthdayRow}
      ${bulkRow}
      ${creditRow}
      ${floorRow}
      <div class="neon-cart-subtotal" style="margin-top:6px;border-top:1px solid ${colors.border};padding-top:8px;font-size:16px;font-weight:600">
        <span class="neon-cart-subtotal-label">應付小計:</span>
        <span class="neon-cart-subtotal-value">NT$ ${discountedTotal.toLocaleString()}</span>
      </div>
      ${savingsRow}
      <div class="neon-cart-actions">
        <button type="button" class="neon-cart-btn neon-cart-btn-checkout">前往結帳</button>
        <button type="button" class="neon-cart-btn neon-cart-btn-continue">繼續購物</button>
      </div>
    `;

    footer.querySelector('.neon-cart-btn-checkout').addEventListener('click', () => {
      closeCartDrawer();
      // 判斷是否有國際配送商品 → 走物流結帳；全是親自運送 → 走簡單結帳
      const cartItems = CartState.get();
      const hasShipping = cartItems.some(i => i.shipping_method === 'shipping');
      if (hasShipping) {
        showCheckoutPage();          // 完整結帳 (超商/宅配 + 線上付款/貨到付款)
      } else {
        showCarrybackCheckoutPage(); // 簡單結帳 (親自運送)
      }
    });

    footer.querySelector('.neon-cart-btn-continue').addEventListener('click', closeCartDrawer);
  }

  /* Track which brand IDs have already had their detail (sizes/gallery)
     hydrated this session so we don't re-fetch on every cart-open. */
  const _hydratedBrandIds = new Set();

  function _hydrateCartBrandSizes() {
    if (typeof window.loadBrandDetail !== 'function') return;
    const items = CartState.get();
    const brandIds = Array.from(new Set(
      items.map(it => it.brand_id).filter(id => id && !_hydratedBrandIds.has(id))
    ));
    if (brandIds.length === 0) return;
    brandIds.forEach(id => _hydratedBrandIds.add(id));
    /* Fire all loads in parallel; re-render once each settles so size
       dropdowns populate as soon as data lands. Failures are silent — the
       size dropdown gracefully falls back to the cart item's stored size. */
    brandIds.forEach(id => {
      Promise.resolve(window.loadBrandDetail(id))
        .then(() => { if (cartDrawerOpen) renderCartContent(); })
        .catch(err => console.warn('[cart] loadBrandDetail failed for', id, err));
    });
  }

  function openCartDrawer() {
    if (cartDrawerOpen) return;
    cartDrawerOpen = true;
    createCartDrawer();
    renderCartContent();
    document.getElementById('neon-cart-drawer').classList.add('open');
    document.getElementById('neon-cart-overlay').classList.add('open');
    document.body.style.overflow = 'hidden';
    /* Lazy-load full sizes for any brand whose products are in the cart so
       the size dropdown has the complete option list. */
    _hydrateCartBrandSizes();
  }

  function closeCartDrawer() {
    if (!cartDrawerOpen) return;
    cartDrawerOpen = false;
    const drawer = document.getElementById('neon-cart-drawer');
    const overlay = document.getElementById('neon-cart-overlay');
    if (drawer) drawer.classList.remove('open');
    if (overlay) overlay.classList.remove('open');
    document.body.style.overflow = '';
  }

  // ─────────────────────────────────────────────────────────────────
  // SIZE/SHIPPING SELECTION MODAL
  // ─────────────────────────────────────────────────────────────────

  function showSizeShippingModal(product) {
    return new Promise((resolve) => {
      injectStyles();

      // Remove any existing modal
      const existing = document.getElementById('neon-size-shipping-modal');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = 'neon-size-shipping-modal';
      overlay.className = 'neon-modal-overlay open';

      const modal = document.createElement('div');
      modal.className = 'neon-modal';

      const hasSizes = product.sizes && product.sizes.length > 0;

      let html = `
        <div class="neon-modal-title">加入購物車</div>
      `;

      // Size selection (if available)
      if (hasSizes) {
        html += `
          <div class="neon-modal-section">
            <label class="neon-modal-label">選擇尺寸</label>
            <div class="neon-size-group" id="neon-size-group">
        `;
        product.sizes.forEach((sz) => {
          const disabled = !sz.available ? 'disabled' : '';
          html += `<button type="button" class="neon-size-btn" data-size="${sz.label}" ${disabled}>${sz.label}</button>`;
        });
        html += `
            </div>
          </div>
        `;
      }

      // Shipping method selection
      html += `
        <div class="neon-modal-section">
          <label class="neon-modal-label">配送方式</label>
          <div class="neon-shipping-group" id="neon-shipping-group">
            <button type="button" class="neon-shipping-btn active" data-shipping="shipping">國際配送</button>
            <button type="button" class="neon-shipping-btn" data-shipping="carryback">親自運送</button>
          </div>
        </div>
        <div class="neon-modal-actions">
          <button type="button" class="neon-modal-btn neon-modal-btn-confirm">確認</button>
          <button type="button" class="neon-modal-btn neon-modal-btn-cancel">取消</button>
        </div>
      `;

      modal.innerHTML = html;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      let selectedSize = null;
      let selectedShipping = 'shipping';

      // Size button handlers
      if (hasSizes) {
        const sizeButtons = modal.querySelectorAll('.neon-size-btn:not(:disabled)');
        sizeButtons.forEach((btn) => {
          btn.addEventListener('click', () => {
            modal.querySelectorAll('.neon-size-btn').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            selectedSize = btn.dataset.size;
          });
        });
      }

      // Shipping button handlers
      modal.querySelectorAll('.neon-shipping-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          modal.querySelectorAll('.neon-shipping-btn').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          selectedShipping = btn.dataset.shipping;
        });
      });

      // Confirm button
      modal.querySelector('.neon-modal-btn-confirm').addEventListener('click', () => {
        if (hasSizes && !selectedSize) {
          alert('請選擇尺寸');
          return;
        }
        overlay.remove();
        resolve({ size: selectedSize, shipping: selectedShipping });
      });

      // Cancel button
      modal.querySelector('.neon-modal-btn-cancel').addEventListener('click', () => {
        overlay.remove();
        resolve(null);
      });

      // Close on overlay click
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          overlay.remove();
          resolve(null);
        }
      });
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // CARRYBACK (親自運送) CHECKOUT PAGE — 簡單結帳
  // ─────────────────────────────────────────────────────────────────

  async function showCarrybackCheckoutPage() {
    injectStyles();

    const pageDiv = document.createElement('div');
    pageDiv.className = 'page neon-checkout-page';
    pageDiv.id = 'neon-checkout-page';
    pageDiv.dataset.checkoutMode = 'carryback';   // 給 setUseCredit re-render 用

    const items           = CartState.get();
    const rawSubtotal     = CartState.getRawSubtotal();
    const discountResult  = CartState.getDiscountResult();
    const totalDiscount   = discountResult.total_savings;
    const discountedTotal = discountResult.final_subtotal;
    const breakdown       = CartState.getDiscountBreakdown();
    const member          = CartState._getMember();
    const total           = discountedTotal; // 親自運送無物流費

    // Tier label lookup
    const TIER_LBL_CB = (window.DiscountEngine && window.DiscountEngine.TIER_LABELS) || {
      bronze:  { emoji: '🥉', label: '銅卡' },
      silver:  { emoji: '🥈', label: '銀卡' },
      gold:    { emoji: '🥇', label: '金卡' },
      diamond: { emoji: '💎', label: '鑽石卡' },
      black:   { emoji: '🖤', label: '黑卡' },
    };
    const tierMetaCB = TIER_LBL_CB[discountResult.tier_key] || TIER_LBL_CB.bronze;
    const tierPctCB  = Math.round(discountResult.tier_rate * 100);

    let itemsSummary = '';
    items.forEach((item) => {
      itemsSummary += `
        <div class="neon-checkout-summary-item">
          <span class="neon-checkout-summary-item-name">${item.product_name}</span>
          <span class="neon-checkout-summary-item-qty">\u00d7${item.quantity}</span>
          <span class="neon-checkout-summary-item-price">NT$ ${(item.unit_price * item.quantity).toLocaleString()}</span>
        </div>
      `;
    });

    // 每組滿額現折「差多少」誘因提示行 — 僅會員
    // (已套用的金額統一顯示在下方「滿額現折」行,不在此重複,避免看似折兩次)
    let groupLines = '';
    if (member) {
      breakdown.forEach((g) => {
        const label = SHIPPING_GROUP_LABELS[g.shipping_method] || g.shipping_method;
        if (g.bulk_discount > 0) {
          // 已套用 → 不重複顯示
        } else if (g.nextRung) {
          if (g.after_birthday !== undefined && g.after_birthday < g.subtotal) {
            groupLines += `<div class="neon-checkout-summary-row" style="color:${colors.muted || colors.lightgrey};font-size:11px;opacity:0.85"><span>└ 會員價後小計</span><span>NT$ ${g.after_birthday.toLocaleString()}</span></div>`;
          }
          groupLines += `<div class="neon-checkout-summary-row" style="color:${colors.accent};font-size:12px"><span>🛍 ${label} 再買</span><span>NT$ ${g.nextRung.gap.toLocaleString()} 享 -NT$ ${g.nextRung.discount.toLocaleString()}</span></div>`;
        }
      });
    }

    // 等級折扣行
    const tierRowCB = (member && discountResult.tier_discount > 0) ? `
      <div class="neon-checkout-summary-row" style="color:#4ade80;font-size:13px">
        <span>${tierMetaCB.emoji} ${tierMetaCB.label} 折扣 (${tierPctCB}折):</span>
        <span>-NT$ ${discountResult.tier_discount.toLocaleString()}</span>
      </div>` : '';

    // 生日 9 折行
    const birthdayRowCB = discountResult.birthday_discount > 0 ? `
      <div class="neon-checkout-summary-row" style="color:#4ade80;font-size:13px">
        <span>🎂 生日月 9 折:</span>
        <span>-NT$ ${discountResult.birthday_discount.toLocaleString()}</span>
      </div>` : '';

    // 滿額現折行 (總計)
    const bulkRowCB = discountResult.bulk_discount_total > 0 ? `
      <div class="neon-checkout-summary-row" style="color:#4ade80;font-size:13px">
        <span>🛍 滿額現折:</span>
        <span>-NT$ ${discountResult.bulk_discount_total.toLocaleString()}</span>
      </div>` : '';

    // 折抵金行 — 有餘額就顯示 toggle (含未使用狀態)
    const _useCreditNowCB  = CartState.getUseCredit();
    const _creditBalanceCB = Number(discountResult.credit_balance) || 0;
    const _creditUsedCB    = Number(discountResult.credit_used) || 0;
    let creditRowCB = '';
    if (_creditBalanceCB > 0) {
      const _checkedCB = _useCreditNowCB ? 'checked' : '';
      const _valueColorCB = _useCreditNowCB && _creditUsedCB > 0 ? '#4ade80' : (colors.muted || colors.lightgrey);
      const _valueTextCB  = _useCreditNowCB && _creditUsedCB > 0 ? '-NT$ ' + _creditUsedCB.toLocaleString() : '未使用';
      const _cappedHintCB = (_useCreditNowCB && _creditUsedCB === 0)
        ? `<div class="neon-checkout-summary-row" style="color:#fbbf24;font-size:11px"><span>已勾選但折扣已達樓地板,本次無法扣抵</span><span></span></div>`
        : '';
      creditRowCB = `
        <div class="neon-checkout-summary-row" style="font-size:13px">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1">
            <input type="checkbox" ${_checkedCB}
                   onchange="window.CartSystem.setUseCredit(this.checked)"
                   style="width:14px;height:14px;cursor:pointer;accent-color:${colors.accent}">
            💴 使用註冊禮金折抵 (餘額 NT$ ${_creditBalanceCB.toLocaleString()})
          </label>
          <span style="color:${_valueColorCB};white-space:nowrap">${_valueTextCB}</span>
        </div>
        ${_cappedHintCB}
      `;
    }

    // 樓地板拉回行
    const floorRowCB = discountResult.floor_clamped ? `
      <div class="neon-checkout-summary-row" style="color:#fbbf24;font-size:12px">
        <span>⛔ 等級樓地板 (${Math.round(discountResult.floor_rate * 100)}%):</span>
        <span>折扣已封頂</span>
      </div>` : '';

    // 品牌活動促銷行 (migration 015)
    const brandPromoRowCB = (discountResult.brand_promo && discountResult.brand_promo.brand_summary)
      ? Object.entries(discountResult.brand_promo.brand_summary).map(([bid, s]) => {
          const pct       = 100 - (Number(s.discount_percent) || 0);
          const pctText   = s.discount_percent > 0 ? `${pct} 折` : '促銷價';
          const shipText  = s.free_shipping ? ' + 免運' : '';
          const savingTxt = s.savings > 0
            ? `-NT$ ${s.savings.toLocaleString()}`
            : (s.free_shipping ? '免運' : '');
          return `
            <div class="neon-checkout-summary-row" style="color:#fb7185;font-size:13px">
              <span>🔥 ${s.label} (${s.qty} 件,${pctText}${shipText}):</span>
              <span>${savingTxt}</span>
            </div>`;
        }).join('')
      : '';

    // 訪客誘因 banner
    const guestBannerCB = (!member) ? `
      <div class="neon-checkout-summary-row" style="background:rgba(192,132,252,0.08);border:1px solid ${colors.border};border-radius:8px;padding:8px 10px;font-size:12px;color:${colors.accent};line-height:1.5;display:block">
        🔓 登入會員享 95–85 折 + 滿額現折最高 -NT$2,500 + 註冊禮金 NT$100
      </div>` : '';

    const discountRow = totalDiscount > 0
      ? `<div class="neon-checkout-summary-row" style="color:${colors.accent};font-size:12px"><span>您共省下:</span><span>NT$ ${totalDiscount.toLocaleString()}</span></div>`
      : '';

    const html = `
      <div class="neon-checkout-header">
        <button type="button" id="checkout-back" style="position:absolute;left:20px;top:50%;transform:translateY(-50%);background:none;border:1px solid ${colors.border};color:${colors.white};padding:8px 16px;border-radius:8px;cursor:pointer;font-size:14px;">\u2190 返回</button>
        <h1 class="neon-checkout-title">結帳 — 親自運送</h1>
      </div>
      <div class="neon-checkout-container">
        <div class="neon-checkout-grid">
          <div class="neon-checkout-form-section">
            <div class="neon-checkout-form-group">
              <label class="neon-checkout-form-label">姓名 *</label>
              <input class="neon-checkout-form-input" id="checkout-name" type="text" placeholder="你的姓名" required />
            </div>
            <div class="neon-checkout-form-group">
              <label class="neon-checkout-form-label">電話 *</label>
              <input class="neon-checkout-form-input" id="checkout-phone" type="tel" placeholder="你的電話號碼" required />
            </div>
            <div class="neon-checkout-form-group">
              <label class="neon-checkout-form-label">Email *</label>
              <input class="neon-checkout-form-input" id="checkout-email" type="email" placeholder="你的 Email" required />
            </div>
            <div class="neon-checkout-form-group">
              <label class="neon-checkout-form-label">備註</label>
              <textarea class="neon-checkout-form-textarea" id="checkout-note" placeholder="有任何特殊要求嗎?"></textarea>
            </div>
          </div>

          <div class="neon-checkout-summary">
            <div class="neon-checkout-summary-title">訂單摘要</div>
            <div class="neon-checkout-summary-items">
              ${itemsSummary}
            </div>
            <div class="neon-checkout-summary-totals">
              <div class="neon-checkout-summary-row">
                <span class="neon-checkout-summary-label">商品小計:</span>
                <span class="neon-checkout-summary-value">NT$ ${rawSubtotal.toLocaleString()}</span>
              </div>
              ${guestBannerCB}
              ${groupLines}
              ${brandPromoRowCB}
              ${tierRowCB}
              ${birthdayRowCB}
              ${bulkRowCB}
              ${creditRowCB}
              ${floorRowCB}
              ${discountRow}
              <div class="neon-checkout-summary-row">
                <span class="neon-checkout-summary-label">配送方式:</span>
                <span class="neon-checkout-summary-value">親自運送</span>
              </div>
              <div class="neon-checkout-summary-total">
                <span>合計:</span>
                <span class="neon-checkout-summary-total-value">NT$ ${total.toLocaleString()}</span>
              </div>
            </div>
            <button type="button" class="neon-checkout-btn" id="checkout-submit">確認訂單</button>
          </div>
        </div>
      </div>
    `;

    pageDiv.innerHTML = html;
    document.body.appendChild(pageDiv);
    document.body.style.overflow = 'hidden';
    pageDiv.scrollTop = 0;

    // Back button
    pageDiv.querySelector('#checkout-back').addEventListener('click', () => {
      pageDiv.remove();
      document.body.style.overflow = '';
    });

    // Submit
    pageDiv.querySelector('#checkout-submit').addEventListener('click', async () => {
      const name  = pageDiv.querySelector('#checkout-name').value.trim();
      const phone = pageDiv.querySelector('#checkout-phone').value.trim();
      const email = pageDiv.querySelector('#checkout-email').value.trim();
      const note  = pageDiv.querySelector('#checkout-note').value.trim();

      if (!name || !phone || !email) {
        alert('請填入姓名、電話和 Email');
        return;
      }

      const submitBtn = pageDiv.querySelector('#checkout-submit');
      submitBtn.disabled = true;
      submitBtn.textContent = '處理中...';

      try {
        const supabase = window.supabase.createClient(
          'https://epemuyojkprepknuzuzc.supabase.co',
          [
            'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
            'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVwZW11eW9qa3ByZXBrbnV6dXpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4MDMwMTAsImV4cCI6MjA5MTM3OTAxMH0',
            'nTv7W1_ndzzAQGNgVzSKSkruvsnEgt6N7PbnRK31l0M'
          ].join('.')
        );

        const now = new Date();
        const dateStr = now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
        const rand = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
        // 親自帶回訂單前綴用 NLC,讓付款成功頁可以顯示對應的取貨說明
        const orderNumber = `NLC-${dateStr}-${rand}`;

        // 若登入會員,把 member_id 寫進訂單 — Phase 2.2 累積消費 / 消費次數要用
        const _carryMember   = (window.AuthSystem && typeof window.AuthSystem.getMember === 'function')
          ? (window.AuthSystem.getMember() || null)
          : null;
        const _carryMemberId = _carryMember?.id || null;

        // Phase 2.2 訂單欄位拆解:
        //   tier_at_purchase     = 下單當下會員等級 (歷史快照)
        //   tier_discount        = 等級折扣 + 滿額現折 - 樓地板補回 (折抵金、生日除外)
        //   birthday_discount    = 生日月 9 折金額
        //   signup_credit_used   = 註冊禮金扣抵
        const _cbTierKey       = _carryMember ? (discountResult.tier_key || null) : null;
        const _cbBirthday      = discountResult.birthday_discount || 0;
        const _cbCredit        = discountResult.credit_used || 0;
        const _cbTierBundle    = Math.max(0, (totalDiscount - _cbBirthday - _cbCredit));

        const { data: orderData, error: orderError } = await supabase
          .from('orders')
          .insert([{
            order_number: orderNumber,
            customer_name: name,
            customer_phone: phone,
            customer_email: email,
            customer_address: '',
            shipping_method: '親自運送',
            payment_method: '待確認',
            status: 'pending',
            subtotal: rawSubtotal,
            shipping_fee: 0,
            tier_at_purchase:   _cbTierKey,
            tier_discount:      _cbTierBundle,
            birthday_discount:  _cbBirthday,
            signup_credit_used: _cbCredit,
            total: total,
            note: note,
            line_notified: false,
            member_id: _carryMemberId,
          }])
          .select();

        if (orderError) throw new Error(orderError.message);
        if (!orderData || !orderData[0]) throw new Error('Failed to create order');

        const orderId = orderData[0].id;

        const orderItems = items.map((item) => ({
          order_id: orderId,
          product_id: item.product_id,
          product_name: item.product_name,
          brand_id: item.brand_id,
          size: item.size,
          quantity: item.quantity,
          unit_price: item.unit_price,
          image_url: item.image_url,
          is_promo: !!item.is_promo, // Phase 2.2 migration 014 — 歷史紀錄,newebpay-notify 會用 products.is_promo 覆寫為權威值
        }));

        const { error: itemsError } = await supabase
          .from('order_items')
          .insert(orderItems);

        if (itemsError) throw new Error(itemsError.message);

        // Send order notification via server-side API (non-blocking)
        try {
          var _n = typeof name !== 'undefined' ? name : '';
          var _p = typeof phone !== 'undefined' ? phone : '';
          var _e = typeof email !== 'undefined' ? email : '';
          var _a = typeof address !== 'undefined' ? address : '';
          var _nt = typeof note !== 'undefined' ? note : '';
          var _sh = typeof selectedShipping !== 'undefined' ? selectedShipping : '';
          fetch('/api/notify-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              orderNumber: orderNumber,
              name: _n, phone: _p, email: _e, address: _a,
              shipping: _sh, total: total, items: items, note: _nt
            })
          }).catch(function(e) { console.warn('[Notify]', e); });
        } catch(ne) { console.warn('[Notify]', ne); }

        // ── 導向藍新金流 (NewebPay) — 親自帶回也走線上付款 ──
        // shipping_method 必須一起送至 API,讓 server 端可重新驗證滿額折扣
        // product_id 必送 → server 用此撈 is_promo (Phase 2.2 migration 014 anti-tamper)
        //
        // Migration 015 — 品牌週折扣:BrandPromoEngine 產生 discountResult.brand_promo.items
        //   跟 CartState items 同 index、同順序,但 is_promo=true 的條目已把 unit_price
        //   改成折後價。我們送折後價 + is_promo=true 給 server,server 用 brand_promos
        //   驗證品牌週有效後就會信任 (skip tier/bulk/生日),final_subtotal 才會吻合。
        const brandItemsCB = (discountResult.brand_promo && Array.isArray(discountResult.brand_promo.items))
          ? discountResult.brand_promo.items : null;
        const npItems = items.map((item, idx) => {
          const bi = brandItemsCB ? brandItemsCB[idx] : null;
          const effectivePrice = (bi && bi.is_promo) ? bi.unit_price : item.unit_price;
          const effectivePromo = !!(bi && bi.is_promo);
          return {
            product_id: item.product_id,
            name: item.product_name,
            quantity: item.quantity,
            price: effectivePrice,
            is_promo: effectivePromo,
            shipping_method: item.shipping_method || 'carryback',
          };
        });

        submitBtn.textContent = '導向付款頁面...';

        const npRes = await fetch('/api/newebpay-create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items:       npItems,
            totalAmount: total,
            shippingFee: 0,
            discount:    totalDiscount,
            // Phase 2.2 — 傳會員上下文讓 server 重算 + 驗證金額 (±NT$5 容差)
            memberId:    _carryMemberId,
            tierKey:     _cbTierKey,
            useCredit:   _cbCredit > 0,
            buyerName:   name,
            buyerEmail:  email,
            buyerPhone:  phone,
            orderId:     orderNumber,
          }),
        });

        const npData = await npRes.json();

        if (!npData.success || !npData.formHtml) {
          throw new Error(npData.error || '無法建立付款訂單');
        }

        CartState.clear();
        updateCartIcon();
        pageDiv.remove();
        document.body.style.overflow = '';

        const payDiv = document.createElement('div');
        payDiv.id = 'newebpay-redirect';
        payDiv.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#0a0a0f;display:flex;align-items:center;justify-content:center;color:#f5f4f0;font-size:1.1rem;';
        payDiv.innerHTML = '<div style="text-align:center"><div style="margin-bottom:16px;font-size:2rem">🔒</div>正在導向藍新付款頁面...</div>';
        document.body.appendChild(payDiv);

        const formContainer = document.createElement('div');
        formContainer.style.display = 'none';
        formContainer.innerHTML = npData.formHtml;
        document.body.appendChild(formContainer);

        const payForm = formContainer.querySelector('form');
        if (payForm) {
          payForm.submit();
        }

      } catch (error) {
        console.error('[CartSystem] Carryback checkout error:', error);
        alert('訂單提交失敗: ' + error.message);
        submitBtn.disabled = false;
        submitBtn.textContent = '確認訂單';
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // SHIPPING (國際配送) CHECKOUT PAGE — 完整結帳 (物流 + 金流)
  // ─────────────────────────────────────────────────────────────────

  async function showCheckoutPage() {
    injectStyles();

    // Create page div
    const pageDiv = document.createElement('div');
    pageDiv.className = 'page neon-checkout-page';
    pageDiv.id = 'neon-checkout-page';
    pageDiv.dataset.checkoutMode = 'shipping';    // 給 setUseCredit re-render 用

    const items              = CartState.get();
    const rawSubtotal        = CartState.getRawSubtotal();
    const discountResult     = CartState.getDiscountResult();
    const totalDiscount      = discountResult.total_savings;
    const discountedSubtotal = discountResult.final_subtotal;
    const breakdown          = CartState.getDiscountBreakdown();
    const member             = CartState._getMember();
    // subtotal 變數仍指「商品小計 (未含折扣)」,讓免運判斷用原始消費額
    const subtotal           = rawSubtotal;

    // Tier label lookup
    const TIER_LBL_SH = (window.DiscountEngine && window.DiscountEngine.TIER_LABELS) || {
      bronze:  { emoji: '🥉', label: '銅卡' },
      silver:  { emoji: '🥈', label: '銀卡' },
      gold:    { emoji: '🥇', label: '金卡' },
      diamond: { emoji: '💎', label: '鑽石卡' },
      black:   { emoji: '🖤', label: '黑卡' },
    };
    const tierMetaSH = TIER_LBL_SH[discountResult.tier_key] || TIER_LBL_SH.bronze;
    const tierPctSH  = Math.round(discountResult.tier_rate * 100);

    // ── 運費設定 (雙門檻,依「原始」商品小計判斷,折扣不影響免運資格) ──
    const SHIPPING_FEE_CVS  = 70;   // 超商取貨運費
    const SHIPPING_FEE_HOME = 120;  // 宅配到府運費
    const FREE_SHIP_THRESHOLD_CVS  = 3000; // 超商取貨滿額免運門檻
    const FREE_SHIP_THRESHOLD_HOME = 5000; // 宅配到府滿額免運門檻

    // 品牌活動免運 (migration 015) — 只要 cart 有觸發任一品牌週的免運,直接免運,不看滿額門檻
    const brandPromoFreeShip = !!(discountResult.brand_promo && discountResult.brand_promo.any_free_shipping);
    const brandPromoLabels   = (discountResult.brand_promo && discountResult.brand_promo.brand_summary)
      ? Object.values(discountResult.brand_promo.brand_summary).filter(s => s.free_shipping).map(s => s.label)
      : [];

    const isFreeShippingCvs  = brandPromoFreeShip || subtotal >= FREE_SHIP_THRESHOLD_CVS;
    const isFreeShippingHome = brandPromoFreeShip || subtotal >= FREE_SHIP_THRESHOLD_HOME;
    let currentShippingFee = isFreeShippingCvs ? 0 : SHIPPING_FEE_CVS; // 預設超商

    // 免運提示文案 (依目前選擇的配送方式)
    function freeShipNoteHtml(method) {
      // 品牌活動免運優先 — 已觸發就直接顯示,不用再看滿額門檻
      if (brandPromoFreeShip) {
        const brandsTxt = brandPromoLabels.length > 0 ? brandPromoLabels.join('、') : '品牌活動';
        return `<span style="color:#4ade80;">🔥 ${brandsTxt} 免運已啟用！</span>`;
      }
      const th    = method === 'home' ? FREE_SHIP_THRESHOLD_HOME : FREE_SHIP_THRESHOLD_CVS;
      const label = method === 'home' ? '宅配' : '超商取貨';
      if (subtotal >= th) {
        return `<span style="color:#4ade80;">訂單滿 NT$ ${th.toLocaleString()} 享${label}免運優惠！</span>`;
      }
      return `再消費 NT$ ${(th - subtotal).toLocaleString()} 即享${label}免運`;
    }

    let itemsSummary = '';
    items.forEach((item) => {
      itemsSummary += `
        <div class="neon-checkout-summary-item">
          <span class="neon-checkout-summary-item-name">${item.product_name}</span>
          <span class="neon-checkout-summary-item-qty">×${item.quantity}</span>
          <span class="neon-checkout-summary-item-price">NT$ ${(item.unit_price * item.quantity).toLocaleString()}</span>
        </div>
      `;
    });

    // 每組滿額現折「差多少」誘因提示行 — 僅會員
    // (已套用的金額統一顯示在下方「滿額現折」行,不在此重複,避免看似折兩次)
    let groupLines = '';
    if (member) {
      breakdown.forEach((g) => {
        const label = SHIPPING_GROUP_LABELS[g.shipping_method] || g.shipping_method;
        if (g.bulk_discount > 0) {
          // 已套用 → 不重複顯示
        } else if (g.nextRung) {
          if (g.after_birthday !== undefined && g.after_birthday < g.subtotal) {
            groupLines += `<div class="neon-checkout-summary-row" style="color:${colors.muted || colors.lightgrey};font-size:11px;opacity:0.85"><span>└ 會員價後小計</span><span>NT$ ${g.after_birthday.toLocaleString()}</span></div>`;
          }
          groupLines += `<div class="neon-checkout-summary-row" style="color:${colors.accent};font-size:12px"><span>🛍 ${label} 再買</span><span>NT$ ${g.nextRung.gap.toLocaleString()} 享 -NT$ ${g.nextRung.discount.toLocaleString()}</span></div>`;
        }
      });
    }

    // 等級折扣行 (僅會員 + 有折扣率時)
    const tierRowSH = (member && discountResult.tier_discount > 0) ? `
      <div class="neon-checkout-summary-row" style="color:#4ade80;font-size:13px">
        <span>${tierMetaSH.emoji} ${tierMetaSH.label} 折扣 (${tierPctSH}折):</span>
        <span>-NT$ ${discountResult.tier_discount.toLocaleString()}</span>
      </div>` : '';

    // 生日 9 折行
    const birthdayRowSH = discountResult.birthday_discount > 0 ? `
      <div class="neon-checkout-summary-row" style="color:#4ade80;font-size:13px">
        <span>🎂 生日月 9 折:</span>
        <span>-NT$ ${discountResult.birthday_discount.toLocaleString()}</span>
      </div>` : '';

    // 滿額現折合計行
    const bulkRowSH = discountResult.bulk_discount_total > 0 ? `
      <div class="neon-checkout-summary-row" style="color:#4ade80;font-size:13px">
        <span>🛍 滿額現折:</span>
        <span>-NT$ ${discountResult.bulk_discount_total.toLocaleString()}</span>
      </div>` : '';

    // 折抵金行
    const creditRowSH = discountResult.credit_used > 0 ? `
      <div class="neon-checkout-summary-row" style="color:#4ade80;font-size:13px">
        <span>💴 註冊禮金折抵:</span>
        <span>-NT$ ${discountResult.credit_used.toLocaleString()}</span>
      </div>` : '';

    // 樓地板拉回行
    const floorRowSH = discountResult.floor_clamped ? `
      <div class="neon-checkout-summary-row" style="color:#fbbf24;font-size:12px">
        <span>⛔ 等級樓地板 (${Math.round(discountResult.floor_rate * 100)}%):</span>
        <span>折扣已封頂</span>
      </div>` : '';

    // 品牌活動促銷行 (migration 015) — 每個受影響品牌一行
    const brandPromoRowSH = (discountResult.brand_promo && discountResult.brand_promo.brand_summary)
      ? Object.entries(discountResult.brand_promo.brand_summary).map(([bid, s]) => {
          const pct       = 100 - (Number(s.discount_percent) || 0);
          const pctText   = s.discount_percent > 0 ? `${pct} 折` : '促銷價';
          const shipText  = s.free_shipping ? ' + 免運' : '';
          const savingTxt = s.savings > 0
            ? `-NT$ ${s.savings.toLocaleString()}`
            : (s.free_shipping ? '免運' : '');
          return `
            <div class="neon-checkout-summary-row" style="color:#fb7185;font-size:13px">
              <span>🔥 ${s.label} (${s.qty} 件,${pctText}${shipText}):</span>
              <span>${savingTxt}</span>
            </div>`;
        }).join('')
      : '';

    // 訪客誘因 banner
    const guestBannerSH = (!member) ? `
      <div class="neon-checkout-summary-row" style="background:rgba(192,132,252,0.08);border:1px solid ${colors.border};border-radius:8px;padding:8px 10px;font-size:12px;color:${colors.accent};line-height:1.5;display:block">
        🔓 登入會員享 95–85 折 + 滿額現折最高 -NT$2,500 + 註冊禮金 NT$100
      </div>` : '';

    const discountRow = totalDiscount > 0
      ? `<div class="neon-checkout-summary-row" style="color:${colors.accent};font-size:12px"><span>您共省下:</span><span>NT$ ${totalDiscount.toLocaleString()}</span></div>`
      : '';

    const freeShippingNote = `<div id="checkout-free-shipping-note" style="color:${colors.muted};font-size:13px;margin-top:4px;">${freeShipNoteHtml('cvs')}</div>`;

    const html = `
      <div class="neon-checkout-header">
        <button type="button" id="checkout-back" style="position:absolute;left:20px;top:50%;transform:translateY(-50%);background:none;border:1px solid ${colors.border};color:${colors.white};padding:8px 16px;border-radius:8px;cursor:pointer;font-size:14px;">← 返回</button>
        <h1 class="neon-checkout-title">結帳</h1>
      </div>
      <div class="neon-checkout-container">
        <div class="neon-checkout-grid">
          <!-- Form Side -->
          <div class="neon-checkout-form-section">
            <div class="neon-checkout-form-group">
              <label class="neon-checkout-form-label">姓名 *</label>
              <input class="neon-checkout-form-input" id="checkout-name" type="text" placeholder="你的姓名" required />
            </div>

            <div class="neon-checkout-form-group">
              <label class="neon-checkout-form-label">電話 *</label>
              <input class="neon-checkout-form-input" id="checkout-phone" type="tel" placeholder="你的電話號碼" required />
            </div>

            <div class="neon-checkout-form-group">
              <label class="neon-checkout-form-label">Email *</label>
              <input class="neon-checkout-form-input" id="checkout-email" type="email" placeholder="你的 Email" required />
            </div>

            <!-- 配送方式 -->
            <div class="neon-checkout-form-group">
              <label class="neon-checkout-form-label">配送方式 *</label>
              <div class="neon-shipping-toggle">
                <button type="button" class="neon-shipping-option active" data-shipping="cvs">超商取貨 ${isFreeShippingCvs ? '(免運)' : '(NT$ 70)'}</button>
                <button type="button" class="neon-shipping-option" data-shipping="home">宅配到府 ${isFreeShippingHome ? '(免運)' : '(NT$ 120)'}</button>
              </div>
            </div>

            <!-- 超商取貨區域 -->
            <div id="checkout-cvs-section">
              <div class="neon-checkout-form-group">
                <label class="neon-checkout-form-label">選擇超商</label>
                <div class="neon-cvs-brands">
                  <button type="button" class="neon-cvs-brand-btn active" data-subtype="UNIMARTC2C">7-ELEVEN</button>
                  <button type="button" class="neon-cvs-brand-btn" data-subtype="FAMIC2C">全家</button>
                  <button type="button" class="neon-cvs-brand-btn" data-subtype="HILIFEC2C">萊爾富</button>
                  <button type="button" class="neon-cvs-brand-btn" data-subtype="OKMARTC2C">OK超商</button>
                </div>
              </div>
              <div class="neon-checkout-form-group">
                <label class="neon-checkout-form-label">取貨門市名稱 *</label>
                <input class="neon-checkout-form-input" id="checkout-store-name" type="text" placeholder="例：全家 台北信義店" />
              </div>
            </div>

            <!-- 宅配到府區域 (預設隱藏) -->
            <div id="checkout-home-section" style="display:none;">
              <div class="neon-checkout-form-group">
                <label class="neon-checkout-form-label">收件地址 *</label>
                <input class="neon-checkout-form-input" id="checkout-address" type="text" placeholder="完整收件地址 (含縣市區)" />
              </div>
            </div>

            <div class="neon-checkout-form-group">
              <label class="neon-checkout-form-label">備註</label>
              <textarea class="neon-checkout-form-textarea" id="checkout-note" placeholder="有任何特殊要求嗎?"></textarea>
            </div>
          </div>

          <!-- Summary Side -->
          <div class="neon-checkout-summary">
            <div class="neon-checkout-summary-title">訂單摘要</div>
            <div class="neon-checkout-summary-items">
              ${itemsSummary}
            </div>
            <div class="neon-checkout-summary-totals">
              <div class="neon-checkout-summary-row">
                <span class="neon-checkout-summary-label">商品小計:</span>
                <span class="neon-checkout-summary-value">NT$ ${subtotal.toLocaleString()}</span>
              </div>
              ${guestBannerSH}
              ${groupLines}
              ${brandPromoRowSH}
              ${tierRowSH}
              ${birthdayRowSH}
              ${bulkRowSH}
              ${creditRowSH}
              ${floorRowSH}
              ${discountRow}
              <div class="neon-checkout-summary-row" id="checkout-shipping-row">
                <span class="neon-checkout-summary-label">運費 (超商取貨):</span>
                <span class="neon-checkout-summary-value" id="checkout-shipping-value">${isFreeShippingCvs ? '<span style="text-decoration:line-through;color:' + colors.muted + '">NT$ 70</span> <span style="color:#4ade80">免運</span>' : 'NT$ ' + currentShippingFee.toLocaleString()}</span>
              </div>
              ${freeShippingNote}
              <div class="neon-checkout-summary-total">
                <span>合計:</span>
                <span class="neon-checkout-summary-total-value" id="checkout-grand-total">NT$ ${(discountedSubtotal + currentShippingFee).toLocaleString()}</span>
              </div>
            </div>
            <button type="button" class="neon-checkout-btn" id="checkout-submit">確認訂單</button>
          </div>
        </div>
      </div>
    `;

    pageDiv.innerHTML = html;
    document.body.appendChild(pageDiv);
    document.body.style.overflow = 'hidden';

    // Scroll checkout page to top
    pageDiv.scrollTop = 0;

    // Back button handler
    pageDiv.querySelector('#checkout-back').addEventListener('click', () => {
      pageDiv.remove();
      document.body.style.overflow = '';
    });

    /* ── 配送方式切換 ── */
    let selectedShipping = 'cvs';          // 'cvs' | 'home'
    let selectedCvsSubType = 'UNIMARTC2C'; // C2C subtype

    const cvsSection  = pageDiv.querySelector('#checkout-cvs-section');
    const homeSection = pageDiv.querySelector('#checkout-home-section');

    // ── 更新運費 UI 的 helper ──
    function updateShippingUI() {
      const fee = selectedShipping === 'cvs' ? SHIPPING_FEE_CVS : SHIPPING_FEE_HOME;
      const isFree = selectedShipping === 'cvs' ? isFreeShippingCvs : isFreeShippingHome;
      currentShippingFee = isFree ? 0 : fee;
      const shippingLabel = selectedShipping === 'cvs' ? '超商取貨' : '宅配到府';

      // 運費行
      const shippingRow = pageDiv.querySelector('#checkout-shipping-row');
      if (shippingRow) {
        shippingRow.querySelector('.neon-checkout-summary-label').textContent = `運費 (${shippingLabel}):`;
        const valEl = shippingRow.querySelector('#checkout-shipping-value');
        if (isFree) {
          valEl.innerHTML = `<span style="text-decoration:line-through;color:${colors.muted}">NT$ ${fee.toLocaleString()}</span> <span style="color:#4ade80">免運</span>`;
        } else {
          valEl.textContent = `NT$ ${currentShippingFee.toLocaleString()}`;
        }
      }

      // 免運提示 (依配送方式切換文案)
      const noteEl = pageDiv.querySelector('#checkout-free-shipping-note');
      if (noteEl) noteEl.innerHTML = freeShipNoteHtml(selectedShipping);

      // 合計 (使用折扣後小計)
      const grandTotalEl = pageDiv.querySelector('#checkout-grand-total');
      if (grandTotalEl) {
        grandTotalEl.textContent = `NT$ ${(discountedSubtotal + currentShippingFee).toLocaleString()}`;
      }
    }

    pageDiv.querySelectorAll('.neon-shipping-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        pageDiv.querySelectorAll('.neon-shipping-option').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        selectedShipping = btn.dataset.shipping;
        cvsSection.style.display  = selectedShipping === 'cvs' ? '' : 'none';
        homeSection.style.display = selectedShipping === 'home' ? '' : 'none';
        updateShippingUI();
      });
    });

    /* ── 超商品牌切換 ── */
    pageDiv.querySelectorAll('.neon-cvs-brand-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        pageDiv.querySelectorAll('.neon-cvs-brand-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        selectedCvsSubType = btn.dataset.subtype;
      });
    });

    /* ── 清理事件 ── */
    function cleanupCheckout() {
      pageDiv.remove();
      document.body.style.overflow = '';
    }

    /* ── Handle Submit ── */
    pageDiv.querySelector('#checkout-submit').addEventListener('click', async () => {
      const name  = pageDiv.querySelector('#checkout-name').value.trim();
      const phone = pageDiv.querySelector('#checkout-phone').value.trim();
      const email = pageDiv.querySelector('#checkout-email').value.trim();
      const note  = pageDiv.querySelector('#checkout-note').value.trim();

      /* 驗證必填 */
      if (!name || !phone || !email) {
        alert('請填入姓名、電話和 Email');
        return;
      }

      if (selectedShipping === 'cvs') {
        const storeName = pageDiv.querySelector('#checkout-store-name').value.trim();
        if (!storeName) {
          alert('請填入取貨門市名稱');
          return;
        }
      }

      if (selectedShipping === 'home') {
        const address = pageDiv.querySelector('#checkout-address').value.trim();
        if (!address) {
          alert('請填入收件地址');
          return;
        }
      }

      // Disable submit button
      const submitBtn = pageDiv.querySelector('#checkout-submit');
      submitBtn.disabled = true;
      submitBtn.textContent = '處理中...';

      try {
        // Get Supabase client
        const supabase = window.supabase.createClient(
          'https://epemuyojkprepknuzuzc.supabase.co',
          [
            'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
            'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVwZW11eW9qa3ByZXBrbnV6dXpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4MDMwMTAsImV4cCI6MjA5MTM3OTAxMH0',
            'nTv7W1_ndzzAQGNgVzSKSkruvsnEgt6N7PbnRK31l0M'
          ].join('.')
        );

        // Generate order number: NL-YYYYMMDD-XXXX
        const now = new Date();
        const dateStr = now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
        const rand = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
        const orderNumber = `NL-${dateStr}-${rand}`;

        const cvsStoreName = selectedShipping === 'cvs'
          ? pageDiv.querySelector('#checkout-store-name').value.trim()
          : '';
        const address = selectedShipping === 'home'
          ? pageDiv.querySelector('#checkout-address').value.trim()
          : cvsStoreName;

        // 配送方式文字
        const cvsSubTypeLabel = { UNIMARTC2C: '7-ELEVEN', FAMIC2C: '全家', HILIFEC2C: '萊爾富', OKMARTC2C: 'OK超商' };
        const shippingLabel = selectedShipping === 'cvs'
          ? `超商取貨 (${cvsSubTypeLabel[selectedCvsSubType] || '超商'}) - ${cvsStoreName}`
          : '宅配到府';

        // 若登入會員,把 member_id 寫進訂單 — Phase 2.2 累積消費 / 消費次數要用
        const _shipMember   = (window.AuthSystem && typeof window.AuthSystem.getMember === 'function')
          ? (window.AuthSystem.getMember() || null)
          : null;
        const _shipMemberId = _shipMember?.id || null;

        // Phase 2.2 訂單欄位拆解 (與 carryback 一致):
        //   tier_at_purchase     = 下單當下會員等級 (歷史快照)
        //   tier_discount        = 等級折扣 + 滿額現折 - 樓地板補回 (折抵金、生日除外)
        //   birthday_discount    = 生日月 9 折金額
        //   signup_credit_used   = 註冊禮金扣抵
        const _shTierKey    = _shipMember ? (discountResult.tier_key || null) : null;
        const _shBirthday   = discountResult.birthday_discount || 0;
        const _shCredit     = discountResult.credit_used || 0;
        const _shTierBundle = Math.max(0, (totalDiscount - _shBirthday - _shCredit));

        // Insert order (含 Phase 2.2 折扣拆解)
        const { data: orderData, error: orderError } = await supabase
          .from('orders')
          .insert([
            {
              order_number: orderNumber,
              customer_name: name,
              customer_phone: phone,
              customer_email: email,
              customer_address: address,
              shipping_method: shippingLabel,
              payment_method: '待確認',
              status: 'pending',
              subtotal: subtotal,                            // 商品原價小計
              shipping_fee: currentShippingFee,
              tier_at_purchase:   _shTierKey,
              tier_discount:      _shTierBundle,             // 等級+滿額-樓地板
              birthday_discount:  _shBirthday,
              signup_credit_used: _shCredit,
              total: discountedSubtotal + currentShippingFee,// 應付總額
              note: note,
              line_notified: false,
              member_id: _shipMemberId,
            },
          ])
          .select();

        if (orderError) throw new Error(orderError.message);
        if (!orderData || !orderData[0]) throw new Error('Failed to create order');

        const orderId = orderData[0].id;

        // Insert order items
        const orderItems = items.map((item) => ({
          order_id: orderId,
          product_id: item.product_id,
          product_name: item.product_name,
          brand_id: item.brand_id,
          size: item.size,
          quantity: item.quantity,
          unit_price: item.unit_price,
          image_url: item.image_url,
          is_promo: !!item.is_promo, // Phase 2.2 migration 014 — 歷史紀錄,newebpay-notify 會用 products.is_promo 覆寫為權威值
        }));

        const { error: itemsError } = await supabase
          .from('order_items')
          .insert(orderItems);

        if (itemsError) throw new Error(itemsError.message);

        // Send order notification via server-side API (non-blocking)
        try {
          var _n = typeof name !== 'undefined' ? name : (typeof customerName !== 'undefined' ? customerName : '');
          var _p = typeof phone !== 'undefined' ? phone : (typeof customerPhone !== 'undefined' ? customerPhone : '');
          var _e = typeof email !== 'undefined' ? email : (typeof customerEmail !== 'undefined' ? customerEmail : '');
          var _a = typeof address !== 'undefined' ? address : (typeof customerAddress !== 'undefined' ? customerAddress : '');
          var _nt = typeof note !== 'undefined' ? note : (typeof customerNote !== 'undefined' ? customerNote : '');
          var _sh = typeof selectedShipping !== 'undefined' ? selectedShipping : (typeof shippingMethod !== 'undefined' ? shippingMethod : '');
          // 計算 grandTotal 給通知用 (subtotal 變數已重新指向商品原價小計)
          var _grand = (typeof discountedSubtotal !== 'undefined' ? discountedSubtotal : subtotal) + (currentShippingFee || 0);
          fetch('/api/notify-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              orderNumber: orderNumber,
              name: _n, phone: _p, email: _e, address: _a,
              shipping: _sh, total: _grand, items: items, note: _nt,
              discount: (typeof totalDiscount !== 'undefined' ? totalDiscount : 0)
            })
          }).catch(function(e) { console.warn('[Notify]', e); });
        } catch(ne) { console.warn('[Notify]', ne); }


        // ── 導向藍新金流 (NewebPay) ──
        // shipping_method 必須一起送至 API,讓 server 端可重新驗證滿額折扣
        // product_id 必送 → server 用此撈 is_promo (Phase 2.2 migration 014 anti-tamper)
        // Migration 015 — 品牌週折扣同 carryback 路徑:送折後價 + is_promo=true
        const brandItemsSH = (discountResult.brand_promo && Array.isArray(discountResult.brand_promo.items))
          ? discountResult.brand_promo.items : null;
        const npItems = items.map((item, idx) => {
          const bi = brandItemsSH ? brandItemsSH[idx] : null;
          const effectivePrice = (bi && bi.is_promo) ? bi.unit_price : item.unit_price;
          const effectivePromo = !!(bi && bi.is_promo);
          return {
            product_id: item.product_id,
            name: item.product_name,
            quantity: item.quantity,
            price: effectivePrice,
            is_promo: effectivePromo,
            shipping_method: item.shipping_method || 'default',
          };
        });

        submitBtn.textContent = '導向付款頁面...';

        const grandTotal = discountedSubtotal + currentShippingFee;

        const npRes = await fetch('/api/newebpay-create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items:       npItems,
            totalAmount: grandTotal,
            shippingFee: currentShippingFee,
            discount:    totalDiscount,
            // Phase 2.2 — 傳會員上下文讓 server 重算 + 驗證金額 (±NT$5 容差)
            memberId:    _shipMemberId,
            tierKey:     _shTierKey,
            useCredit:   _shCredit > 0,
            buyerName:   name,
            buyerEmail:  email,
            buyerPhone:  phone,
            orderId:     orderNumber,
          }),
        });

        const npData = await npRes.json();

        if (!npData.success || !npData.formHtml) {
          throw new Error(npData.error || '無法建立付款訂單');
        }

        CartState.clear();
        updateCartIcon();
        cleanupCheckout();

        const payDiv = document.createElement('div');
        payDiv.id = 'newebpay-redirect';
        payDiv.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#0a0a0f;display:flex;align-items:center;justify-content:center;color:#f5f4f0;font-size:1.1rem;';
        payDiv.innerHTML = '<div style="text-align:center"><div style="margin-bottom:16px;font-size:2rem">🔒</div>正在導向藍新付款頁面...</div>';
        document.body.appendChild(payDiv);

        const formContainer = document.createElement('div');
        formContainer.style.display = 'none';
        formContainer.innerHTML = npData.formHtml;
        document.body.appendChild(formContainer);

        const payForm = formContainer.querySelector('form');
        if (payForm) {
          payForm.submit();
        }

      } catch (error) {
        console.error('[CartSystem] Checkout error:', error);
        alert('訂單提交失敗: ' + error.message);
        submitBtn.disabled = false;
        submitBtn.textContent = '確認訂單';
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // CONFIRMATION PAGE
  // ─────────────────────────────────────────────────────────────────

  function showConfirmationPage(orderNumber) {
    injectStyles();

    const pageDiv = document.createElement('div');
    pageDiv.className = 'page neon-confirmation-page';
    pageDiv.id = 'neon-confirmation-page';

    const html = `
      <div class="neon-confirmation-content">
        <div class="neon-confirmation-icon">✓</div>
        <h1 class="neon-confirmation-title">訂單已提交!</h1>
        <div class="neon-confirmation-order-num">訂單編號: ${orderNumber}</div>
        <p class="neon-confirmation-subtitle">
          我們已收到您的訂單。請通過 LINE 與我們聯繫以確認交付詳情。
        </p>
        <div class="neon-confirmation-actions">
          <a href="${LINE_URL}" target="_blank" class="neon-confirmation-btn neon-confirmation-btn-line">
            透過 LINE 聯繫我們
          </a>
          <button type="button" class="neon-confirmation-btn neon-confirmation-btn-home">回到首頁</button>
        </div>
      </div>
    `;

    pageDiv.innerHTML = html;
    document.body.appendChild(pageDiv);

    pageDiv.querySelector('.neon-confirmation-btn-home').addEventListener('click', () => {
      pageDiv.remove();
      document.body.style.overflow = '';
      window.location.href = '/';
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // PAYMENT RESULT PAGE (hash routing) — NewebPay
  // ─────────────────────────────────────────────────────────────────

  /**
   * @param {'success'|'failed'|'processing'} state
   * @param {URLSearchParams} params
   */
  function showPaymentResultPage(state, params) {
    injectStyles();

    // Remove any loading overlay (NewebPay or legacy)
    const loadingEl = document.getElementById('newebpay-redirect')
                   || document.getElementById('ecpay-redirect');
    if (loadingEl) loadingEl.remove();

    const pageDiv = document.createElement('div');
    pageDiv.className = 'page neon-confirmation-page';
    pageDiv.id = 'neon-payment-result-page';

    const orderNo = params.get('order') || '';
    const amount  = params.get('amount') || '';
    const msg     = params.get('msg') || '';

    // 親自帶回訂單前綴是 NLC,要顯示不同的取貨說明
    const isCarryback = orderNo.startsWith('NLC');
    const successSubtitle = isCarryback
      ? `感謝您的購買！我們已收到您的付款。<br>
         商品由賣家親自從越南帶回台灣後，將透過<strong>賣貨便</strong>通知您取貨。<br>
         若有任何問題，請透過 LINE 與我們聯繫。`
      : `感謝您的購買！我們已收到您的付款，將盡快為您出貨。<br>
         如有任何問題，請透過 LINE 與我們聯繫。`;

    let html;
    if (state === 'success') {
      html = `
      <div class="neon-confirmation-content">
        <div class="neon-confirmation-icon" style="background:linear-gradient(135deg,rgba(34,197,94,0.2),rgba(16,185,129,0.2));border-color:rgba(34,197,94,0.4)">✓</div>
        <h1 class="neon-confirmation-title">付款成功！</h1>
        ${orderNo ? `<div class="neon-confirmation-order-num">訂單編號: ${orderNo}</div>` : ''}
        ${amount ? `<div class="neon-confirmation-order-num" style="margin-top:8px;font-size:1.1rem">付款金額: NT$ ${Number(amount).toLocaleString()}</div>` : ''}
        <p class="neon-confirmation-subtitle">
          ${successSubtitle}
        </p>
        <div class="neon-confirmation-actions">
          <a href="${LINE_URL}" target="_blank" class="neon-confirmation-btn neon-confirmation-btn-line">
            透過 LINE 聯繫我們
          </a>
          <button type="button" class="neon-confirmation-btn neon-confirmation-btn-home">回到首頁</button>
        </div>
      </div>
      `;
    } else if (state === 'processing') {
      /* Server couldn't locally verify the signature / decrypt the payload but
         that does NOT mean the payment failed — NotifyURL (server-to-server)
         is the true source of truth and the order may already be marked paid.
         Show a warm "we're verifying" message and tell the customer to wait
         for LINE confirmation. */
      html = `
      <div class="neon-confirmation-content">
        <div class="neon-confirmation-icon" style="background:linear-gradient(135deg,rgba(168,85,247,0.2),rgba(139,92,246,0.2));border-color:rgba(168,85,247,0.4)">⏳</div>
        <h1 class="neon-confirmation-title">付款處理中</h1>
        ${orderNo ? `<div class="neon-confirmation-order-num">訂單編號: ${orderNo}</div>` : ''}
        <p class="neon-confirmation-subtitle">
          我們正在向藍新金流確認您的付款結果。<br>
          若已完成扣款，您的訂單會自動成立，<strong>請勿重複付款</strong>。<br>
          可透過 LINE 提供訂單編號或交易截圖加速確認。
        </p>
        <div class="neon-confirmation-actions">
          <a href="${LINE_URL}" target="_blank" class="neon-confirmation-btn neon-confirmation-btn-line">
            透過 LINE 聯繫我們
          </a>
          <button type="button" class="neon-confirmation-btn neon-confirmation-btn-home">回到首頁</button>
        </div>
      </div>
      `;
    } else {
      html = `
      <div class="neon-confirmation-content">
        <div class="neon-confirmation-icon" style="background:linear-gradient(135deg,rgba(239,68,68,0.2),rgba(220,38,38,0.2));border-color:rgba(239,68,68,0.4)">✗</div>
        <h1 class="neon-confirmation-title">付款未完成</h1>
        ${orderNo ? `<div class="neon-confirmation-order-num">訂單編號: ${orderNo}</div>` : ''}
        ${msg ? `<p class="neon-confirmation-subtitle" style="color:rgba(239,68,68,0.8)">${msg}</p>` : ''}
        <p class="neon-confirmation-subtitle">
          您的付款未能完成。訂單仍然保留，您可以稍後重新付款或透過 LINE 聯繫我們。
        </p>
        <div class="neon-confirmation-actions">
          <a href="${LINE_URL}" target="_blank" class="neon-confirmation-btn neon-confirmation-btn-line">
            透過 LINE 聯繫我們
          </a>
          <button type="button" class="neon-confirmation-btn neon-confirmation-btn-home">回到首頁</button>
        </div>
      </div>
      `;
    }

    pageDiv.innerHTML = html;
    document.body.appendChild(pageDiv);
    document.body.style.overflow = 'hidden';

    pageDiv.querySelector('.neon-confirmation-btn-home').addEventListener('click', () => {
      pageDiv.remove();
      document.body.style.overflow = '';
      // Clean up URL
      history.replaceState(null, '', '/');
    });
  }

  // ── Check for NewebPay payment result on page load ──
  function checkPaymentResult() {
    const hash = window.location.hash;
    const params = new URLSearchParams(window.location.search);
    const statusParam = (params.get('status') || '').toLowerCase();

    if (hash === '#order-success' || statusParam === 'paid') {
      showPaymentResultPage('success', params);
    } else if (hash === '#order-processing' || statusParam === 'processing') {
      /* Server couldn't verify locally; show neutral processing page rather
         than the scary failure page. Real status comes from NotifyURL. */
      showPaymentResultPage('processing', params);
    } else if (hash === '#order-failed' || statusParam === 'failed') {
      showPaymentResultPage('failed', params);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // CART ICON
  // ─────────────────────────────────────────────────────────────────

  function renderCartIcon() {
    const count = CartState.getCount();
    const html = `
      <div class="neon-cart-icon-wrapper">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="9" cy="21" r="1"></circle>
          <circle cx="20" cy="21" r="1"></circle>
          <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path>
        </svg>
        ${count > 0 ? `<span class="neon-cart-badge">${count}</span>` : ''}
      </div>
    `;
    return html;
  }

  function updateCartIcon() {
    const icon = document.querySelector('.neon-cart-icon-wrapper');
    if (!icon) return;

    const count = CartState.getCount();
    const badge = icon.querySelector('.neon-cart-badge');

    if (count > 0) {
      if (!badge) {
        const newBadge = document.createElement('span');
        newBadge.className = 'neon-cart-badge';
        newBadge.textContent = count;
        icon.appendChild(newBadge);
      } else {
        badge.textContent = count;
      }
    } else {
      if (badge) badge.remove();
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // ADD TO CART BUTTON
  // ─────────────────────────────────────────────────────────────────

  function renderAddToCartButton(product) {
    // 顯示尺寸表按鈕的條件:
    //   1) product.size_chart 存在 (由 scripts/translate-vn-sizes.js 寫入)
    //   2) 後台 SITE_SETTINGS 為該品牌設定了尺寸表
    //   3) 否則一律顯示，由 sizechart.js 的 modal 顯示「尚無資料」提示
    const hasInlineSC = !!(product && product.size_chart);
    const hasBrandSC  = !!(window.SITE_SETTINGS && (window.SITE_SETTINGS['sizechart_' + product.brand_id] || window.SITE_SETTINGS['sizechart_img_' + product.brand_id]));
    const showSC      = hasInlineSC || hasBrandSC || true; // 永遠顯示，UX 比較一致
    const scBtn = showSC
      ? `<button type="button" class="neon-sizechart-btn"
           onclick="event.stopPropagation();window.showSizeChart('${product.id}')">\ud83d\udccf \u5c3a\u5bf8\u8868</button>`
      : '';

    // sold_out 商品 — 加入購物車按鈕 disabled 並改顯示「已售完」
    // 仍保留尺寸表按鈕,讓客人可以先看尺碼以便等補貨時參考
    if (product && product.sold_out) {
      return `
        <div class="neon-card-actions">
          ${scBtn}
          <button type="button" class="neon-add-to-cart-btn is-sold-out" disabled
                  aria-label="\u5df2\u552e\u5b8c">
            \u5df2\u552e\u5b8c
          </button>
        </div>
      `;
    }

    const html = `
      <div class="neon-card-actions">
        ${scBtn}
        <button type="button" class="neon-add-to-cart-btn" data-product-id="${product.id}">
          \u52A0\u5165\u8CFC\u7269\u8ECA
        </button>
      </div>
    `;
    return html;
  }

  function attachAddToCartHandler(product) {
    const btn = document.querySelector(`[data-product-id="${product.id}"]`);
    if (!btn) return;

    btn.addEventListener('click', async () => {
      injectStyles();
      const result = await showSizeShippingModal(product);
      if (!result) return;

      CartState.add(product, result.size, result.shipping);
      updateCartIcon();

      // Animate badge
      const icon = document.querySelector('.neon-cart-icon-wrapper');
      if (icon) {
        icon.style.animation = 'none';
        setTimeout(() => {
          icon.style.animation = 'badgePulse 0.3s ease';
        }, 10);
      }

      // Show brief feedback
      const originalText = btn.textContent;
      btn.textContent = '✓ 已加入購物車';
      btn.style.pointerEvents = 'none';
      setTimeout(() => {
        btn.textContent = originalText;
        btn.style.pointerEvents = 'auto';
      }, 2000);
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // INITIALIZATION
  // ─────────────────────────────────────────────────────────────────

  function init() {
    injectStyles();
    updateCartIcon();
    checkPaymentResult();
  }

  // ─────────────────────────────────────────────────────────────────
  // EXPOSE GLOBAL API
  // ─────────────────────────────────────────────────────────────────

  window.CartSystem = {
    addToCart: (product, size, shippingMethod) => CartState.add(product, size, shippingMethod),
    removeFromCart: (index) => CartState.remove(index),
    updateQuantity: (index, qty) => CartState.update(index, qty),
    updateItemField: (index, patch) => CartState.updateField(index, patch),
    getCart: () => CartState.get(),
    getCartCount: () => CartState.getCount(),
    getCartTotal: () => CartState.getTotal(),
    clearCart: () => CartState.clear(),
    openCart: openCartDrawer,
    closeCart: closeCartDrawer,
    // Phase 2.2 — 折抵金開關 (購物車抽屜 / 結帳頁的 checkbox 直接呼叫)
    getUseCredit: () => CartState.getUseCredit(),
    setUseCredit: async (use) => {
      CartState.setUseCredit(!!use);
      // 1) 抽屜如果開著就重畫
      try { if (typeof cartDrawerOpen !== 'undefined' && cartDrawerOpen) renderCartContent(); } catch {}
      // 2) 結帳頁存在就重畫 (保留已填寫的表單值)
      try {
        const page = document.getElementById('neon-checkout-page');
        if (!page) return;
        const mode = page.dataset.checkoutMode || 'shipping';
        // snapshot 所有 input / textarea / select 的值,等重畫完再灌回去
        const snap = {};
        page.querySelectorAll('input, textarea, select').forEach(el => {
          if (!el.id) return;
          if (el.type === 'checkbox' || el.type === 'radio') snap[el.id] = { checked: el.checked };
          else                                                snap[el.id] = { value: el.value };
        });
        page.remove();
        document.body.style.overflow = '';
        const reopener = mode === 'carryback' ? showCarrybackCheckoutPage : showCheckoutPage;
        await reopener();
        // restore form values
        Object.entries(snap).forEach(([id, saved]) => {
          const el = document.getElementById(id);
          if (!el) return;
          if ('checked' in saved) el.checked = saved.checked;
          else if (saved.value)   el.value   = saved.value;
        });
      } catch (err) {
        console.warn('[CartSystem] setUseCredit re-render failed:', err);
      }
    },
  };

  window.renderCartIcon = renderCartIcon;

  window.renderAddToCartButton = (product) => {
    // This returns HTML; caller needs to insert into DOM and call attachAddToCartHandler
    return renderAddToCartButton(product);
  };

  // Also provide direct attach function for convenience
  window.attachAddToCartHandler = attachAddToCartHandler;

  // Initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
