/**
 * /api/logistics-create.js — Vercel Serverless Function (Node.js)
 * 建立綠界物流訂單 (超商取貨 / 宅配)
 *
 * POST body: {
 *   orderId, senderName, senderPhone,
 *   receiverName, receiverPhone, receiverAddress,
 *   logisticsType,   // 'CVS' (超商) | 'HOME' (宅配)
 *   logisticsSubType, // 'FAMI' | 'UNIMART' | 'HILIFE' | 'TCAT' | 'POST'
 *   cvsStoreId,      // 超商門市代號 (超商取貨才需要)
 *   cvsStoreName,    // 超商門市名稱
 *   items,           // [{ name, quantity }]
 *   totalAmount,
 * }
 *
 * 環境變數:
 *   ECPAY_LOGISTICS_MERCHANT_ID  (物流可能使用不同的特約商店)
 *   ECPAY_LOGISTICS_HASH_KEY
 *   ECPAY_LOGISTICS_HASH_IV
 *   ECPAY_LOGISTICS_API_URL — 測試: https://logistics-stage.ecpay.com.tw/Express/Create
 *                              正式: https://logistics.ecpay.com.tw/Express/Create
 *   SITE_URL
 */

import crypto from 'crypto';

export const config = { runtime: 'nodejs20.x', maxDuration: 30 };

/* ── 綠界物流 CheckMacValue (MD5) ────────────────── */
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

  // 物流用 MD5 (非 SHA256)
  return crypto.createHash('md5').update(raw).digest('hex').toUpperCase();
}

/* ── Main Handler ───────────────────────────────────── */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      orderId,
      senderName,
      senderPhone,
      receiverName,
      receiverPhone,
      receiverAddress,
      logisticsType,     // 'CVS' | 'HOME'
      logisticsSubType,  // 'FAMI' | 'UNIMART' | 'HILIFE' | 'TCAT' | 'POST'
      cvsStoreId,
      cvsStoreName,
      items,
      totalAmount,
    } = req.body;

    const MERCHANT_ID = process.env.ECPAY_LOGISTICS_MERCHANT_ID || process.env.ECPAY_MERCHANT_ID;
    const HASH_KEY    = process.env.ECPAY_LOGISTICS_HASH_KEY    || process.env.ECPAY_HASH_KEY;
    const HASH_IV     = process.env.ECPAY_LOGISTICS_HASH_IV     || process.env.ECPAY_HASH_IV;
    const API_URL     = process.env.ECPAY_LOGISTICS_API_URL;
    const SITE_URL    = process.env.SITE_URL || 'https://neon-lotus-tw.vercel.app';

    if (!MERCHANT_ID || !HASH_KEY || !HASH_IV) {
      return res.status(500).json({ error: 'ECPay logistics credentials not configured' });
    }

    const goodsName = items
      .map(i => `${i.name} x${i.quantity}`)
      .join('#')
      .substring(0, 50);

    // 共用參數
    const params = {
      MerchantID:       MERCHANT_ID,
      MerchantTradeNo:  orderId,
      MerchantTradeDate: formatDate(new Date()),
      LogisticsType:    logisticsType === 'CVS' ? 'CVS' : 'HOME',
      LogisticsSubType: logisticsSubType,
      GoodsName:        goodsName,
      GoodsAmount:      String(Math.round(totalAmount)),
      SenderName:       senderName || 'Neon Lotus',
      SenderPhone:      senderPhone || '',
      ReceiverName:     receiverName,
      ReceiverPhone:    receiverPhone,
      ServerReplyURL:   `${SITE_URL}/api/logistics-notify`,
      IsCollection:     'N',  // 是否代收貨款 (N=否，金流已走綠界)
    };

    // 超商取貨特有參數
    if (logisticsType === 'CVS') {
      params.ReceiverStoreID = cvsStoreId || '';
      // 超商取貨限 2cm 以內、5公斤以下
    }

    // 宅配特有參數
    if (logisticsType === 'HOME') {
      params.SenderZipCode   = '';  // 可填寫寄件人郵遞區號
      params.SenderAddress   = '';  // 可填寫寄件人地址
      params.ReceiverZipCode = '';  // 可從地址解析
      params.ReceiverAddress = receiverAddress || '';
      params.Temperature     = '0001';  // 常溫
      params.Distance        = '00';    // 同縣市
      params.Specification   = '0001';  // 60cm
    }

    // 簽名
    params.CheckMacValue = generateCheckMacValue(params, HASH_KEY, HASH_IV);

    // 呼叫綠界物流 API
    const formBody = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody,
    });

    const resultText = await response.text();
    console.log('[Logistics Create] Response:', resultText);

    // 綠界物流回傳格式: key1=value1&key2=value2
    const result = {};
    resultText.split('&').forEach(pair => {
      const [k, v] = pair.split('=');
      if (k) result[decodeURIComponent(k)] = decodeURIComponent(v || '');
    });

    const success = result.RtnCode === '1' || result.RtnCode === '300';

    return res.status(200).json({
      success,
      message: result.RtnMsg || '',
      allPayLogisticsID: result.AllPayLogisticsID || '',
      result,
    });

  } catch (err) {
    console.error('[Logistics Create] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}/${m}/${d} ${h}:${min}:${s}`;
}
