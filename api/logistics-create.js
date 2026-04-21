/**
 * /api/logistics-create.js — Vercel Serverless Function (Node.js)
 * 建立綠界物流訂單 (超商取貨 C2C / 宅配)
 *
 * POST body: {
 *   orderId,
 *   senderName, senderPhone, senderAddress, senderZipCode,
 *   receiverName, receiverPhone, receiverAddress,
 *   receiverCellPhone,          // 收件人手機 (超商取貨必填)
 *   logisticsType,              // 'CVS' (超商) | 'HOME' (宅配)
 *   logisticsSubType,           // C2C: 'UNIMARTC2C' | 'FAMIC2C' | 'HILIFEC2C' | 'OKMARTC2C'
 *                               // HOME: 'TCAT' | 'POST'
 *   cvsStoreId,                 // 超商門市代號 (超商取貨才需要)
 *   items,                      // [{ name, quantity }]
 *   totalAmount,
 *   isCollection,               // 'Y' = 貨到付款, 'N' = 已線上付款
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

export const config = { runtime: 'nodejs', maxDuration: 30 };

/* ── 清理交易編號 (綠界只接受英數字, 最多 20 碼) ──────── */
function sanitizeTradeNo(raw) {
  return raw.replace(/[^A-Za-z0-9]/g, '').substring(0, 20);
}

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

  // .NET-style URL encode → lowercase
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

/* ── C2C SubType 對照 ────────────────────────────── */
const VALID_CVS_SUBTYPES = ['UNIMARTC2C', 'FAMIC2C', 'HILIFEC2C', 'OKMARTC2C'];
const VALID_HOME_SUBTYPES = ['TCAT', 'POST'];

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
      senderAddress,
      senderZipCode,
      receiverName,
      receiverPhone,
      receiverCellPhone,
      receiverAddress,
      logisticsType,        // 'CVS' | 'HOME'
      logisticsSubType,     // 'UNIMARTC2C' | 'FAMIC2C' | 'HILIFEC2C' | 'OKMARTC2C' | 'TCAT' | 'POST'
      cvsStoreId,
      items,
      totalAmount,
      isCollection = 'N',   // 'Y' = 貨到付款, 'N' = 已線上付款
    } = req.body;

    const MERCHANT_ID = process.env.ECPAY_LOGISTICS_MERCHANT_ID || process.env.ECPAY_MERCHANT_ID;
    const HASH_KEY    = process.env.ECPAY_LOGISTICS_HASH_KEY    || process.env.ECPAY_HASH_KEY;
    const HASH_IV     = process.env.ECPAY_LOGISTICS_HASH_IV     || process.env.ECPAY_HASH_IV;
    const API_URL     = process.env.ECPAY_LOGISTICS_API_URL;
    const SITE_URL    = process.env.SITE_URL || 'https://neon-lotus-tw.vercel.app';

    if (!MERCHANT_ID || !HASH_KEY || !HASH_IV || !API_URL) {
      return res.status(500).json({ error: 'ECPay logistics credentials not configured' });
    }

    /* ── 驗證 ── */
    if (!orderId || !receiverName || !logisticsType || !logisticsSubType) {
      return res.status(400).json({ error: '缺少必要欄位: orderId, receiverName, logisticsType, logisticsSubType' });
    }

    if (logisticsType === 'CVS' && !VALID_CVS_SUBTYPES.includes(logisticsSubType)) {
      return res.status(400).json({ error: `不支援的超商類型: ${logisticsSubType}` });
    }
    if (logisticsType === 'HOME' && !VALID_HOME_SUBTYPES.includes(logisticsSubType)) {
      return res.status(400).json({ error: `不支援的宅配類型: ${logisticsSubType}` });
    }

    const tradeNo = sanitizeTradeNo(orderId);

    const goodsName = (items || [])
      .map(i => `${i.name} x${i.quantity}`)
      .join('#')
      .substring(0, 50) || 'Neon Lotus';

    /* ── 共用參數 ── */
    const params = {
      MerchantID:        MERCHANT_ID,
      MerchantTradeNo:   tradeNo,
      MerchantTradeDate: formatDate(new Date()),
      LogisticsType:     logisticsType === 'CVS' ? 'CVS' : 'Home',
      LogisticsSubType:  logisticsSubType,
      GoodsName:         goodsName,
      GoodsAmount:       String(Math.round(totalAmount)),
      SenderName:        senderName || 'Neon Lotus',
      SenderPhone:       senderPhone || '0912345678',
      ReceiverName:      receiverName,
      ReceiverPhone:     receiverPhone || '',
      ReceiverCellPhone: receiverCellPhone || receiverPhone || '',
      ServerReplyURL:    `${SITE_URL}/api/logistics-notify`,
      IsCollection:      isCollection === 'Y' ? 'Y' : 'N',
    };

    /* ── 超商取貨特有參數 (C2C) ── */
    if (logisticsType === 'CVS') {
      params.ReceiverStoreID = cvsStoreId || '';
      // C2C 超商取貨: 收件人手機必填
      if (!params.ReceiverCellPhone) {
        return res.status(400).json({ error: '超商取貨需要收件人手機號碼' });
      }
      // 超商取貨限 5 公斤以下
    }

    /* ── 宅配特有參數 ── */
    if (logisticsType === 'HOME') {
      params.SenderZipCode   = senderZipCode || '106';    // 預設台北大安區
      params.SenderAddress   = senderAddress || '台北市大安區';
      params.ReceiverAddress = receiverAddress || '';
      params.Temperature     = '0001';  // 常溫
      params.Distance        = '00';    // 同縣市
      params.Specification   = '0001';  // 60cm

      if (!receiverAddress) {
        return res.status(400).json({ error: '宅配到府需要收件地址' });
      }
    }

    /* ── 簽名 ── */
    params.CheckMacValue = generateCheckMacValue(params, HASH_KEY, HASH_IV);

    console.log('[Logistics Create] Params:', JSON.stringify(params));

    /* ── 呼叫綠界物流 API ── */
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

    // 綠界物流回傳格式: 1|OK 或 ErrorCode|ErrorMessage 或 key=value&...
    let result = {};
    if (resultText.includes('=')) {
      resultText.split('&').forEach(pair => {
        const idx = pair.indexOf('=');
        if (idx > -1) {
          const k = decodeURIComponent(pair.substring(0, idx));
          const v = decodeURIComponent(pair.substring(idx + 1));
          result[k] = v;
        }
      });
    } else {
      // 簡單格式: "1|OK" 或 error
      const parts = resultText.split('|');
      result.RtnCode = parts[0];
      result.RtnMsg = parts[1] || resultText;
    }

    const success = result.RtnCode === '1' || result.RtnCode === '300';

    return res.status(200).json({
      success,
      message: result.RtnMsg || '',
      allPayLogisticsID: result.AllPayLogisticsID || '',
      tradeNo,
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
