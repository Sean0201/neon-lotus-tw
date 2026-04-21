/**
 * /api/ecpay-return.js — Vercel Serverless Function (Node.js)
 * 付款完成後，綠界將使用者導回此頁面 (OrderResultURL)
 *
 * 綠界會 POST 付款結果，此 endpoint 將使用者 redirect 回前端頁面
 * 並帶上付款狀態讓前端顯示結果
 */

import crypto from 'crypto';

export const config = { runtime: 'nodejs', maxDuration: 15 };

/* ── 驗證 CheckMacValue (同 ecpay-notify.js) ─────── */
function verifyCheckMacValue(params, hashKey, hashIV) {
  const receivedMac = params.CheckMacValue;
  if (!receivedMac) return false;

  const filtered = { ...params };
  delete filtered.CheckMacValue;

  const sorted = Object.keys(filtered).sort().reduce((acc, key) => {
    acc[key] = filtered[key];
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

  const computed = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
  return computed === receivedMac;
}

/* ── Main Handler ───────────────────────────────────── */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  try {
    const params = req.body;
    const HASH_KEY = process.env.ECPAY_HASH_KEY;
    const HASH_IV  = process.env.ECPAY_HASH_IV;
    const SITE_URL = process.env.SITE_URL || 'https://neon-lotus-tw.vercel.app';

    // 驗證簽名
    const isValid = verifyCheckMacValue(params, HASH_KEY, HASH_IV);

    const {
      MerchantTradeNo,
      RtnCode,
      RtnMsg,
      TradeAmt,
    } = params;

    const isPaid = isValid && String(RtnCode) === '1';

    // 導回前端，帶上結果參數
    const redirectUrl = new URL(SITE_URL);
    redirectUrl.hash = isPaid ? 'order-success' : 'order-failed';
    redirectUrl.searchParams.set('order', MerchantTradeNo || '');
    redirectUrl.searchParams.set('amount', TradeAmt || '');
    redirectUrl.searchParams.set('status', isPaid ? 'paid' : 'failed');
    if (!isPaid) redirectUrl.searchParams.set('msg', RtnMsg || '');

    return res.redirect(302, redirectUrl.toString());

  } catch (err) {
    console.error('[ECPay Return] Error:', err);
    const SITE_URL = process.env.SITE_URL || 'https://neon-lotus-tw.vercel.app';
    return res.redirect(302, `${SITE_URL}#order-failed`);
  }
}
