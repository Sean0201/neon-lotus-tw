/**
 * api/lib/discount.js — NEON LOTUS TW (Node / Vercel serverless)
 * ─────────────────────────────────────────────────────────────────
 * 後端折扣計算引擎 — 是前端 discount-engine.js 的 CommonJS 版本。
 * 演算法、設定、輸出結構必須與前端 1:1 一致 (Phase 2.2 single-source-of-truth)。
 *
 * 疊加順序: 原價 → ①等級折扣 → ②生日 9 折 → ③雙軌滿額現折 → ④折抵金 → ⑤樓地板
 *
 * 用法:
 *   const D = require('./lib/discount');
 *   await D.loadConfig(supabase);                       // 從 site_config 撈設定
 *   const r = D.computeCart({ items, member, today });  // 算金額
 *   if (Math.abs(r.final_subtotal + shippingFee - clientTotal) <= 5) { ... }
 * ─────────────────────────────────────────────────────────────────
 */
'use strict';

/* ─── 內建預設 (跟 db/migrations/006 + discount-engine.js 一致) ─── */
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

let _config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

/* ─── Helpers ────────────────────────────────────────────── */
function safeParseJSON(str, fallback) {
  if (str == null) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

function safeNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bulkDiscountFor(amount, table) {
  let best = 0;
  if (!Array.isArray(table)) return 0;
  for (const row of table) {
    const threshold = Array.isArray(row) ? row[0] : row.threshold;
    const discount  = Array.isArray(row) ? row[1] : row.discount;
    if (amount >= threshold) best = discount;
  }
  return best;
}

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
    // 失敗就用預設,不要 throw 影響結帳流程
    console.warn('[discount.lib] loadConfig failed, using defaults:', err && err.message ? err.message : err);
  }
}

/* ─── 等級判定 ──────────────────────────────────────────── */
function computeTierFromSpend(spend) {
  const t = _config.tier_thresholds;
  const ordered = [
    ['black',   t.black   != null ? t.black   : 60000],
    ['diamond', t.diamond != null ? t.diamond : 30000],
    ['gold',    t.gold    != null ? t.gold    : 15000],
    ['silver',  t.silver  != null ? t.silver  :  5000],
    ['bronze',  t.bronze  != null ? t.bronze  :     0],
  ];
  const s = Math.max(0, Number(spend) || 0);
  for (const [name, th] of ordered) {
    if (s >= th) return name;
  }
  return 'bronze';
}

function nextTier(currentTier) {
  const order = ['bronze', 'silver', 'gold', 'diamond', 'black'];
  const idx = order.indexOf(currentTier);
  if (idx < 0 || idx >= order.length - 1) return null;
  const nextKey = order[idx + 1];
  return { key: nextKey, threshold: _config.tier_thresholds[nextKey] };
}

/* ─── 生日判定 ──────────────────────────────────────────── */
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
function computeCart(args) {
  args = args || {};
  const items   = Array.isArray(args.items) ? args.items : [];
  const member  = args.member || null;
  const today   = args.today || new Date();
  const useCredit = args.useCredit !== false; // 預設 true

  /* A. 原價 + 按 shipping_method 分組 */
  let raw_subtotal = 0;
  const groups = {
    carryback: { raw: 0, items_count: 0 },
    shipping:  { raw: 0, items_count: 0 },
  };
  items.forEach((it) => {
    const line = (Number(it.unit_price) || 0) * (Number(it.quantity) || 0);
    raw_subtotal += line;
    const m = (it.shipping_method === 'carryback') ? 'carryback' : 'shipping';
    groups[m].raw += line;
    groups[m].items_count += 1;
  });

  /* B. 等級折扣 */
  const tierKey = member ? (member.tier || 'bronze') : 'bronze';
  const tierRate = (_config.tier_discount_rates[tierKey] != null)
    ? _config.tier_discount_rates[tierKey]
    : 1.0;
  const tier_eligible = !!member && tierRate < 1.0;

  groups.carryback.after_tier = Math.round(groups.carryback.raw * tierRate);
  groups.shipping.after_tier  = Math.round(groups.shipping.raw  * tierRate);

  const subtotal_after_tier = groups.carryback.after_tier + groups.shipping.after_tier;
  const tier_discount = raw_subtotal - subtotal_after_tier;

  /* C. 生日 9 折 */
  const birthday_eligible = !!member && isBirthdayEligible(member, today);
  const birthdayRate = birthday_eligible ? (_config.birthday_discount_rate || 0.9) : 1.0;

  groups.carryback.after_birthday = Math.round(groups.carryback.after_tier * birthdayRate);
  groups.shipping.after_birthday  = Math.round(groups.shipping.after_tier  * birthdayRate);

  const subtotal_after_birthday = groups.carryback.after_birthday + groups.shipping.after_birthday;
  const birthday_discount = subtotal_after_tier - subtotal_after_birthday;

  /* D. 雙軌滿額現折 (僅會員) */
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

  /* E. 折抵金 (B1 自動扣) */
  let credit_used = 0;
  const credit_balance = member ? Math.max(0, Number(member.founding_credit_balance) || 0) : 0;
  if (useCredit && credit_balance > 0 && subtotal_after_bulk > 0) {
    credit_used = Math.min(credit_balance, subtotal_after_bulk);
  }
  const subtotal_after_credit = Math.max(0, subtotal_after_bulk - credit_used);

  /* F. 樓地板 */
  const floorRate = (_config.tier_floor_rates[tierKey] != null)
    ? _config.tier_floor_rates[tierKey]
    : 0.75;
  const floor_amount = Math.round(raw_subtotal * floorRate);

  let final_subtotal = subtotal_after_credit;
  let floor_clamped = false;
  let floor_refund = 0;
  if (final_subtotal < floor_amount) {
    floor_refund = floor_amount - final_subtotal;
    final_subtotal = floor_amount;
    floor_clamped = true;
  }

  const total_savings = raw_subtotal - final_subtotal;

  return {
    tier_key: tierKey,
    tier_rate: tierRate,
    tier_eligible,

    raw_subtotal,
    groups,

    tier_discount,
    birthday_eligible,
    birthday_discount,
    bulk_eligible,
    bulk_discount_total,
    credit_balance,
    credit_used,
    floor_rate: floorRate,
    floor_amount,
    floor_clamped,
    floor_refund,

    subtotal_after_tier,
    subtotal_after_birthday,
    subtotal_after_bulk,
    subtotal_after_credit,
    final_subtotal,

    total_savings,
  };
}

function isFreeShipping(subtotalForShipping) {
  return Number(subtotalForShipping) >= (_config.free_shipping_threshold || 3000);
}

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
  return null;
}

/* ─── ESM exports (package.json "type": "module") ─── */
const getConfig    = () => JSON.parse(JSON.stringify(_config));
const resetConfig  = () => { _config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)); };
const TIER_ORDER   = ['bronze', 'silver', 'gold', 'diamond', 'black'];

export {
  computeCart,
  computeTierFromSpend,
  nextTier,
  isBirthdayEligible,
  isFreeShipping,
  nextBulkRung,
  setConfigFromRows,
  loadConfig,
  getConfig,
  resetConfig,
  TIER_ORDER,
};

export default {
  computeCart,
  computeTierFromSpend,
  nextTier,
  isBirthdayEligible,
  isFreeShipping,
  nextBulkRung,
  setConfigFromRows,
  loadConfig,
  getConfig,
  resetConfig,
  TIER_ORDER,
};
