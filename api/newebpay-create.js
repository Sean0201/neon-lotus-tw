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
  const supabase = await getSupabaseAdmin();

  // 1. 從 DB 撈最新會員資料 (server 為信任來源)
  let member = null;
  if (memberId && supabase) {
    try {
      const { data, error } = await supabase
        .from('members')
        .select('id, tier, accumulated_spend, founding_credit_balance, birthday, birthday_used_year, purchase_count')
        .eq('id', memberId)
        .maybeSingle();
      if (!error && data) member = data;
    } catch (err) {
      console.warn('[newebpay-create] member lookup failed:', err && err.message ? err.message : err);
    }
  }

  // 2. 確保 config 是從 site_config 載入的最新版 (best-effort,失敗 fallback 預設)
  if (supabase) {
    try { await D.loadConfig(supabase); } catch (err) { /* 預設值 ok */ }
  }

  /* 3. Phase 2.2 migration 014 — 後端用 product_id 重撈 is_promo
     - 客戶端送來的 is_promo 不可信 (可能被竄改成 false 來吃折扣)
     - server 從 DB 撈 products.is_promo 為唯一信任來源
     - 若 product_id 缺失/查無,fallback is_promo = false (寬鬆,但會記 log)

     Migration 015 — 新增 brand_id 一併撈,配合下面 brand_promos 判斷,
     讓「品牌週」商品能被 server 認可為 is_promo=true (skip tier/bulk/等) */
  const productIds = items.map(it => it.product_id).filter(Boolean);
  const promoMap = new Map();  // product_id (string) -> is_promo (boolean, product-level)
  const brandMap = new Map();  // product_id (string) -> brand_id (string|null)
  const priceMap = new Map();  // Migration 016 audit — product_id (string) -> base list price
  if (productIds.length && supabase) {
    try {
      const { data: prodRows, error: prodErr } = await supabase
        .from('products')
        .select('id, is_promo, brand_id, price_thb_shipping, price_thb_carryback')
        .in('id', productIds);
      if (!prodErr && Array.isArray(prodRows)) {
        prodRows.forEach(row => {
          promoMap.set(String(row.id), !!row.is_promo);
          brandMap.set(String(row.id), row.brand_id || null);
          priceMap.set(String(row.id), {
            shipping:  Number(row.price_thb_shipping)  || 0,
            carryback: Number(row.price_thb_carryback) || 0,
          });
        });
      } else if (prodErr) {
        console.warn('[newebpay-create] products lookup failed:', prodErr.message);
      }
    } catch (err) {
      console.warn('[newebpay-create] products lookup threw:', err && err.message ? err.message : err);
    }
  }

  /* 3b. Migration 015 — 撈目前正在跑的品牌週活動
     - 只信 server 判斷:brand_promos.is_active = true
     - 這些品牌旗下的商品,client 送 is_promo=true 就會被接受 (skip tier/bulk/etc,
       跟前端 BrandPromoEngine 的 skip 語意一致 → server 算出來的 final_subtotal
       就會跟 client 的 discountResult.final_subtotal 一致)
     - 不在活動內的品牌 / 沒設定的品牌 → 一律以 products.is_promo 為準 (舊行為)
     - client 的 unit_price 已是折後價 (BrandPromoEngine 已改寫),server 沿用;
       整車 ±NT$5 tolerance 仍在,保護價格竄改 */
  const activeBrandIds = new Set();
  const brandPromoRules = new Map();  // Migration 016 audit — brand_id -> { label, tier_rules }
  if (supabase) {
    try {
      const nowIso = new Date().toISOString();
      const { data: bpRows, error: bpErr } = await supabase
        .from('brand_promos')
        .select('brand_id, label, tier_rules, starts_at, ends_at, is_active')
        .eq('is_active', true);
      if (!bpErr && Array.isArray(bpRows)) {
        bpRows.forEach(bp => {
          const started = !bp.starts_at || bp.starts_at <= nowIso;
          const notEnded = !bp.ends_at   || bp.ends_at   >  nowIso;
          if (started && notEnded && bp.brand_id) {
            activeBrandIds.add(String(bp.brand_id));
            brandPromoRules.set(String(bp.brand_id), {
              label: bp.label || null,
              tier_rules: Array.isArray(bp.tier_rules) ? bp.tier_rules : [],
            });
          }
        });
      } else if (bpErr) {
        console.warn('[newebpay-create] brand_promos lookup failed:', bpErr.message);
      }
    } catch (err) {
      console.warn('[newebpay-create] brand_promos lookup threw:', err && err.message ? err.message : err);
    }
  }

  // 4. 折扣計算 — 把 server 撈到的 is_promo 注入到 engine items
  const engineItems = items.map((it) => {
    const pid = it.product_id != null ? String(it.product_id) : null;
    const productPromo = pid && promoMap.has(pid) ? promoMap.get(pid) : false;
    const brandId      = pid && brandMap.has(pid) ? brandMap.get(pid) : null;
    const brandPromoActive = !!(brandId && activeBrandIds.has(String(brandId)));

    // serverIsPromo = product 本身是特價 || (該品牌正在跑週活動 && client 聲明是 is_promo)
    // 品牌週的路徑仍要求 client 主動聲明 is_promo=true (由 BrandPromoEngine 標記),
    // 這樣同一品牌內若有非活動商品也不會被誤傷。
    let serverIsPromo = productPromo;
    if (!serverIsPromo && brandPromoActive && it.is_promo === true) {
      serverIsPromo = true;
    }

    if (pid && !promoMap.has(pid)) {
      console.warn('[newebpay-create] product_id not found in DB, treating as non-promo:', pid);
    }
    if (it.is_promo != null && !!it.is_promo !== serverIsPromo) {
      console.warn('[newebpay-create] is_promo client/server mismatch', {
        product_id: pid, brand_id: brandId, brand_promo_active: brandPromoActive,
        client: !!it.is_promo, server: serverIsPromo,
      });
    }
    return {
      product_id:      pid,
      unit_price:      Number(it.price) || 0,
      quantity:        Number(it.quantity) || 0,
      shipping_method: it.shipping_method === 'carryback' ? 'carryback' : 'shipping',
      is_promo:        serverIsPromo,
    };
  });

  /* Migration 016 — 品牌週會員加碼 audit (best-effort, non-blocking)
   *   client 送的 it.price 已是「該會員 tier 對應的折後價」(前端 BrandPromoEngine 算好)。
   *   server 用 tier_rules + member.tier 重算一次期望價格,超過 ±2 元差距就 console.warn
   *   (不擋單,±NT$5 總額 tolerance 仍是最終防線)。
   *   目的:事後可從 Vercel log 撈出「有沒有惡意用戶偽造 tier 折扣 %」。
   */
  try {
    if (brandPromoRules.size > 0) {
      const memberTierForAudit = (member && member.tier) ? String(member.tier) : 'bronze';
      // 依 brand 分組算 qty (只算活動內品牌)
      const brandQtyForAudit = {};
      items.forEach((it) => {
        const pid = it.product_id != null ? String(it.product_id) : null;
        const brandId = pid ? brandMap.get(pid) : null;
        if (brandId && brandPromoRules.has(brandId)) {
          brandQtyForAudit[brandId] = (brandQtyForAudit[brandId] || 0)
            + (Number(it.quantity) || 0);
        }
      });
      // 為每個活動內品牌算期望 discount_percent
      const brandExpectedPct = {};
      for (const bid of Object.keys(brandQtyForAudit)) {
        const rules = brandPromoRules.get(bid).tier_rules;
        const qty = brandQtyForAudit[bid];
        let matched = null;
        for (const r of rules) {
          const min = Number(r.min_qty) || 0;
          if (qty >= min && (matched == null || min > (Number(matched.min_qty) || 0))) matched = r;
        }
        if (!matched) continue;
        let benefit;
        if (matched.default && typeof matched.default === 'object') {
          const specific = matched[memberTierForAudit] && typeof matched[memberTierForAudit] === 'object'
            ? matched[memberTierForAudit] : null;
          benefit = specific || matched.default;
        } else {
          benefit = matched;
        }
        brandExpectedPct[bid] = Number(benefit.discount_percent) || 0;
      }
      // 逐 item 對照 client 送的價 vs 期望價
      items.forEach((it) => {
        const pid = it.product_id != null ? String(it.product_id) : null;
        const priceRow = priceMap.get(pid);
        const basePrice = priceRow
          ? (it.shipping_method === 'carryback'
              ? priceRow.carryback
              : priceRow.shipping)
          : 0;
        if (basePrice <= 0) return;
        const expectedPct = brandExpectedPct[brandId];
        const expectedPrice = Math.round(basePrice * (1 - expectedPct / 100));
        const clientPrice = Number(it.price) || 0;
        if (Math.abs(clientPrice - expectedPrice) > 2) {
          console.warn('[newebpay-create][audit] brand_promo price mismatch', {
            product_id: pid,
            brand_id: brandId,
            member_tier: memberTierForAudit,
            expected_discount_percent: expectedPct,
            base_price: basePrice,
            expected_effective_price: expectedPrice,
            client_price: clientPrice,
            delta: clientPrice - expectedPrice,
          });
        }
      });
    }
  } catch (auditErr) {
    // audit 失敗絕對不影響結帳流程
    console.warn('[newebpay-create][audit] brand_promo audit threw:',
      auditErr && auditErr.message ? auditErr.message : auditErr);
  }

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
    engineItems,        // 給上層 audit / 持久化 is_promo 用
    promoMap,           // 給 notify 寫 order_items.is_promo 用
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
