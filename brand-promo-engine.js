/**
 * brand-promo-engine.js — NEON LOTUS TW
 * ─────────────────────────────────────────────────────────────────
 * 品牌活動促銷(brand_promos)專用純函式引擎。
 *
 * 定位:
 *   跟 discount-engine.js 是「同一個 pipeline 的兩層」— 這裡處理
 *   時間性品牌活動(HADES 品牌週),discount-engine 處理會員/滿額/etc。
 *
 *   政策:品牌活動商品 = 加強版 is_promo,壓過所有其他優惠。
 *     ✗ 不吃 tier / birthday / bulk / credit / floor
 *     ✗ 不計入 bulk 門檻
 *     ✓ 用階梯規則決定 discount_percent(該品牌購買件數決定階梯)
 *     ✓ 觸發 free_shipping flag(cart.js 決定怎麼展現)
 *     ✓ 金額全額計入 accumulated_spend(會員升等/積分照算 —— 在 order 落地時處理)
 *
 * 這支只做「拿 items + promos → 標記+改單價」— 標記完的 items
 * 交給 discount-engine.js 的正常 pipeline,is_promo=true 的路徑會
 * 天然跳過所有折扣,達成互斥效果。
 *
 * ─────────────────────────────────────────────────────────────────
 */
'use strict';

