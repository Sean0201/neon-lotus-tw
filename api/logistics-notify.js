/**
 * /api/logistics-notify.js — Vercel Serverless Function (Node.js)
 * 接收綠界物流狀態變更通知 (ServerReplyURL)
 *
 * 綠界會在物流狀態變更時 POST 到此 endpoint
 * 例如：已取件、配送中、已到店、已取貨、退貨等
 *
 * 綠界回傳欄位:
 *   MerchantID, MerchantTradeNo, AllPayLogisticsID,
 *   LogisticsType, LogisticsSubType, GoodsAmount,
 *   UpdateStatusDate, RtnCode, RtnMsg, CheckMacValue
 *
 * 常見 RtnCode (超商取貨):
 *   2067 = 出貨   300 = 訂單建立成功
 *   2030 = 門市已收到  2063 = 已取貨
 *   2074 = 退貨    2066 = 拒收
 *
 * 必須回傳 "1|OK"
 */

import crypto from 'crypto';

export const config = { runtime: 'nodejs', maxDuration: 30 };

/* ── 驗證 CheckMacValue (物流用 MD5) ────────────── */
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

  const computed = crypto.createHash('md5').update(raw).digest('hex').toUpperCase();
  return computed === receivedMac;
}

/* ── 物流狀態對照表 ─────────────────────────────── */
const STATUS_MAP = {
  '300':  'created',      // 訂單建立成功
  '2030': 'at_store',     // 門市已收到包裹
  '2063': 'picked_up',    // 取件人已取貨
  '2067': 'shipped',      // 已出貨
  '2068': 'arrived',      // 已到達門市
  '2074': 'returned',     // 退貨
  '2066': 'rejected',     // 拒收
  '3024': 'expired',      // 包裹逾期未取
};

/* ── Main Handler ───────────────────────────────────── */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  try {
    const params = req.body;
    const HASH_KEY = process.env.ECPAY_LOGISTICS_HASH_KEY || process.env.ECPAY_HASH_KEY;
    const HASH_IV  = process.env.ECPAY_LOGISTICS_HASH_IV  || process.env.ECPAY_HASH_IV;

    console.log('[Logistics Notify] Received:', JSON.stringify(params));

    // 1. 驗證簽名
    if (!verifyCheckMacValue(params, HASH_KEY, HASH_IV)) {
      console.error('[Logistics Notify] CheckMacValue verification FAILED');
      return res.status(400).send('CheckMacValue Error');
    }

    // 2. 取得關鍵資訊
    const {
      MerchantTradeNo,
      AllPayLogisticsID,
      RtnCode,
      RtnMsg,
      UpdateStatusDate,
      LogisticsType,
      LogisticsSubType,
    } = params;

    const statusKey = STATUS_MAP[RtnCode] || 'unknown';

    console.log(`[Logistics Notify] Order: ${MerchantTradeNo}, Status: ${statusKey} (${RtnCode}: ${RtnMsg})`);

    // 3. 更新 Supabase 物流狀態
    //    TODO: 拿到正式 Supabase credentials 後啟用
    /*
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // 更新 shipments 表
    const { error } = await supabase
      .from('shipments')
      .upsert({
        order_no: MerchantTradeNo,
        logistics_id: AllPayLogisticsID,
        logistics_type: LogisticsType,
        logistics_sub_type: LogisticsSubType,
        status: statusKey,
        status_code: RtnCode,
        status_message: RtnMsg,
        status_date: UpdateStatusDate,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'order_no' });

    if (error) {
      console.error('[Logistics Notify] Supabase update error:', error);
    }

    // 同時更新 orders 表的 shipping_status
    await supabase
      .from('orders')
      .update({
        shipping_status: statusKey,
        updated_at: new Date().toISOString(),
      })
      .eq('order_no', MerchantTradeNo);
    */

    // 4. 回傳成功
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send('1|OK');

  } catch (err) {
    console.error('[Logistics Notify] Error:', err);
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send('1|OK');
  }
}
