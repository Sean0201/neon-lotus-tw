/**
 * /api/logistics-map.js — Vercel Serverless Function (Node.js)
 * 產生綠界超商門市地圖選擇頁面
 *
 * 前端呼叫此 API 取得 HTML 表單 → 開啟新視窗讓使用者選擇超商門市
 * 使用者選完後，綠界會 POST 回 ServerReplyURL，再由前端 callback 接收
 *
 * GET /api/logistics-map?type=FAMI&orderId=NL20260421001
 *
 * 環境變數:
 *   ECPAY_LOGISTICS_MERCHANT_ID
 *   ECPAY_LOGISTICS_HASH_KEY
 *   ECPAY_LOGISTICS_HASH_IV
 *   ECPAY_MAP_API_URL — 測試: https://logistics-stage.ecpay.com.tw/Express/map
 *                        正式: https://logistics.ecpay.com.tw/Express/map
 *   SITE_URL
 */

import crypto from 'crypto';

export const config = { runtime: 'nodejs20.x', maxDuration: 15 };

function generateCheckMacValue(params, hashKey, hashIV) {
  const sorted = Object.keys(params).sort().reduce((acc, key) => {
    acc[key] = params[key];
    return acc;
  }, {});

  let raw = `HashKey=${hashKey}`;
  for (const [k, v] of Object.entries(sorted)) {
    raw += `&${k}=${v}`;
  }
  raw += `&HashIV=${hashIV}`;

  raw = encodeURIComponent(raw).toLowerCase();
  raw = raw.replace(/%2d/g, '-')
           .replace(/%5f/g, '_')
           .replace(/%2e/g, '.')
           .replace(/%21/g, '!')
           .replace(/%2a/g, '*')
           .replace(/%28/g, '(')
           .replace(/%29/g, ')')
           .replace(/%20/g, '+');

  return crypto.createHash('md5').update(raw).digest('hex').toUpperCase();
}

export default async function handler(req, res) {
  // 支援 GET (前端直接開啟) 和 POST (前端 fetch)
  const query = req.method === 'GET' ? req.query : req.body;

  const {
    type = 'UNIMART',  // FAMI | UNIMART | HILIFE
    orderId = '',
  } = query;

  const MERCHANT_ID = process.env.ECPAY_LOGISTICS_MERCHANT_ID || process.env.ECPAY_MERCHANT_ID;
  const HASH_KEY    = process.env.ECPAY_LOGISTICS_HASH_KEY    || process.env.ECPAY_HASH_KEY;
  const HASH_IV     = process.env.ECPAY_LOGISTICS_HASH_IV     || process.env.ECPAY_HASH_IV;
  const MAP_URL     = process.env.ECPAY_MAP_API_URL;
  const SITE_URL    = process.env.SITE_URL || 'https://neon-lotus-tw.vercel.app';

  if (!MERCHANT_ID || !HASH_KEY || !HASH_IV || !MAP_URL) {
    return res.status(500).json({ error: 'ECPay logistics map credentials not configured' });
  }

  const params = {
    MerchantID:       MERCHANT_ID,
    MerchantTradeNo:  orderId || `MAP${Date.now()}`,
    LogisticsType:    'CVS',
    LogisticsSubType: type,
    IsCollection:     'N',
    // 使用者選完門市後，綠界會 POST 到這個 URL
    ServerReplyURL:   `${SITE_URL}/api/logistics-map-callback`,
  };

  params.CheckMacValue = generateCheckMacValue(params, HASH_KEY, HASH_IV);

  // 產生自動提交表單 (前端開新視窗載入此 HTML)
  const formInputs = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(String(v))}" />`)
    .join('\n');

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>選擇取貨門市</title></head>
<body>
  <form id="map-form" method="POST" action="${MAP_URL}">
    ${formInputs}
  </form>
  <script>document.getElementById('map-form').submit();</script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
}
