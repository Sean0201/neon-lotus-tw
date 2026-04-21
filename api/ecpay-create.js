/**
 * /api/ecpay-create.js — Vercel Serverless Function (Node.js)
 * 建立綠界金流訂單，回傳 HTML 表單讓前端自動 POST 至綠界
 *
 * POST body: { items, totalAmount, buyerName, buyerEmail, buyerPhone }
 *
 * 環境變數 (Vercel Dashboard → Settings → Environment Variables):
 *   ECPAY_MERCHANT_ID
 *   ECPAY_HASH_KEY
 *   ECPAY_HASH_IV
 *   ECPAY_API_URL        — 測試: https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5
 *                           正式: https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5
 *   SITE_URL              — 你的網站網址 e.g. https://neon-lotus-tw.vercel.app
 */

import crypto from 'crypto';

export const config = { runtime: 'nodejs', maxDuration: 30 };

/* ── 綠界 CheckMacValue 簽名 ─────────────────────────── */
function generateCheckMacValue(params, hashKey, hashIV) {
  // 1. 參數依照 key 排序
  const sorted = Object.keys(params).sort().reduce((acc, key) => {
    acc[key] = params[key];
    return acc;
  }, {});

  // 2. 組成 query string
  let raw = `HashKey=${hashKey}`;
  for (const [k, v] of Object.entries(sorted)) {
    raw += `&${k}=${v}`;
  }
  raw += `&HashIV=${hashIV}`;

  // 3. URL encode (小寫)
  raw = encodeURIComponent(raw).toLowerCase();

  // 4. 特殊字元還原 (綠界規格)
  raw = raw.replace(/%2d/g, '-')
           .replace(/%5f/g, '_')
           .replace(/%2e/g, '.')
           .replace(/%21/g, '!')
           .replace(/%2a/g, '*')
           .replace(/%28/g, '(')
           .replace(/%29/g, ')')
           .replace(/%20/g, '+');

  // 5. SHA256 → 大寫
  return crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
}

/* ── 產生唯一交易編號 ────────────────────────────────── */
function generateTradeNo() {
  const now = new Date();
  const ts = now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `NL${ts}${rand}`;  // 最多 20 碼
}

/* ── 格式化日期 (綠界要求 yyyy/MM/dd HH:mm:ss) ──────── */
function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}/${m}/${d} ${h}:${min}:${s}`;
}

/* ── Main Handler ───────────────────────────────────── */
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
      orderId,      // 可選，若前端已建立 Supabase 訂單
    } = req.body;

    const MERCHANT_ID = process.env.ECPAY_MERCHANT_ID;
    const HASH_KEY    = process.env.ECPAY_HASH_KEY;
    const HASH_IV     = process.env.ECPAY_HASH_IV;
    const API_URL     = process.env.ECPAY_API_URL;
    const SITE_URL    = process.env.SITE_URL || 'https://neon-lotus-tw.vercel.app';

    if (!MERCHANT_ID || !HASH_KEY || !HASH_IV) {
      return res.status(500).json({ error: 'ECPay credentials not configured' });
    }

    const tradeNo = orderId || generateTradeNo();
    const tradeDate = formatDate(new Date());

    // 商品名稱 (綠界格式: 品名1 x 數量1 # 品名2 x 數量2)
    const itemName = items
      .map(i => `${i.name} x${i.quantity}`)
      .join('#')
      .substring(0, 200);  // 綠界限制 200 字

    // 建立綠界參數
    const params = {
      MerchantID:        MERCHANT_ID,
      MerchantTradeNo:   tradeNo,
      MerchantTradeDate: tradeDate,
      PaymentType:       'aio',
      TotalAmount:       String(Math.round(totalAmount)),
      TradeDesc:         'Neon Lotus 訂單',
      ItemName:          itemName,
      ReturnURL:         `${SITE_URL}/api/ecpay-notify`,   // 綠界 server-to-server 通知
      OrderResultURL:    `${SITE_URL}/api/ecpay-return`,   // 付款後導回前端
      ChoosePayment:     'ALL',                             // 顯示所有付款方式
      EncryptType:       '1',                               // SHA256
      NeedExtraPaidInfo: 'Y',
    };

    // 可選：帶入買家資訊 (綠界會預填)
    // if (buyerEmail) params.Email = buyerEmail;

    // 簽名
    params.CheckMacValue = generateCheckMacValue(params, HASH_KEY, HASH_IV);

    // 回傳自動提交的 HTML 表單 (前端接收後插入 DOM 即自動導向綠界)
    const formInputs = Object.entries(params)
      .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(String(v))}" />`)
      .join('\n');

    const html = `
      <html>
      <body>
        <form id="ecpay-form" method="POST" action="${API_URL}">
          ${formInputs}
        </form>
        <script>document.getElementById('ecpay-form').submit();</script>
      </body>
      </html>`;

    // 回傳兩種格式：
    // 1. 若前端要自行處理 → 回傳 JSON { formHtml, tradeNo, params }
    // 2. 若要直接導向 → 設 Accept header
    const accept = req.headers['accept'] || '';
    if (accept.includes('text/html')) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send(html);
    }

    return res.status(200).json({
      success: true,
      tradeNo,
      formHtml: html,
      params,  // 方便 debug，正式環境可移除
    });

  } catch (err) {
    console.error('ECPay create error:', err);
    return res.status(500).json({ error: err.message });
  }
}

/* ── HTML escape helper ─────────────────────────────── */
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
}
