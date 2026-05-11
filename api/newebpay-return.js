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

/* Coerce Vercel's req.body into a plain object regardless of how it arrived.
   Default body-parser usually hands us an object, but if it ever gives us a
   string (raw urlencoded / JSON) we still want TradeInfo + TradeSha. */
function normalizeBody(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    if (trimmed.startsWith('{')) {
      try { return JSON.parse(trimmed); } catch { /* fall through */ }
    }
    try { return Object.fromEntries(new URLSearchParams(trimmed)); }
    catch { return {}; }
  }
  return {};
}

/* Map NewebPay outcome to a tri-state our front-end can render properly.
   - 'paid'       → 付款成功 (確認)
   - 'failed'     → 確認失敗 (有解密+簽章,但 Status/RespondCode 顯示失敗)
   - 'processing' → 無法在此端驗證 (簽章 / 解密失敗),不要嚇到客人
                    真正成敗以 NotifyURL + 後台訂單為準 */
function classifyOutcome({ verified, decryptOk, status, respondCode }) {
  if (!verified || !decryptOk) return 'processing';
  const s = String(status || '').toUpperCase();
  const c = String(respondCode || '').toUpperCase();
  // RespondCode 只對 CREDIT 必填; VACC/CVS/BARCODE 等可能不帶
  if (s === 'SUCCESS' && (c === '' || c === '00')) return 'paid';
  return 'failed';
}

export default async function handler(req, res) {
  // 藍新可能 GET 或 POST,主要是 POST
  const method = req.method;
  const SITE_URL = (process.env.SITE_URL || 'https://neon-lotus-tw.vercel.app').trim();

  try {
    if (method !== 'POST' && method !== 'GET') {
      return res.status(405).send('Method not allowed');
    }

    /* 修剪空白 — Vercel env vars 偶爾帶尾端空白會讓 SHA 驗證失敗 */
    const HASH_KEY = (process.env.NEWEBPAY_HASH_KEY || '').trim();
    const HASH_IV  = (process.env.NEWEBPAY_HASH_IV  || '').trim();

    const rawBody = method === 'POST' ? req.body : req.query;
    const body = normalizeBody(rawBody);
    const { TradeInfo, TradeSha } = body;

    let verified = false;
    let decryptOk = false;
    let payloadStatus = '';
    let respondCode = '';
    let merchantOrderNo = '';
    let amt = '';
    let msg = '';
    let payload = null;

    if (TradeInfo && TradeSha) {
      verified = verifyTradeSha(TradeInfo, TradeSha, HASH_KEY, HASH_IV);
      if (verified) {
        try {
          const decryptedJson = aesDecrypt(TradeInfo, HASH_KEY, HASH_IV);
          payload = JSON.parse(decryptedJson);
          decryptOk = true;
          const result = payload.Result || {};
          payloadStatus   = String(payload.Status || '');
          respondCode     = String(result.RespondCode || '');
          merchantOrderNo = String(result.MerchantOrderNo || '');
          amt             = String(result.Amt || '');
          msg             = String(payload.Message || '');
        } catch (e) {
          console.error('[NewebPay Return] decrypt/parse error:', e.message);
        }
      } else {
        console.error('[NewebPay Return] TradeSha invalid');
      }
    } else {
      console.error('[NewebPay Return] Missing TradeInfo or TradeSha. bodyType=' + typeof rawBody + ' keys=' + Object.keys(body || {}).join(','));
    }

    const outcome = classifyOutcome({ verified, decryptOk, status: payloadStatus, respondCode });

    /* 詳細 log,方便從 Vercel function logs 倒查 */
    console.log('[NewebPay Return] decision=' + outcome
      + ' method=' + method
      + ' hasTradeInfo=' + !!TradeInfo
      + ' hasTradeSha=' + !!TradeSha
      + ' verified=' + verified
      + ' decryptOk=' + decryptOk
      + ' payloadStatus=' + payloadStatus
      + ' respondCode=' + respondCode
      + ' merchantOrderNo=' + merchantOrderNo);

    // 導回前端,帶上結果參數 (cart.js 的 checkPaymentResult 會撈)
    const redirectUrl = new URL(SITE_URL);
    if (outcome === 'paid')        redirectUrl.hash = 'order-success';
    else if (outcome === 'failed') redirectUrl.hash = 'order-failed';
    else                            redirectUrl.hash = 'order-processing';
    if (merchantOrderNo) redirectUrl.searchParams.set('order',  merchantOrderNo);
    if (amt)             redirectUrl.searchParams.set('amount', amt);
    redirectUrl.searchParams.set('status', outcome === 'paid' ? 'paid' : outcome === 'failed' ? 'failed' : 'processing');
    if (outcome === 'failed' && msg) redirectUrl.searchParams.set('msg', msg);

    return res.redirect(302, redirectUrl.toString());

  } catch (err) {
    /* 即使內部錯誤,也不應該對顧客顯示「付款失敗」(NotifyURL 才是真正的成敗來源)。
       導去 processing 頁面,顯示「付款處理中」訊息,並請客人透過 LINE 聯繫。 */
    console.error('[NewebPay Return] Unhandled error:', err && err.stack || err);
    return res.redirect(302, `${SITE_URL}/?status=processing#order-processing`);
  }
}
