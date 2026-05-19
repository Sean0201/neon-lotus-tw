/**
 * /api/newebpay-create.js — Vercel Serverless Function (Node.js)
 * 建立藍新金流 (NewebPay) 訂單,回傳 HTML 表單讓前端自動 POST 至藍新
 *
 * POST body: {
 *   items: [{ name, quantity, price, shipping_method? }],
 *   totalAmount,   // 前端宣告的應付總額 (折後 + 運費)
 *   shippingFee,
 *   discount,      // 前端宣告的折扣 (僅供日誌比對)
 *   memberId?,     // Phase 2.2: 若會員下單,server 重新撈會員資料算折扣
 *   tierKey?,      // Phase 2.2: 客戶端聲明的等級,僅供 audit log
 *   useCredit?,    // Phase 2.2: 是否使用註冊禮金 (預設 true)
 *   buyerName, buyerEmail, buyerPhone,
 *   orderId?
 * }
 *
 * Phase 2.2 折扣驗證:
 *   - 後端用 lib/discount.js (computeCart) 重新計算,以「server 自行從 DB 撈的會員資料」
 *     為單一信任來源 — 客戶端聲明的 tierKey 只是 hint。
 *   - 容忍 ±NT$5 rounding 誤差。
 *
 * 環境變數 (Vercel Dashboard → Settings → Environment Variables):
 *   NEWEBPAY_MERCHANT_ID — 商店代碼 (e.g. MS159001264)
 *   NEWEBPAY_HASH_KEY    — 32 字元
 *   NEWEBPAY_HASH_IV     — 16 字元
 *   NEWEBPAY_API_URL     — 測試: https://ccore.newebpay.com/MPG/mpg_gateway
 *                          正式: https://core.newebpay.com/MPG/mpg_gateway
 *   SITE_URL             — e.g. https://neon-lotus-tw.vercel.app
 *   SUPABASE_URL (或 NEXT_PUBLIC_SUPABASE_URL)        — for member lookup
 *   SUPABASE_SERVICE_KEY (或 SUPABASE_SERVICE_ROLE_KEY) — service role
 *   NEWEBPAY_PAYMENT_METHODS — 開放付款方式 (逗號分隔)
 */

import crypto from 'crypto';
import D from './lib/discount.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

/* ── Supabase service-role client (lazily import to keep cold start fast) ──
 * 同時支援兩種 env var 命名 (新 Vercel 上常見的 NEXT_PUBLIC_/_ROLE_ 跟舊版簡名)
 */
