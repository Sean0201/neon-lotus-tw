-- 016_brand_promo_member_tier.sql
-- ============================================================
-- FEATURE:品牌週活動「會員加碼」— tier_rules JSON schema 升級
--
-- 背景:
--   015 的 tier_rules 是「一視同仁」— 每階給所有客一樣折扣。
--   Sean 2026-08-07 決策:改成「不同會員等級享不同折扣 %」以強化尊榮感。
--
-- 政策 (Sean 2026-08-07 確認, 方案 B 3 級合併):
--   1. bronze / 未登入 → 用 rule.default (基礎活動價)
--   2. silver / gold   → 用 rule.silver 或 rule.gold (相同 % 值,拉開跟一般客差距)
--   3. diamond / black → 用 rule.diamond 或 rule.black (最深折扣 + 限定贈品)
--   4. 除了折扣 % 之外, brand promo 商品本身仍不與其他優惠疊加
--      (is_promo=true 由 BrandPromoEngine 標記,discount-engine 天然跳過 tier/生日/滿額)
--   5. black 目前只有 2 位 (Sean + 小幫手), 規則與 diamond 相同
--
-- 新 tier_rules schema:
--   [
--     {
--       "min_qty": 1,
--       "default":  { "discount_percent": 0,  "free_shipping": true, "label": "任1件免運" },
--       "silver":   { "discount_percent": 0,  "free_shipping": true, "label": "銀卡任1件免運" },
--       "gold":     { "discount_percent": 3,  "free_shipping": true, "label": "金卡任1件97折免運" },
--       "diamond":  { "discount_percent": 5,  "free_shipping": true, "label": "鑽石卡任1件95折免運" },
--       "black":    { "discount_percent": 5,  "free_shipping": true, "label": "黑卡任1件95折免運" }
--     },
--     ...
--   ]
--
-- 向後相容:
--   - BrandPromoEngine 若讀到「舊格式」(flat: {min_qty, discount_percent, free_shipping}),
--     視為所有 tier 共用 default,即等同 015 行為。
--   - 這支 migration 只更新 HADES seed 到新格式,不強制轉換其他資料。
--     未來若你手動 SQL 建其他品牌活動, 可自由選擇新舊格式。
--
-- ============================================================

BEGIN;

-- ── 更新 HADES 首波 seed 到新格式(方案 B 3 級合併)──
UPDATE brand_promos
SET tier_rules = '[
  {
    "min_qty": 1,
    "default":  { "discount_percent": 0,  "free_shipping": true, "label": "任1件免運" },
    "silver":   { "discount_percent": 0,  "free_shipping": true, "label": "任1件免運" },
    "gold":     { "discount_percent": 3,  "free_shipping": true, "label": "金卡任1件97折免運" },
    "diamond":  { "discount_percent": 5,  "free_shipping": true, "label": "鑽石卡任1件95折免運" },
    "black":    { "discount_percent": 5,  "free_shipping": true, "label": "黑卡任1件95折免運" }
  },
  {
    "min_qty": 2,
    "default":  { "discount_percent": 5,  "free_shipping": true, "label": "2件95折免運" },
    "silver":   { "discount_percent": 10, "free_shipping": true, "label": "銀+金卡2件9折免運" },
    "gold":     { "discount_percent": 10, "free_shipping": true, "label": "銀+金卡2件9折免運" },
    "diamond":  { "discount_percent": 12, "free_shipping": true, "label": "鑽石+黑卡2件88折免運" },
    "black":    { "discount_percent": 12, "free_shipping": true, "label": "鑽石+黑卡2件88折免運" }
  },
  {
    "min_qty": 3,
    "default":  { "discount_percent": 8,  "free_shipping": true, "label": "3件92折免運" },
    "silver":   { "discount_percent": 13, "free_shipping": true, "label": "銀+金卡3件87折免運" },
    "gold":     { "discount_percent": 13, "free_shipping": true, "label": "銀+金卡3件87折免運" },
    "diamond":  { "discount_percent": 15, "free_shipping": true, "label": "鑽石+黑卡3件85折免運" },
    "black":    { "discount_percent": 15, "free_shipping": true, "label": "鑽石+黑卡3件85折免運" }
  },
  {
    "min_qty": 5,
    "default":  { "discount_percent": 12, "free_shipping": true, "label": "5件88折免運" },
    "silver":   { "discount_percent": 18, "free_shipping": true, "label": "銀+金卡5件82折免運" },
    "gold":     { "discount_percent": 18, "free_shipping": true, "label": "銀+金卡5件82折免運" },
    "diamond":  { "discount_percent": 20, "free_shipping": true, "label": "鑽石+黑卡5件80折免運 + HADES x NL 限定貼紙", "bonus_note": "HADES x NL 限定貼紙" },
    "black":    { "discount_percent": 20, "free_shipping": true, "label": "鑽石+黑卡5件80折免運 + HADES x NL 限定貼紙", "bonus_note": "HADES x NL 限定貼紙" }
  }
]'::jsonb
WHERE brand_id = 'hades';

-- 附註:tier_rules 是彈性 JSONB,不加 CHECK constraint,由前後端 BrandPromoEngine 驗證。

COMMIT;

-- ═══════════════════════════════════════════════════════════════
-- 操作指南 (Sean 用)
-- ═══════════════════════════════════════════════════════════════

-- ── 檢查 HADES 加碼結構 ──
-- SELECT brand_id, jsonb_array_length(tier_rules) AS tier_count, tier_rules
-- FROM brand_promos WHERE brand_id = 'hades';

-- ── 未來為新品牌開加碼活動 (拷貝 HADES 模板) ──
-- INSERT INTO brand_promos (brand_id, label, tier_rules, is_active) VALUES
-- ('mbi', 'MBI 週年慶', '[
--   {
--     "min_qty": 1,
--     "default":  { "discount_percent": 0,  "free_shipping": true, "label": "任1件免運" },
--     "diamond":  { "discount_percent": 5,  "free_shipping": true, "label": "鑽石卡任1件95折免運" }
--     -- ...其他 tier
--   }
-- ]'::jsonb, false);

-- ── 想暫時把某品牌活動退回「一視同仁」(舊格式)──
-- UPDATE brand_promos SET tier_rules = '[
--   {"min_qty": 1, "discount_percent": 0,  "free_shipping": true},
--   {"min_qty": 3, "discount_percent": 10, "free_shipping": true}
-- ]'::jsonb WHERE brand_id = 'xxx';
-- (BrandPromoEngine 讀到舊格式會 fallback 到「所有 tier 共用」邏輯,不會噴錯)