(function () {
  /* ─── Helpers ────────────────────────────────────────────── */

  /** 該 promo 現在是否有效(is_active + 時間窗) */
  function isPromoActive(promo, now) {
    if (!promo || !promo.is_active) return false;
    const t = now ? now.getTime() : Date.now();
    if (promo.starts_at && new Date(promo.starts_at).getTime() > t) return false;
    if (promo.ends_at   && new Date(promo.ends_at).getTime()   < t) return false;
    return true;
  }

  /**
   * 從 tier_rules 挑符合購買件數的規則。
   * 規則:找 min_qty ≤ qty 的最大 min_qty 那條。qty=0 回 null。
   */
  function matchTier(tierRules, qty) {
    if (!Array.isArray(tierRules) || qty <= 0) return null;
    let best = null;
    for (const r of tierRules) {
      const min = Number(r.min_qty) || 0;
      if (qty >= min && (best == null || min > (Number(best.min_qty) || 0))) {
        best = r;
      }
    }
    return best;
  }

  /**
   * Migration 016 — 從匹配到的階梯規則中,挑出對應會員等級的折扣。
   *
   * 新格式 (016):
   *   { min_qty, default: {...}, silver: {...}, gold: {...}, diamond: {...}, black: {...} }
   *   → 依 memberTier 挑 rule[memberTier],沒有則 fallback 到 rule.default
   *
   * 舊格式 (015):
   *   { min_qty, discount_percent, free_shipping }
   *   → 所有 tier 共用同一組(等同 015 行為)
   *
   * @param {Object} tierRule    matchTier 挑出的階梯 rule
   * @param {string} memberTier  'bronze' | 'silver' | 'gold' | 'diamond' | 'black' | undefined
   * @returns {{discount_percent:number, free_shipping:boolean, label?:string, bonus_note?:string}}
   */
  function pickTierBenefit(tierRule, memberTier) {
    if (!tierRule || typeof tierRule !== 'object') {
      return { discount_percent: 0, free_shipping: false };
    }
    // 新格式:tierRule.default 存在 → 走 per-tier 挑選
    if (tierRule.default && typeof tierRule.default === 'object') {
      const key = memberTier && typeof memberTier === 'string' ? memberTier : null;
      const specific = key && tierRule[key] && typeof tierRule[key] === 'object' ? tierRule[key] : null;
      const chosen = specific || tierRule.default;
      return {
        discount_percent: Number(chosen.discount_percent) || 0,
        free_shipping:    !!chosen.free_shipping,
        label:            chosen.label || null,
        bonus_note:       chosen.bonus_note || null,
      };
    }
    // 舊格式(015):flat rule
    return {
      discount_percent: Number(tierRule.discount_percent) || 0,
      free_shipping:    !!tierRule.free_shipping,
      label:            tierRule.label || null,
      bonus_note:       null,
    };
  }

  /**
   * Build 一個 quick lookup:brand_id → active promo
   * (方便 O(1) 查詢,避免 items × promos 雙重迴圈)
   */
  function buildActivePromoMap(brandPromos, now) {
    const map = {};
    if (!Array.isArray(brandPromos)) return map;
    for (const p of brandPromos) {
      if (isPromoActive(p, now) && p.brand_id) {
        map[p.brand_id] = p;
      }
    }
    return map;
  }

  /**
   * 主要 API:pre-process 一組 cart items,標記品牌促銷商品。
   *
   * 副作用:
   *   - 對受品牌促銷的 items,產生新的 item 物件(不 mutate 原始 items):
   *       * original_unit_price 保留原價供 UI 顯示
   *       * unit_price 替換為折後價(round 到整數)
   *       * is_promo = true(讓 discount-engine 走 promo 路徑,跳過所有折扣)
   *       * _brand_promo = { label, discount_percent, free_shipping, min_qty }
   *   - 未受影響的 items 原封不動 return 回來(保留原本 is_promo 狀態)。
   *
   * @param {Array}  items         cart items,每筆需有 brand_id, unit_price, quantity
   * @param {Array}  brandPromos   從 supabase 撈的 brand_promos rows
   * @param {Date?}  now           當下時間(預設 new Date())
   * @param {string?} memberTier   Migration 016 — 會員等級 ('bronze'|'silver'|'gold'|'diamond'|'black'),
   *                                未登入 / 未傳 → 走 rule.default
   *
   * @returns {Object} {
   *   items,              // 新的 items 陣列(部分被標記+改單價)
   *   applied,            // 有實際套用的 brand_id 陣列(給 UI 顯示 banner 用)
   *   brand_summary,      // { brandId: { label, qty, tier, discount_percent, free_shipping, savings, member_tier, tier_label, bonus_note } }
   *   any_free_shipping,  // 有沒有任何品牌觸發免運(cart.js 決定運費用)
   *   free_shipping_brands, // Set of brand_id 免運名單(未來若要「該品牌 items 從運費計算排除」用)
   *   raw_discount_total, // 品牌促銷省下的總金額(所有品牌加總)
   *   member_tier,        // 生效的 tier key(audit / debug 用)
   * }
   */
  function applyBrandPromos(items, brandPromos, now, memberTier) {
    const safeItems = Array.isArray(items) ? items : [];
    const active = buildActivePromoMap(brandPromos, now);
    const tierKey = (memberTier && typeof memberTier === 'string') ? memberTier : 'bronze';

    // ── 先 group by brand_id 算件數(只算 active promo 的品牌) ──
    const brandQty = {};
    for (const it of safeItems) {
      const bid = it && it.brand_id;
      if (bid && active[bid]) {
        brandQty[bid] = (brandQty[bid] || 0) + (Number(it.quantity) || 0);
      }
    }

    // ── 對每個受影響品牌 → 挑 tier + 挑會員加碼 ──
    const brand_summary = {};
    const applied = [];
    const free_shipping_brands = new Set();
    for (const bid of Object.keys(brandQty)) {
      const promo = active[bid];
      const qty = brandQty[bid];
      const tier = matchTier(promo.tier_rules, qty);
      if (!tier) continue;
      const benefit = pickTierBenefit(tier, tierKey);
      const pct  = benefit.discount_percent;
      const free = benefit.free_shipping;
      brand_summary[bid] = {
        label: promo.label || bid,
        qty,
        min_qty: Number(tier.min_qty) || 0,
        discount_percent: pct,
        free_shipping: free,
        savings: 0, // 之後累加
        member_tier: tierKey,           // 016 — 生效的會員等級
        tier_label: benefit.label,      // 016 — 該階×該會員的專屬文案
        bonus_note: benefit.bonus_note, // 016 — 額外贈品/福利說明
      };
      applied.push(bid);
      if (free) free_shipping_brands.add(bid);
    }

    // ── 重寫 items(不 mutate 原物件)──
    const newItems = safeItems.map((it) => {
      const bid = it && it.brand_id;
      if (!bid || !brand_summary[bid]) return it;   // 不受影響,原樣

      const sum = brand_summary[bid];
      const pct = sum.discount_percent;
      const orig = Number(it.unit_price) || 0;

      // 折後單價(round 到整數;跟 discount-engine 全站一致採 Math.round)
      const discounted = pct > 0 ? Math.round(orig * (1 - pct / 100)) : orig;

      const perLineSaving = (orig - discounted) * (Number(it.quantity) || 0);
      sum.savings += perLineSaving;

      return {
        ...it,
        original_unit_price: orig,        // UI 用來劃刪除線顯示原價
        unit_price:          discounted,  // 引擎會用這個
        is_promo:            true,        // 走 promo 路徑,自動跳過 tier/生日/滿額/credit
        _brand_promo: {
          label: sum.label,
          discount_percent: pct,
          free_shipping: sum.free_shipping,
          min_qty: sum.min_qty,
          member_tier: sum.member_tier,   // 016 — 讓 order_items 落地時可 audit
          tier_label: sum.tier_label,     // 016 — 該階×該會員的專屬文案
          bonus_note: sum.bonus_note,     // 016 — 附加福利
        },
      };
    });

    const raw_discount_total = Object.values(brand_summary)
      .reduce((s, b) => s + (b.savings || 0), 0);

    return {
      items: newItems,
      applied,
      brand_summary,
      any_free_shipping: free_shipping_brands.size > 0,
      free_shipping_brands: Array.from(free_shipping_brands),
      raw_discount_total,
      member_tier: tierKey,   // 016 — 生效的會員等級,便於 debug / audit
    };
  }

  /**
   * 給 UI 用:某品牌現在 qty 是 X,離下一階還差幾件、下一階什麼折扣?
   * (品牌頁 / 購物車可以顯示「再買 1 件即享 92 折」upsell 文案)
   *
   * @returns {{next_min_qty:number, next_discount_percent:number, next_free_shipping:boolean, gap:number} | null}
   */
  function nextTierGap(tierRules, currentQty) {
    if (!Array.isArray(tierRules)) return null;
    const sorted = tierRules.slice().sort(
      (a, b) => (Number(a.min_qty) || 0) - (Number(b.min_qty) || 0)
    );
    for (const r of sorted) {
      const min = Number(r.min_qty) || 0;
      if (currentQty < min) {
        return {
          next_min_qty: min,
          next_discount_percent: Number(r.discount_percent) || 0,
          next_free_shipping: !!r.free_shipping,
          gap: min - currentQty,
        };
      }
    }
    return null; // 已達最高階
  }

  /* ─── UMD-ish export(前端 window / node CommonJS 都可用)─── */
  const api = {
    applyBrandPromos,
    matchTier,
    pickTierBenefit,       // 016 — 讓 UI (banner) 也能查「某階×某等級」的折扣
    isPromoActive,
    buildActivePromoMap,
    nextTierGap,
  };

  if (typeof window !== 'undefined') {
    window.BrandPromoEngine = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