function getSupabaseEnv() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { url, key };
}
async function getSupabaseAdmin() {
  const { url, key } = getSupabaseEnv();
  if (!url || !key) {
    console.warn('[newebpay-create] Supabase env vars missing (need SUPABASE_URL+SERVICE_KEY or NEXT_PUBLIC_SUPABASE_URL+SUPABASE_SERVICE_ROLE_KEY)');
    return null;
  }
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * 後端重新計算訂單金額。
 *   - 從 DB 撈會員資料 (tier / founding_credit_balance / birthday / birthday_used_year)
 *   - 用 lib/discount.computeCart 算最終金額
 *   - 加上運費 = expectedTotal
 *
 * @returns {Promise<{
 *   rawSubtotal, discountedSubtotal, expectedDiscount, expectedTotal, shippingFee,
 *   member, result
 * }>}
 */
async function recalculateOrder(items, shippingFee, memberId, useCredit) {
  // 1. 從 DB 撈最新會員資料 (server 為信任來源)
  let member = null;
  if (memberId) {
    try {
      const supabase = await getSupabaseAdmin();
      if (supabase) {
        const { data, error } = await supabase
          .from('members')
          .select('id, tier, accumulated_spend, founding_credit_balance, birthday, birthday_used_year, purchase_count')
          .eq('id', memberId)
          .maybeSingle();
        if (!error && data) member = data;
      }
    } catch (err) {
      console.warn('[newebpay-create] member lookup failed:', err && err.message ? err.message : err);
    }
  }

  // 2. 確保 config 是從 site_config 載入的最新版 (best-effort,失敗 fallback 預設)
  try {
    const supabase = await getSupabaseAdmin();
    if (supabase) await D.loadConfig(supabase);
  } catch (err) {
    // 預設值 ok
  }

  // 3. 折扣計算
  const engineItems = items.map((it) => ({
    unit_price:      Number(it.price) || 0,
    quantity:        Number(it.quantity) || 0,
    shipping_method: it.shipping_method === 'carryback' ? 'carryback' : 'shipping',
  }));
  const result = D.computeCart({
    items: engineItems,
    member,
    useCredit: useCredit !== false,
  });

  const fee = Number(shippingFee) || 0;
  return {
    rawSubtotal:        result.raw_subtotal,
    discountedSubtotal: result.final_subtotal,
    expectedDiscount:   result.total_savings,
    expectedTotal:      result.final_subtotal + fee,
    shippingFee:        fee,
    member,
    result,
  };
}

/* ── AES-256-CBC 加密 (藍新規格) ──────────────────── */
function aesEncrypt(plainText, key, iv) {
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(true);
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
}

/* ── 計算 TradeSha (SHA256 大寫) ─────────────────── */
function generateTradeSha(tradeInfo, key, iv) {
  const raw = `HashKey=${key}&${tradeInfo}&HashIV=${iv}`;
  return crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
}

/* ── 把參數物件轉成 query string (TradeInfo 用) ──── */
function buildQueryString(params) {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/* ── 產生唯一交易編號 (藍新限制 1-20 碼,英數+_) ──── */
function generateOrderNo() {
  const now = new Date();
  const ts = now.getFullYear().toString()
    + String(now.getMonth() + 1).padStart(2, '0')
    + String(now.getDate()).padStart(2, '0')
    + String(now.getHours()).padStart(2, '0')
    + String(now.getMinutes()).padStart(2, '0')
    + String(now.getSeconds()).padStart(2, '0');
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `NL${ts}${rand}`; // NL + 14 + 4 = 20 chars
}

function sanitizeOrderNo(raw) {
  return raw.replace(/[^A-Za-z0-9_]/g, '').substring(0, 20);
}

/* ── HTML escape ──────────────────────────────────── */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Main Handler ───────────────────────────────── */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      items,        // [{ name, quantity, price, shipping_method? }]
      totalAmount,  // 整數 (TWD) — 前端宣告之應付總額
      shippingFee,  // 整數 (TWD) — 域內運費
      discount,     // 整數 (TWD) — 前端宣告的折扣 (僅供 audit)
      memberId,     // Phase 2.2 — server 用此撈會員等級 / 折抵金 / 生日
      tierKey,      // Phase 2.2 — 前端聲明的等級 (僅 audit log)
      useCredit,    // Phase 2.2 — 是否使用註冊禮金 (預設 true)
      buyerName,
      buyerEmail,
      buyerPhone,
      orderId,
    } = req.body;

    const MERCHANT_ID = process.env.NEWEBPAY_MERCHANT_ID;
    const HASH_KEY    = process.env.NEWEBPAY_HASH_KEY;
    const HASH_IV     = process.env.NEWEBPAY_HASH_IV;
    const API_URL     = process.env.NEWEBPAY_API_URL
                        || 'https://ccore.newebpay.com/MPG/mpg_gateway';  // 預設測試
    const SITE_URL    = process.env.SITE_URL || 'https://neon-lotus-tw.vercel.app';

    // 付款方式 (依商店實際開通狀態,以 env var 控制 sandbox 與 production 不同清單)
    // 範例: CREDIT,APPLEPAY,VACC,WEBATM,CVS
    const PAYMENT_METHODS = (process.env.NEWEBPAY_PAYMENT_METHODS || 'CREDIT,VACC')
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);

    if (!MERCHANT_ID || !HASH_KEY || !HASH_IV) {
      return res.status(500).json({ error: 'NewebPay credentials not configured' });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items required' });
    }
    if (!totalAmount || totalAmount <= 0) {
      return res.status(400).json({ error: 'totalAmount must be positive' });
    }

    /* ── Phase 2.2 — Server-side 折扣重新驗證 ────────────────
       * server 從 DB 撈最新會員資料 (信任來源),用同一 computeCart
       * 重新算金額。容忍 ±5 元 rounding 誤差。
       *
       * 為什麼以 server 撈的會員為準?
       *   - 防止前端被竄改後送錯 tier / founding_credit_balance / birthday_used_year
       *   - 累積消費 / 等級會由 newebpay-notify 在「付款成功」後才升等,
       *     create 階段該以「下單前的等級」為準
       */
    const recalc = await recalculateOrder(items, shippingFee, memberId, useCredit);
    const declaredTotal = Math.round(Number(totalAmount));
    const expectedTotal = Math.round(recalc.expectedTotal);
    const totalDiff = Math.abs(declaredTotal - expectedTotal);
    const TOLERANCE = 5; // NT$5 rounding 容忍
    if (totalDiff > TOLERANCE) {
      console.warn('[NewebPay create] totalAmount mismatch', {
        declared: declaredTotal,
        expected: expectedTotal,
        diff: totalDiff,
        memberId,
        clientTierKey: tierKey,
        serverTierKey: recalc.result.tier_key,
        clientDiscount: discount,
        serverDiscount: recalc.expectedDiscount,
        result: recalc.result,
        items,
      });
      return res.status(400).json({
        error: '訂單金額計算不一致,請重新整理購物車再試',
        debug: { declared: declaredTotal, expected: expectedTotal },
      });
    }

    // Audit: 客戶端聲明的 tier 跟 server 算的不一樣 (可能是會員剛升等 cache 沒同步)
    if (tierKey && recalc.member && tierKey !== recalc.result.tier_key) {
      console.warn('[NewebPay create] tierKey hint mismatch', {
        memberId,
        client_says: tierKey,
        server_says: recalc.result.tier_key,
      });
    }

    // Server-recalculated total is the source of truth (use it for Amt)
    const finalAmt = expectedTotal;

    // 訂單號
    const merchantOrderNo = sanitizeOrderNo(orderId || generateOrderNo());

    // 商品描述 (藍新限制 50 字)
    const itemDesc = items
      .map(i => `${i.name} x${i.quantity}`)
      .join(', ')
      .substring(0, 50);

    // ── TradeInfo 內容 (URL-encoded query string) ──
    const tradeInfoObj = {
      MerchantID:      MERCHANT_ID,
      RespondType:     'JSON',
      TimeStamp:       String(Math.floor(Date.now() / 1000)),
      Version:         '2.0',
      MerchantOrderNo: merchantOrderNo,
      Amt:             finalAmt,
      ItemDesc:        itemDesc,
      ReturnURL:       `${SITE_URL}/api/newebpay-return`,    // 前台導回 (有 TradeInfo,可判定成敗)
      NotifyURL:       `${SITE_URL}/api/newebpay-notify`,    // 後台通知 (server-to-server)
      /* ClientBackURL — 客戶點「返回商店」按鈕後的目的地。
         藍新只是純 GET 跳轉,不會帶 TradeInfo,所以我們無法在此判斷成敗。
         導向「付款處理中」頁面 + 帶訂單編號,讓客戶看到自己的訂單編號,
         並請他們勿重複付款 (NotifyURL 才是真正的成敗來源)。 */
      ClientBackURL:   `${SITE_URL}/?order=${encodeURIComponent(merchantOrderNo)}&status=processing#order-processing`,
      Email:           buyerEmail || '',
      LoginType:       0,                                      // 不需登入藍新會員
    };

    // ── 動態加入開放的付款方式 (來自 NEWEBPAY_PAYMENT_METHODS env var) ──
    PAYMENT_METHODS.forEach(method => {
      tradeInfoObj[method] = 1;
    });

    const tradeInfoQuery = buildQueryString(tradeInfoObj);

    // ── AES + SHA 加密 ──
    const tradeInfo = aesEncrypt(tradeInfoQuery, HASH_KEY, HASH_IV);
    const tradeSha  = generateTradeSha(tradeInfo, HASH_KEY, HASH_IV);

    // ── 送至藍新的最終參數 ──
    const params = {
      MerchantID: MERCHANT_ID,
      TradeInfo:  tradeInfo,
      TradeSha:   tradeSha,
      Version:    '2.0',
    };

    // ── 自動提交的 HTML 表單 ──
    const formInputs = Object.entries(params)
      .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}" />`)
      .join('\n');

    const html = `
      <html>
      <body>
        <form id="newebpay-form" method="POST" action="${API_URL}">
          ${formInputs}
        </form>
        <script>document.getElementById('newebpay-form').submit();</script>
      </body>
      </html>`;

    const accept = req.headers['accept'] || '';
    if (accept.includes('text/html')) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send(html);
    }

    return res.status(200).json({
      success: true,
      orderNo: merchantOrderNo,
      formHtml: html,
      // 以下僅 debug 用,正式環境可移除
      debug: {
        apiUrl: API_URL,
        params,
      },
    });

  } catch (err) {
    console.error('[NewebPay create] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
