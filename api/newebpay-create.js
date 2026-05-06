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
 *
 * 開放付款方式 (依使用者選擇): CREDIT, VACC, WEBATM, CVS, BARCODE
 */

import crypto from 'crypto';

export const config = { runtime: 'nodejs', maxDuration: 30 };

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
      items,        // [{ name, quantity, price }]
      totalAmount,  // 整數 (TWD)
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

    if (!MERCHANT_ID || !HASH_KEY || !HASH_IV) {
      return res.status(500).json({ error: 'NewebPay credentials not configured' });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items required' });
    }
    if (!totalAmount || totalAmount <= 0) {
      return res.status(400).json({ error: 'totalAmount must be positive' });
    }

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
      Amt:             Math.round(totalAmount),
      ItemDesc:        itemDesc,
      ReturnURL:       `${SITE_URL}/api/newebpay-return`,    // 前台導回
      NotifyURL:       `${SITE_URL}/api/newebpay-notify`,    // 後台通知 (server-to-server)
      ClientBackURL:   `${SITE_URL}/`,                        // 取消按鈕回首頁
      Email:           buyerEmail || '',
      LoginType:       0,                                      // 不需登入藍新會員
      // ── 開放的付款方式 ──
      CREDIT:          1,    // 信用卡一次付清
      VACC:            1,    // ATM 轉帳
      WEBATM:          1,    // 網路 ATM
      CVS:             1,    // 超商代碼
      BARCODE:         1,    // 超商條碼
    };

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
