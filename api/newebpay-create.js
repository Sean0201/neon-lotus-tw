/**
 * /api/newebpay-create.js — Vercel Serverless Function (Node.js)
 * 建立藍新金流 (NewebPay) 訂單,回傳 HTML 表單讓前端自動 POST 至藍新
 *
 * POST body: { items, totalAmount, buyerName, buyerEmail, buyerPhone, orderId? }
 *
 * 環境變數 (Vercel Dashboard → Settings → Environment Variables):
 *   NEWEBPAY_MERCHANT_ID — 商店代碼 (e.g. MS159001264)
 *   NEWEBPAY_HASH_KEY    — 32 字元
 *   NEWEBPAY_HASH_IV     — 16 字元
 *   NEWEBPAY_API_URL     — 測試: https://ccore.newebpay.com/MPG/mpg_gateway
 *                          正式: https://core.newebpay.com/MPG/mpg_gateway
 *   SITE_URL             — e.g. https://neon-lotus-tw.vercel.app
 *   NEWEBPAY_PAYMENT_METHODS — 開放付款方式 (逗號分隔,依商店實際開通狀態)
 *                              測試示例: CREDIT,APPLEPAY,GOOGLEPAY,SAMSUNGPAY,WEBATM,VACC,CVS,BARCODE
 *                              正式示例: CREDIT,APPLEPAY,UNIONPAY,VACC,CVS
 *                              支援: CREDIT, APPLEPAY, GOOGLEPAY, SAMSUNGPAY,
 *                                    UNIONPAY, VACC, WEBATM, CVS, BARCODE, LINEPAY
 */

import crypto from 'crypto';

export const config = { runtime: 'nodejs', maxDuration: 30 };

/* ── 滿額折扣 (TIER DISCOUNTS) ───────────────────────
   * 必須與 cart.js DISCOUNT_TIERS 保持同步。
   * 用於 server-side 重新驗證 totalAmount,避免前端被竄改後送錯金額。 */
const DISCOUNT_TIERS = {
  // ⚠️ 必須與 cart.js DISCOUNT_TIERS 完全同步, 否則 server 重新驗證會 reject
  shipping: [
    { min: 5000,  rate: 0.95 },
    { min: 10000, rate: 0.92 },
    { min: 19000, rate: 0.88 },
  ],
  carryback: [
    { min: 4000,  rate: 0.95 },
    { min: 8000,  rate: 0.92 },
    { min: 15000, rate: 0.88 },
  ],
  default: [
    { min: 4000,  rate: 0.95 },
    { min: 8000,  rate: 0.92 },
    { min: 15000, rate: 0.88 },
  ],
};

function serverPickTier(shippingMethod, subtotal) {
  const tiers = DISCOUNT_TIERS[shippingMethod] || DISCOUNT_TIERS.default;
  let best = null;
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    if (subtotal >= t.min) {
      if (!best || t.rate < best.rate) best = t;
    }
  }
  return best;
}

/* Recalculate expected total from items + shippingFee. Returns
   { expectedTotal, expectedDiscount, groups: [{shipping_method, subtotal, tier, total}] }. */
function recalculateOrder(items, shippingFee) {
  const groups = {};
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const sm = it.shipping_method || 'default';
    if (!groups[sm]) groups[sm] = 0;
    const qty = Number(it.quantity) || 0;
    const price = Number(it.price) || 0;
    groups[sm] += price * qty;
  }
  const groupSummaries = [];
  let discountedSubtotal = 0;
  let rawSubtotal = 0;
  Object.keys(groups).forEach((sm) => {
    const sub = groups[sm];
    rawSubtotal += sub;
    const tier = serverPickTier(sm, sub);
    const groupTotal = tier ? Math.round(sub * tier.rate) : sub;
    discountedSubtotal += groupTotal;
    groupSummaries.push({
      shipping_method: sm,
      subtotal: sub,
      tier_rate: tier ? tier.rate : 1,
      total: groupTotal,
    });
  });
  const fee = Number(shippingFee) || 0;
  return {
    rawSubtotal,
    discountedSubtotal,
    expectedDiscount: rawSubtotal - discountedSubtotal,
    expectedTotal: discountedSubtotal + fee,
    shippingFee: fee,
    groups: groupSummaries,
  };
}

/* ── AES-256-CBC 加密 (藍新規格) ──────────────────── */
function aesEncrypt(plainText, key, iv) {
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(true);
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
}

/* ── 計算 TradeSha (SHA256 大寫) ─────────────────── */
function generateTradeSha(tradeInfo, key, iv) {
  const raw = `HashKey=${key}&${tradeInfo}&HashIV=${iv}`;
  return crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
}

