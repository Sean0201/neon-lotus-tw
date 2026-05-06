/**
 * /api/newebpay-return.js — Vercel Serverless Function (Node.js)
 * 付款完成後,藍新將使用者瀏覽器導回此 endpoint (ReturnURL)
 *
 * 藍新會 POST 同樣的 TradeInfo / TradeSha 結構,本 endpoint:
 *   1. 驗證 TradeSha
 *   2. 解密 TradeInfo
 *   3. 將使用者 302 導回前端首頁,帶上 hash + query 讓 cart.js 顯示結果頁
 *
 * 注意: NotifyURL 才是金流真正的「結果通知來源」(server-to-server),
 *       本檔案 (ReturnURL) 只負責使用者體驗的導頁,不應更新訂單狀態。
 */

import crypto from 'crypto';

export const config = { runtime: 'nodejs', maxDuration: 15 };

function aesDecrypt(encryptedHex, key, iv) {
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(true);
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function verifyTradeSha(tradeInfo, receivedSha, key, iv) {
  const raw = `HashKey=${key}&${tradeInfo}&HashIV=${iv}`;
  const computed = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
  return computed === String(receivedSha || '').toUpperCase();
}

export default async function handler(req, res) {
  // 藍新可能 GET 或 POST,主要是 POST
  const method = req.method;
  const SITE_URL = process.env.SITE_URL || 'https://neon-lotus-tw.vercel.app';

  try {
    if (method !== 'POST' && method !== 'GET') {
      return res.status(405).send('Method not allowed');
    }

    const HASH_KEY = process.env.NEWEBPAY_HASH_KEY;
    const HASH_IV  = process.env.NEWEBPAY_HASH_IV;

    const body = method === 'POST' ? (req.body || {}) : (req.query || {});
    const { TradeInfo, TradeSha } = body;

    let isPaid = false;
    let merchantOrderNo = '';
    let amt = '';
    let msg = '';

    if (TradeInfo && TradeSha) {
      const validSha = verifyTradeSha(TradeInfo, TradeSha, HASH_KEY, HASH_IV);
      if (validSha) {
        try {
          const decryptedJson = aesDecrypt(TradeInfo, HASH_KEY, HASH_IV);
          const payload = JSON.parse(decryptedJson);
          const result = payload.Result || {};
          isPaid = String(payload.Status) === 'SUCCESS'
                    && String(result.RespondCode || '00') === '00';
          merchantOrderNo = result.MerchantOrderNo || '';
          amt = result.Amt || '';
          msg = payload.Message || '';
        } catch (e) {
          console.error('[NewebPay Return] decrypt/parse error:', e.message);
        }
      } else {
        console.error('[NewebPay Return] TradeSha invalid');
      }
    }

    // 導回前端,帶上結果參數 (cart.js 的 checkPaymentResult 會撈)
    const redirectUrl = new URL(SITE_URL);
    redirectUrl.hash = isPaid ? 'order-success' : 'order-failed';
    redirectUrl.searchParams.set('order',  merchantOrderNo);
    redirectUrl.searchParams.set('amount', amt);
    redirectUrl.searchParams.set('status', isPaid ? 'paid' : 'failed');
    if (!isPaid && msg) redirectUrl.searchParams.set('msg', msg);

    return res.redirect(302, redirectUrl.toString());

  } catch (err) {
    console.error('[NewebPay Return] Error:', err);
    return res.redirect(302, `${SITE_URL}#order-failed`);
  }
}
