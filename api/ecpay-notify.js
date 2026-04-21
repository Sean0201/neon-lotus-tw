/**
 * /api/ecpay-notify.js — Vercel Serverless Function (Node.js)
 * 接收綠界 Server-to-Server 付款結果通知 (ReturnURL)
 *
 * 綠界會 POST 付款結果到此 endpoint，包含:
 *   MerchantID, MerchantTradeNo, RtnCode, RtnMsg, TradeNo,
 *   TradeAmt, PaymentDate, PaymentType, CheckMacValue, etc.
 *
 * 必須回傳 "1|OK" 表示成功接收，否則綠界會重試
 */

import crypto from 'crypto';

export const config = { runtime: 'nodejs20.x', maxDuration: 30 };

/* ── 驗證 CheckMacValue ─────────────────────────────── */
function verifyCheckMacValue(params, hashKey, hashIV) {
  const receivedMac = params.CheckMacValue;
  if (!receivedMac) return false;

  // 移除 CheckMacValue 後重新計算
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

    console.log('[ECPay Notify] Received:', JSON.stringify(params));

    // 1. 驗證簽名
    if (!verifyCheckMacValue(params, HASH_KEY, HASH_IV)) {
      console.error('[ECPay Notify] CheckMacValue verification FAILED');
      return res.status(400).send('CheckMacValue Error');
    }

    // 2. 取得關鍵資訊
    const {
      MerchantTradeNo,  // 你的訂單編號
      TradeNo,          // 綠界交易編號
      RtnCode,          // 回傳代碼 (1 = 付款成功)
      RtnMsg,           // 回傳訊息
      TradeAmt,         // 交易金額
      PaymentDate,      // 付款時間
      PaymentType,      // 付款方式 (Credit_CreditCard, ATM_TAISHIN, etc.)
      SimulatePaid,     // 是否為模擬付款 (測試環境用)
    } = params;

    const isPaid = String(RtnCode) === '1';

    console.log(`[ECPay Notify] Order: ${MerchantTradeNo}, Paid: ${isPaid}, Amount: ${TradeAmt}`);

    // 3. 更新 Supabase 訂單狀態
    //    TODO: 拿到正式 Supabase credentials 後啟用
    /*
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY  // 使用 service key，非 anon key
    );

    if (isPaid) {
      const { error } = await supabase
        .from('orders')
        .update({
          payment_status: 'paid',
          ecpay_trade_no: TradeNo,
          payment_type: PaymentType,
          payment_date: PaymentDate,
          updated_at: new Date().toISOString(),
        })
        .eq('order_no', MerchantTradeNo);

      if (error) {
        console.error('[ECPay Notify] Supabase update error:', error);
      }
    } else {
      await supabase
        .from('orders')
        .update({
          payment_status: 'failed',
          payment_error: RtnMsg,
          updated_at: new Date().toISOString(),
        })
        .eq('order_no', MerchantTradeNo);
    }
    */

    // 4. 回傳 "1|OK" — 綠界要求的成功回應格式
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send('1|OK');

  } catch (err) {
    console.error('[ECPay Notify] Error:', err);
    // 即使出錯也要盡量回 1|OK，避免綠界不斷重試
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send('1|OK');
  }
}