/* ── 把參數物件轉成 query string (TradeInfo 用) ──── */
function buildQueryString(params) {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/* ── 產生唯一交易編號 (藍新限制 1-20 碼,英數+_) ──── */
function generateOrderNo() {
  const now = new Date();
  const ts = now.getFullYear().toString()
    + String(now.getMonth() + 1).padStart(2, '0')
    + String(now.getDate()).padStart(2, '0')
    + String(now.getHours()).padStart(2, '0')
    + String(now.getMinutes()).padStart(2, '0')
    + String(now.getSeconds()).padStart(2, '0');
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `NL${ts}${rand}`; // NL + 14 + 4 = 20 chars
}

function sanitizeOrderNo(raw) {
  return raw.replace(/[^A-Za-z0-9_]/g, '').substring(0, 20);
}

/* ── HTML escape ──────────────────────────────────── */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Main Handler ───────────────────────────────── */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      items,        // [{ name, quantity, price, shipping_method? }]
      totalAmount,  // 整數 (TWD) — 應為折扣後 + 運費的「應付總額」
      shippingFee,  // 整數 (TWD) — 域內運費 (超商 70 / 宅配 120 / 親送 0)
      discount,     // 整數 (TWD) — 前端宣告的滿額折扣金額,後台再核對
      buyerName,
      buyerEmail,
      buyerPhone,
      orderId,      // 可選: 前端已建立的訂單號
    } = req.body;

    const MERCHANT_ID = process.env.NEWEBPAY_MERCHANT_ID;
    const HASH_KEY    = process.env.NEWEBPAY_HASH_KEY;
    const HASH_IV     = process.env.NEWEBPAY_HASH_IV;
    const API_URL     = process.env.NEWEBPAY_API_URL
                        || 'https://ccore.newebpay.com/MPG/mpg_gateway';  // 預設測試
    const SITE_URL    = process.env.SITE_URL || 'https://neon-lotus-tw.vercel.app';

    // 付款方式 (依商店實際開通狀態,以 env var 控制 sandbox 與 production 不同清單)
    // 範例: CREDIT,APPLEPAY,VACC,WEBATM,CVS
    const PAYMENT_METHODS = (process.env.NEWEBPAY_PAYMENT_METHODS || 'CREDIT,VACC')
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);

    if (!MERCHANT_ID || !HASH_KEY || !HASH_IV) {
      return res.status(500).json({ error: 'NewebPay credentials not configured' });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items required' });
    }
    if (!totalAmount || totalAmount <= 0) {
      return res.status(400).json({ error: 'totalAmount must be positive' });
    }

    /* ── Server-side 滿額折扣重新驗證 ────────────────
       * 前端送來 totalAmount + items[].shipping_method,後端重新計算
       * 並比對。容忍 ±5 元 rounding 誤差。若舊版前端沒送 shipping_method,
       * default group fallback (4K/8K/15K) 會被用,通常仍能正確匹配。 */
    const recalc = recalculateOrder(items, shippingFee);
    const declaredTotal = Math.round(Number(totalAmount));
    const expectedTotal = Math.round(recalc.expectedTotal);
    const totalDiff = Math.abs(declaredTotal - expectedTotal);
    const TOLERANCE = 5; // NT$5 rounding 容忍
    if (totalDiff > TOLERANCE) {
      console.warn('[NewebPay create] totalAmount mismatch', {
        declared: declaredTotal,
        expected: expectedTotal,
        diff: totalDiff,
        recalc,
        items,
      });
      return res.status(400).json({
        error: '訂單金額計算不一致,請重新整理購物車再試',
        debug: { declared: declaredTotal, expected: expectedTotal },
      });
    }

    // Server-recalculated total is the source of truth (use it for Amt)
    const finalAmt = expectedTotal;

    // 訂單號
    const merchantOrderNo = sanitizeOrderNo(orderId || generateOrderNo());

    // 商品描述 (藍新限制 50 字)
    const itemDesc = items
      .map(i => `${i.name} x${i.quantity}`)
      .join(', ')
      .substring(0, 50);

    // ── TradeInfo 內容 (URL-encoded query string) ──
    const tradeInfoObj = {
      MerchantID:      MERCHANT_ID,
      RespondType:     'JSON',
      TimeStamp:       String(Math.floor(Date.now() / 1000)),
      Version:         '2.0',
      MerchantOrderNo: merchantOrderNo,
      Amt:             finalAmt,
      ItemDesc:        itemDesc,
      ReturnURL:       `${SITE_URL}/api/newebpay-return`,    // 前台導回 (有 TradeInfo,可判定成敗)
      NotifyURL:       `${SITE_URL}/api/newebpay-notify`,    // 後台通知 (server-to-server)
      /* ClientBackURL — 客戶點「返回商店」按鈕後的目的地。
         藍新只是純 GET 跳轉,不會帶 TradeInfo,所以我們無法在此判斷成敗。
         導向「付款處理中」頁面 + 帶訂單編號,讓客戶看到自己的訂單編號,
         並請他們勿重複付款 (NotifyURL 才是真正的成敗來源)。 */
      ClientBackURL:   `${SITE_URL}/?order=${encodeURIComponent(merchantOrderNo)}&status=processing#order-processing`,
      Email:           buyerEmail || '',
      LoginType:       0,                                      // 不需登入藍新會員
    };

    // ── 動態加入開放的付款方式 (來自 NEWEBPAY_PAYMENT_METHODS env var) ──
    PAYMENT_METHODS.forEach(method => {
      tradeInfoObj[method] = 1;
    });

    const tradeInfoQuery = buildQueryString(tradeInfoObj);

    // ── AES + SHA 加密 ──
    const tradeInfo = aesEncrypt(tradeInfoQuery, HASH_KEY, HASH_IV);
    const tradeSha  = generateTradeSha(tradeInfo, HASH_KEY, HASH_IV);

    // ── 送至藍新的最終參數 ──
    const params = {
      MerchantID: MERCHANT_ID,
      TradeInfo:  tradeInfo,
      TradeSha:   tradeSha,
      Version:    '2.0',
    };

    // ── 自動提交的 HTML 表單 ──
    const formInputs = Object.entries(params)
      .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}" />`)
      .join('\n');

    const html = `
      <html>
      <body>
        <form id="newebpay-form" method="POST" action="${API_URL}">
          ${formInputs}
        </form>
        <script>document.getElementById('newebpay-form').submit();</script>
      </body>
      </html>`;

    const accept = req.headers['accept'] || '';
    if (accept.includes('text/html')) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send(html);
    }

    return res.status(200).json({
      success: true,
      orderNo: merchantOrderNo,
      formHtml: html,
      // 以下僅 debug 用,正式環境可移除
      debug: {
        apiUrl: API_URL,
        params,
      },
    });

  } catch (err) {
    console.error('[NewebPay create] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
