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
  const LINE_OFFICIAL = '@590eckna';
  const LINE_URL = 'https://line.me/R/ti/p/@590eckna';

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
        image_url: product.images?.cover || product.cover_image || '',
      };

      items.push(item);
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
        background: ${colors.black};
        color: ${colors.white};
        padding-bottom: 40px;
      }

      .neon-checkout-header {
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
        background: ${colors.black};
        color: ${colors.white};
        min-height: 100vh;
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
        const itemEl = document.createElement('div');
        itemEl.className = 'neon-cart-item';
        itemEl.innerHTML = `
          <div class="neon-cart-item-image">
            <img src="${item.image_url || ''}" alt="${item.product_name}" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2280%22 height=%2280%22%3E%3Crect fill=%22%23333%22 width=%2280%22 height=%2280%22/%3E%3C/svg%3E'" />
          </div>
          <div class="neon-cart-item-details">
            <div>
              <div class="neon-cart-item-name">${item.product_name}</div>
              <div class="neon-cart-item-meta">
                ${item.size ? `尺寸: ${item.size} | ` : ''}${item.shipping_method === 'shipping' ? '國際配送' : '親自運送'}
              </div>
              <div class="neon-cart-item-price">NT$ ${(item.unit_price || 0).toLocaleString()}</div>
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

        content.appendChild(itemEl);
      });
    }

    // Render footer
    const total = CartState.getTotal();
    footer.innerHTML = `
      <div class="neon-cart-subtotal">
        <span class="neon-cart-subtotal-label">小計:</span>
        <span class="neon-cart-subtotal-value">NT$ ${total.toLocaleString()}</span>
      </div>
      <div class="neon-cart-actions">
        <button class="neon-cart-btn neon-cart-btn-checkout">前往結帳</button>
        <button class="neon-cart-btn neon-cart-btn-continue">繼續購物</button>
      </div>
    `;

    footer.querySelector('.neon-cart-btn-checkout').addEventListener('click', () => {
      closeCartDrawer();
      showCheckoutPage();
    });

    footer.querySelector('.neon-cart-btn-continue').addEventListener('click', closeCartDrawer);
  }

  function openCartDrawer() {
    if (cartDrawerOpen) return;
    cartDrawerOpen = true;
    createCartDrawer();
    renderCartContent();
    document.getElementById('neon-cart-drawer').classList.add('open');
    document.getElementById('neon-cart-overlay').classList.add('open');
    document.body.style.overflow = 'hidden';
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
          html += `<button class="neon-size-btn" data-size="${sz.label}" ${disabled}>${sz.label}</button>`;
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
            <button class="neon-shipping-btn active" data-shipping="shipping">國際配送</button>
            <button class="neon-shipping-btn" data-shipping="carryback">親自運送</button>
          </div>
        </div>
        <div class="neon-modal-actions">
          <button class="neon-modal-btn neon-modal-btn-confirm">確認</button>
          <button class="neon-modal-btn neon-modal-btn-cancel">取消</button>
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
  // CHECKOUT PAGE
  // ─────────────────────────────────────────────────────────────────

  async function showCheckoutPage() {
    injectStyles();

    // Create page div
    const pageDiv = document.createElement('div');
    pageDiv.className = 'page neon-checkout-page';
    pageDiv.id = 'neon-checkout-page';

    const items = CartState.get();
    const total = CartState.getTotal();

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

    const html = `
      <div class="neon-checkout-header">
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

            <div class="neon-checkout-form-group">
              <label class="neon-checkout-form-label">地址 *</label>
              <input class="neon-checkout-form-input" id="checkout-address" type="text" placeholder="送貨地址" required />
            </div>

            <div class="neon-checkout-form-group">
              <label class="neon-checkout-form-label">配送方式 *</label>
              <div class="neon-shipping-toggle">
                <button class="neon-shipping-option active" data-shipping="shipping">國際配送</button>
                <button class="neon-shipping-option" data-shipping="carryback">親自運送</button>
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
                <span class="neon-checkout-summary-label">小計:</span>
                <span class="neon-checkout-summary-value">NT$ ${total.toLocaleString()}</span>
              </div>
              <div class="neon-checkout-summary-total">
                <span>合計:</span>
                <span class="neon-checkout-summary-total-value">NT$ ${total.toLocaleString()}</span>
              </div>
            </div>
            <button class="neon-checkout-btn" id="checkout-submit">確認訂單</button>
          </div>
        </div>
      </div>
    `;

    pageDiv.innerHTML = html;
    document.body.appendChild(pageDiv);

    // Handle shipping option toggle
    let selectedShipping = 'shipping';
    pageDiv.querySelectorAll('.neon-shipping-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        pageDiv.querySelectorAll('.neon-shipping-option').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        selectedShipping = btn.dataset.shipping;
      });
    });

    // Handle submit
    pageDiv.querySelector('#checkout-submit').addEventListener('click', async () => {
      const name = pageDiv.querySelector('#checkout-name').value.trim();
      const phone = pageDiv.querySelector('#checkout-phone').value.trim();
      const email = pageDiv.querySelector('#checkout-email').value.trim();
      const address = pageDiv.querySelector('#checkout-address').value.trim();
      const note = pageDiv.querySelector('#checkout-note').value.trim();

      if (!name || !phone || !email || !address) {
        alert('請填入所有必要欄位');
        return;
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

        // Insert order
        const { data: orderData, error: orderError } = await supabase
          .from('orders')
          .insert([
            {
              order_number: orderNumber,
              customer_name: name,
              customer_phone: phone,
              customer_email: email,
              customer_address: address,
              shipping_method: selectedShipping,
              status: 'pending',
              subtotal: total,
              shipping_fee: 0,
              total: total,
              note: note,
              line_notified: false,
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
        }));

        const { error: itemsError } = await supabase
          .from('order_items')
          .insert(orderItems);

        if (itemsError) throw new Error(itemsError.message);

        // Clear cart
        CartState.clear();
        updateCartIcon();

        // Remove checkout page
        pageDiv.remove();

        // Show confirmation
        showConfirmationPage(orderNumber);
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
          <button class="neon-confirmation-btn neon-confirmation-btn-home">回到首頁</button>
        </div>
      </div>
    `;

    pageDiv.innerHTML = html;
    document.body.appendChild(pageDiv);

    pageDiv.querySelector('.neon-confirmation-btn-home').addEventListener('click', () => {
      pageDiv.remove();
      // Navigate to home or refresh
      window.location.href = '/';
    });
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
    const html = `
      <button class="neon-add-to-cart-btn" data-product-id="${product.id}">
        加入購物車
      </button>
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
  }

  // ─────────────────────────────────────────────────────────────────
  // EXPOSE GLOBAL API
  // ─────────────────────────────────────────────────────────────────

  window.CartSystem = {
    addToCart: (product, size, shippingMethod) => CartState.add(product, size, shippingMethod),
    removeFromCart: (index) => CartState.remove(index),
    updateQuantity: (index, qty) => CartState.update(index, qty),
    getCart: () => CartState.get(),
    getCartCount: () => CartState.getCount(),
    getCartTotal: () => CartState.getTotal(),
    clearCart: () => CartState.clear(),
    openCart: openCartDrawer,
    closeCart: closeCartDrawer,
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
