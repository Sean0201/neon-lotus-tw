/**
 * /api/newebpay-notify.js — Vercel Serverless Function (Node.js)
 * 接收藍新金流 Server-to-Server 付款結果通知 (NotifyURL)
 *
 * 藍新 POST 過來的 body:
 *   {
 *     Status:    "SUCCESS" | "...",
 *     MerchantID: "...",
 *     TradeInfo:  "...",   // AES 加密的結果 JSON
 *     TradeSha:   "...",   // 驗證用 SHA256
 *     Version:    "2.0"
 *   }
 *
 * 解密後 TradeInfo 是 JSON:
 *   {
 *     "Status": "SUCCESS",
 *     "Message": "...",
 *     "Result": {
 *       "MerchantID":      "MS...",
 *       "Amt":             1500,
 *       "TradeNo":         "...",        // 藍新交易編號
 *       "MerchantOrderNo": "NL...",      // 我方訂單編號
 *       "PaymentType":     "CREDIT",     // CREDIT/VACC/WEBATM/CVS/BARCODE
 *       "RespondType":     "JSON",
 *       "PayTime":         "2026-05-07 12:34:56",
 *       "RespondCode":     "00",         // "00" = 成功
 *       ...
 *     }
 *   }
 */

import crypto from 'crypto';

export const config = { runtime: 'nodejs', maxDuration: 30 };

/* ── AES-256-CBC 解密 ─────────────────────────── */
function aesDecrypt(encryptedHex, key, iv) {
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(true);
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/* ── 重新計算 TradeSha 比對 ──────────────────── */
function verifyTradeSha(tradeInfo, receivedSha, key, iv) {
  const raw = `HashKey=${key}&${tradeInfo}&HashIV=${iv}`;
  const computed = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
  return computed === String(receivedSha || '').toUpperCase();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  try {
    const HASH_KEY = process.env.NEWEBPAY_HASH_KEY;
    const HASH_IV  = process.env.NEWEBPAY_HASH_IV;

    const { Status, MerchantID, TradeInfo, TradeSha, Version } = req.body || {};

    console.log('[NewebPay Notify] Received:', JSON.stringify({
      Status, MerchantID, Version, hasTradeInfo: !!TradeInfo,
    }));

    if (!TradeInfo || !TradeSha) {
      console.error('[NewebPay Notify] Missing TradeInfo / TradeSha');
      return res.status(400).send('Missing fields');
    }

    // 1. 驗證簽名
    if (!verifyTradeSha(TradeInfo, TradeSha, HASH_KEY, HASH_IV)) {
      console.error('[NewebPay Notify] TradeSha verification FAILED');
      return res.status(400).send('TradeSha Error');
    }

    // 2. 解密 TradeInfo
    const decryptedJson = aesDecrypt(TradeInfo, HASH_KEY, HASH_IV);
    let payload;
    try {
      payload = JSON.parse(decryptedJson);
    } catch (e) {
      console.error('[NewebPay Notify] TradeInfo JSON parse error:', e.message, decryptedJson);
      return res.status(400).send('Invalid TradeInfo');
    }

    const result = payload.Result || {};
    const isPaid = String(payload.Status) === 'SUCCESS' && String(result.RespondCode || '00') === '00';

    console.log('[NewebPay Notify] Decoded:', {
      payloadStatus:   payload.Status,
      respondCode:     result.RespondCode,
      merchantOrderNo: result.MerchantOrderNo,
      tradeNo:         result.TradeNo,
      paymentType:     result.PaymentType,
      amt:             result.Amt,
      payTime:         result.PayTime,
      isPaid,
    });

    // 3. 更新 Supabase 訂單狀態
    //    TODO: 拿到 orders schema 後啟用 (參考 ECPay 版本的 supabase update block)
    /*
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    if (isPaid) {
      await supabase.from('orders').update({
        payment_status:    'paid',
        newebpay_trade_no: result.TradeNo,
        payment_type:      result.PaymentType,
        payment_date:      result.PayTime,
        updated_at:        new Date().toISOString(),
      }).eq('order_no', result.MerchantOrderNo);
    } else {
      await supabase.from('orders').update({
        payment_status: 'failed',
        payment_error:  payload.Message || result.RespondCode,
        updated_at:     new Date().toISOString(),
      }).eq('order_no', result.MerchantOrderNo);
    }
    */

    // 4. 藍新規格: 200 OK 即視為成功接收 (不像綠界要回 "1|OK")
    return res.status(200).send('OK');

  } catch (err) {
    console.error('[NewebPay Notify] Error:', err);
    // 不丟 500,避免藍新不斷重試 (但 log 留住)
    return res.status(200).send('OK');
  }
}
