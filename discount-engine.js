/**
 * discount-engine.js — NEON LOTUS TW
 * ─────────────────────────────────────────────────────────────────
 * 共用折扣計算引擎 — 前端 cart.js + 後端 lib/discount.js 共用同套邏輯
 *
 * 疊加順序:
 *   原價 → ①等級折扣 → ②生日 9 折 → ③雙軌滿額現折 → ④折抵金 → ⑤樓地板
 *
 * 設計重點:
 *   - 雙軌滿額現折以「等級折扣後金額」判定,而且分 carryback / shipping 兩軌獨立判定
 *   - 樓地板:bronze/silver/gold/diamond 75%,black 70%
 *   - 折抵金 NT$100:只要 founding_credit_balance > 0 就自動扣 (第一次下單)
 *   - 訪客 (member=null) 拿不到任何會員折扣;只有等級折扣 100% (= 原價) + 無滿額現折 + 無生日 + 無折抵金
 *
 * 此檔不直接讀 Supabase — config 由 cart.js / backend 載入後傳進來,
 * 或由 DiscountEngine.setConfig() 注入。若沒設,使用內建 fallback 預設值
 * (跟 migration 006 一致)。
 * ─────────────────────────────────────────────────────────────────
 */
'use strict';

(function () {
  /* ─── 內建預設 (跟 db/migrations/006_tier_rates_and_black.sql 一致) ─── */
  const DEFAULT_CONFIG = {
    tier_thresholds: {
      bronze: 0, silver: 5000, gold: 15000, diamond: 30000, black: 60000,
    },
    tier_discount_rates: {
      bronze: 1.0, silver: 0.95, gold: 0.92, diamond: 0.88, black: 0.85,
    },
    tier_floor_rates: {
      bronze: 0.75, silver: 0.75, gold: 0.75, diamond: 0.75, black: 0.70,
    },
    bulk_discount_carryback: [[4000, 300], [8000, 1000], [15000, 2500]],
    bulk_discount_shipping:  [[5000, 300], [10000, 1000], [19000, 2500]],
    birthday_discount_rate: 0.9,
    signup_credit_amount: 100,
    free_shipping_threshold: 3000,
  };

  let _config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)); // deep clone

  /* ─── Helpers ────────────────────────────────────────────── */
  function safeParseJSON(str, fallback) {
    if (!str) return fallback;
    try { return JSON.parse(str); } catch { return fallback; }
  }

  function safeNum(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  /** 找出 ≤ amount 的最大門檻對應的折扣 (table 已按升冪排) */
  function bulkDiscountFor(amount, table) {
    let best = 0;
    for (const row of table) {
      const threshold = Array.isArray(row) ? row[0] : row.threshold;
      const discount  = Array.isArray(row) ? row[1] : row.discount;
      if (amount >= threshold) best = discount;
    }
    return best;
  }

  /** 把 site_config rows ([{key,value}, ...]) 轉成 _config 物件 */
  function setConfigFromRows(rows) {
    if (!Array.isArray(rows)) return;
    const map = {};
    rows.forEach((r) => { map[r.key] = r.value; });

    if (map.tier_thresholds)         _config.tier_thresholds         = safeParseJSON(map.tier_thresholds,         DEFAULT_CONFIG.tier_thresholds);
    if (map.tier_discount_rates)     _config.tier_discount_rates     = safeParseJSON(map.tier_discount_rates,     DEFAULT_CONFIG.tier_discount_rates);
    if (map.tier_floor_rates)        _config.tier_floor_rates        = safeParseJSON(map.tier_floor_rates,        DEFAULT_CONFIG.tier_floor_rates);
    if (map.bulk_discount_carryback) _config.bulk_discount_carryback = safeParseJSON(map.bulk_discount_carryback, DEFAULT_CONFIG.bulk_discount_carryback);
    if (map.bulk_discount_shipping)  _config.bulk_discount_shipping  = safeParseJSON(map.bulk_discount_shipping,  DEFAULT_CONFIG.bulk_discount_shipping);

    if (map.birthday_discount_rate)  _config.birthday_discount_rate  = safeNum(map.birthday_discount_rate,  DEFAULT_CONFIG.birthday_discount_rate);
    if (map.signup_credit_amount)    _config.signup_credit_amount    = safeNum(map.signup_credit_amount,    DEFAULT_CONFIG.signup_credit_amount);
    if (map.free_shipping_threshold) _config.free_shipping_threshold = safeNum(map.free_shipping_threshold, DEFAULT_CONFIG.free_shipping_threshold);
  }

  /** 主動 fetch site_config (若 Supabase client 可用) */
  async function loadConfig(supabaseClient) {
    if (!supabaseClient || typeof supabaseClient.from !== 'function') return;
    try {
      const { data, error } = await supabaseClient
        .from('site_config')
        .select('key, value')
        .in('key', [
          'tier_thresholds',
          'tier_discount_rates',
          'tier_floor_rates',
          'bulk_discount_carryback',
          'bulk_discount_shipping',
          'birthday_discount_rate',
          'signup_credit_amount',
          'free_shipping_threshold',
        ]);
      if (!error && Array.isArray(data)) setConfigFromRows(data);
    } catch (err) {
      console.warn('[DiscountEngine] loadConfig failed, using defaults:', err);
    }
  }

  /* ─── 等級判定 ──────────────────────────────────────────── */
  /** 依累積消費計算實際應有等級 (跟 DB tier 欄位可能不同,以 spend 為準較保險) */
  function computeTierFromSpend(spend) {
    const t = _config.tier_thresholds;
    const ordered = [
      ['black',   t.black   ?? 60000],
      ['diamond', t.diamond ?? 30000],
      ['gold',    t.gold    ?? 15000],
      ['silver',  t.silver  ??  5000],
      ['bronze',  t.bronze  ??     0],
    ];
    const s = Math.max(0, Number(spend) || 0);
    for (const [name, th] of ordered) {
      if (s >= th) return name;
    }
    return 'bronze';
  }

  /** 取下一階等級資訊 (給進度條用) */
  function nextTier(currentTier) {
    const order = ['bronze', 'silver', 'gold', 'diamond', 'black'];
    const idx = order.indexOf(currentTier);
    if (idx < 0 || idx >= order.length - 1) return null;
    const nextKey = order[idx + 1];
    return { key: nextKey, threshold: _config.tier_thresholds[nextKey] };
  }

  /* ─── 生日判定 ──────────────────────────────────────────── */
  /**
   * 判斷今天是不是「生日月內」+ 本年還沒用過。
   * member.birthday 是 'YYYY-MM-DD' 字串。
   * member.birthday_used_year 是 integer year (或 null)。
   */
  function isBirthdayEligible(member, today) {
    if (!member || !member.birthday) return false;
    today = today || new Date();
    const bday = String(member.birthday);
    const m = bday.match(/^\d{4}-(\d{2})-/);
    if (!m) return false;
    const birthMonth = parseInt(m[1], 10);
    const todayMonth = today.getMonth() + 1;
    if (birthMonth !== todayMonth) return false;
    const usedYear = Number(member.birthday_used_year) || 0;
    const todayYear = today.getFullYear();
    return usedYear !== todayYear;
  }

  /* ─── 主計算 ────────────────────────────────────────────── */
  /**
   * 計算購物車折扣明細。
   *
   * @param {Object}  args
   * @param {Array}   args.items          購物車 line items,每筆 { unit_price, quantity, shipping_method }
   *                                       shipping_method ∈ {'carryback','shipping'} (預設 'shipping')
   * @param {Object?} args.member         會員物件 (null = 訪客)
   *                                       member 要的欄位: tier, accumulated_spend, founding_credit_balance,
   *                                                       birthday, birthday_used_year
   * @param {Date?}   args.today          今天日期 (預設 new Date())
   * @param {Boolean?} args.useCredit     是否使用折抵金 (預設 true — B1 自動扣)
   *
   * @returns {Object}  明細結果 (見下方 README 結構)
   */
  function computeCart(args) {
    args = args || {};
    const items   = Array.isArray(args.items) ? args.items : [];
    const member  = args.member || null;
    const today   = args.today || new Date();
    const useCredit = args.useCredit !== false; // 預設 true

    /* ── A. 原價 + 按 shipping_method 分組 + 拆 regular vs promo
     *   政策 (migration 014):it.is_promo === true 的商品為「品牌方特價」,
     *   不參與站內任何優惠 (tier / birthday / bulk / credit / floor),
     *   按 unit_price 原價成交,只計入最終 final_subtotal。
     *   groups 只代表 regular_items,promo_groups 獨立呈現給 UI 顯示。
     */
    let raw_subtotal = 0;     // 整車 (含 promo)
    let promo_subtotal = 0;   // 特價品原價合計
    const groups = {          // ← 只含 regular items
      carryback: { raw: 0, items_count: 0 },
      shipping:  { raw: 0, items_count: 0 },
    };
    const promo_groups = {    // ← 只含 promo items
      carryback: { raw: 0, items_count: 0 },
      shipping:  { raw: 0, items_count: 0 },
    };
    items.forEach((it) => {
      const line = (Number(it.unit_price) || 0) * (Number(it.quantity) || 0);
      raw_subtotal += line;
      const m = (it.shipping_method === 'carryback') ? 'carryback' : 'shipping';
      if (it.is_promo) {
        promo_subtotal += line;
        promo_groups[m].raw += line;
        promo_groups[m].items_count += 1;
      } else {
        groups[m].raw += line;
        groups[m].items_count += 1;
      }
    });
    const regular_subtotal = raw_subtotal - promo_subtotal;

    /* ── B. 等級折扣 (訪客 = 1.0, 全價) — 只套到 regular_items ── */
    const tierKey = member ? (member.tier || 'bronze') : 'bronze';
    const tierRate = (_config.tier_discount_rates[tierKey] != null)
      ? _config.tier_discount_rates[tierKey]
      : 1.0;
    const tier_eligible = !!member && tierRate < 1.0;

    groups.carryback.after_tier = Math.round(groups.carryback.raw * tierRate);
    groups.shipping.after_tier  = Math.round(groups.shipping.raw  * tierRate);

    const subtotal_after_tier = groups.carryback.after_tier + groups.shipping.after_tier;
    const tier_discount = regular_subtotal - subtotal_after_tier;

    /* ── C. 生日 9 折 (僅會員 + 生日月 + 本年未用) ── */
    const birthday_eligible = !!member && isBirthdayEligible(member, today);
    const birthdayRate = birthday_eligible ? (_config.birthday_discount_rate || 0.9) : 1.0;

    // 套用方式:每組 after_tier × birthdayRate 後得到 after_birthday
    groups.carryback.after_birthday = Math.round(groups.carryback.after_tier * birthdayRate);
    groups.shipping.after_birthday  = Math.round(groups.shipping.after_tier  * birthdayRate);

    const subtotal_after_birthday = groups.carryback.after_birthday + groups.shipping.after_birthday;
    const birthday_discount = subtotal_after_tier - subtotal_after_birthday;

    /* ── D. 雙軌滿額現折 (僅會員) — 以 after_birthday 金額判定 ── */
    const bulk_eligible = !!member;
    if (bulk_eligible) {
      groups.carryback.bulk_discount = bulkDiscountFor(groups.carryback.after_birthday, _config.bulk_discount_carryback);
      groups.shipping.bulk_discount  = bulkDiscountFor(groups.shipping.after_birthday,  _config.bulk_discount_shipping);
    } else {
      groups.carryback.bulk_discount = 0;
      groups.shipping.bulk_discount  = 0;
    }
    groups.carryback.after_bulk = Math.max(0, groups.carryback.after_birthday - groups.carryback.bulk_discount);
    groups.shipping.after_bulk  = Math.max(0, groups.shipping.after_birthday  - groups.shipping.bulk_discount);

    const subtotal_after_bulk = groups.carryback.after_bulk + groups.shipping.after_bulk;
    const bulk_discount_total = groups.carryback.bulk_discount + groups.shipping.bulk_discount;

    /* ── F (預先算樓地板). 樓地板金額 (raw × tier_floor_rate)
     *   先算樓地板,因為 E (折抵金) 需要知道地板才能避免「折抵金被樓地板吃掉」的帳務 bug。
     *   例: raw=200, floor_rate=0.75 → floor_amount=150
     *       若用戶有 100 折抵金,理論上扣完是 100,但被樓地板拉回 150,
     *       實際只省 50,但 credit_balance 卻被扣 100 — 多扣 50。
     *   修法:credit_used 上限 = subtotal_after_bulk - floor_amount,
     *       超出地板的部分不要扣折抵金,留給使用者下次用。
     */
    const floorRate = (_config.tier_floor_rates[tierKey] != null)
      ? _config.tier_floor_rates[tierKey]
      : 0.75;
    // 樓地板基準 = 正常品原價 × floor_rate (不含 promo,因為 promo 不參與折扣)
    const floor_amount = Math.round(regular_subtotal * floorRate);

    /* ── E. 折抵金 (B1 自動扣 — 餘額 > 0 就用,但不超過地板能吸收的量) ── */
    let credit_used = 0;
    const credit_balance = member ? Math.max(0, Number(member.founding_credit_balance) || 0) : 0;
    if (useCredit && credit_balance > 0 && subtotal_after_bulk > 0) {
      const intended_credit  = Math.min(credit_balance, subtotal_after_bulk);
      // 折抵金最多只能讓總額降到地板,超出的部分等於「沒用到」
      const useful_credit_cap = Math.max(0, subtotal_after_bulk - floor_amount);
      credit_used = Math.min(intended_credit, useful_credit_cap);
    }
    const subtotal_after_credit = Math.max(0, subtotal_after_bulk - credit_used);

    /* ── F. 樓地板實際 clamp — 只對 regular_items 部分 clamp
     *   regular_final 是 regular 部分跑完所有 pipeline 的金額,
     *   final_subtotal = regular_final + promo_subtotal (promo 永遠按原價)。
     */
    let regular_final = subtotal_after_credit;
    let floor_clamped = false;
    let floor_refund = 0;
    if (regular_final < floor_amount) {
      floor_refund = floor_amount - regular_final;
      regular_final = floor_amount;
      floor_clamped = true;
    }
    const final_subtotal = regular_final + promo_subtotal;

    const total_savings = raw_subtotal - final_subtotal;

    return {
      // 等級資訊
      tier_key: tierKey,
      tier_rate: tierRate,
      tier_eligible,

      // 各層金額
      raw_subtotal,                  // 整車原價合計 (regular + promo)
      regular_subtotal,              // 正常品原價合計 (參與折扣的部分)
      promo_subtotal,                // 特價品原價合計 (不參與任何折扣)
      groups,                        // { carryback: {raw, after_tier, bulk_discount, after_bulk, ...}, shipping: {...} } — 僅 regular
      promo_groups,                  // { carryback: {raw, items_count}, shipping: {raw, items_count} } — 特價品分組

      // 折扣明細
      tier_discount,                 // 等級折扣金額
      birthday_eligible,
      birthday_discount,             // 生日 9 折金額
      bulk_eligible,
      bulk_discount_total,           // 雙軌滿額現折合計
      credit_balance,                // 折抵金餘額
      credit_used,                   // 本次扣抵金額 (0 或 100)
      floor_rate: floorRate,
      floor_amount,                  // 樓地板絕對金額
      floor_clamped,                 // 是否觸發樓地板
      floor_refund,                  // 樓地板拉回的金額

      // 結帳金額
      subtotal_after_tier,
      subtotal_after_birthday,
      subtotal_after_bulk,
      subtotal_after_credit,
      regular_final,                 // regular 部分最終 (含樓地板 clamp 後)
      final_subtotal,                // 商品部分最終應付 (= regular_final + promo_subtotal,不含運費)

      total_savings,                 // 總共省了多少 (= raw_subtotal - final_subtotal)
    };
  }

  /* ─── 運費計算 (cart.js 也會用) ───────────────────────────
   * 規則:超商取貨滿 $3,000 免運;其他情況 cart.js 自己決定收多少。
   * 這裡只提供 isFreeShipping 判定;cart.js 已有自己的 shippingFeeMatrix。
   */
  function isFreeShipping(subtotalForShipping) {
    return Number(subtotalForShipping) >= (_config.free_shipping_threshold || 3000);
  }

  /**
   * 給 upsell 用 — 找到 method 那條 ladder 上,>= amount 的最低門檻 (差多少升下一階)
   * @param {string} method 'carryback' | 'shipping'
   * @param {number} amount 用於判定的金額 (通常是 after_birthday 或 after_tier)
   * @returns {{threshold:number, discount:number, gap:number} | null}
   */
  function nextBulkRung(method, amount) {
    const table = (method === 'carryback')
      ? _config.bulk_discount_carryback
      : _config.bulk_discount_shipping;
    if (!Array.isArray(table)) return null;
    for (const row of table) {
      const threshold = Array.isArray(row) ? row[0] : row.threshold;
      const discount  = Array.isArray(row) ? row[1] : row.discount;
      if (amount < threshold) {
        return { threshold, discount, gap: threshold - amount };
      }
    }
    return null; // 已達最高階
  }

  /* ─── 暴露 API ─────────────────────────────────────────── */
  window.DiscountEngine = {
    // 計算
    computeCart,

    // 等級工具
    computeTierFromSpend,
    nextTier,

    // 生日判定
    isBirthdayEligible,

    // 運費 (only the free-threshold check)
    isFreeShipping,
    nextBulkRung,

    // Config 管理
    getConfig: () => JSON.parse(JSON.stringify(_config)),
    setConfigFromRows,
    loadConfig,
    resetConfig: () => { _config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)); },

    // 常數 (給 UI 顯示等級對照用)
    TIER_ORDER: ['bronze', 'silver', 'gold', 'diamond', 'black'],
    TIER_LABELS: {
      bronze:  { emoji: '🥉', label: '銅卡' },
      silver:  { emoji: '🥈', label: '銀卡' },
      gold:    { emoji: '🥇', label: '金卡' },
      diamond: { emoji: '💎', label: '鑽石卡' },
      black:   { emoji: '🖤', label: '黑卡' },
    },
  };

  /* ─── 自動載入 site_config (若 Supabase 已 ready) ─── */
  function tryAutoLoad() {
    if (window.supabase && typeof window.supabase.from === 'function') {
      loadConfig(window.supabase);
    } else if (window.supabaseClient && typeof window.supabaseClient.from === 'function') {
      loadConfig(window.supabaseClient);
    } else {
      setTimeout(tryAutoLoad, 200);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryAutoLoad);
  } else {
    tryAutoLoad();
  }
})();
