-- 014_promo_items.sql
-- ============================================================
-- FEATURE:商品「品牌方特價」旗標
--
-- 背景:
--   有些商品是品牌方那邊已經是促銷價,Sean 以特價成本進貨。
--   原本的折扣 pipeline (tier × birthday → bulk → credit) 會
--   一視同仁套到所有商品上,等於把特價商品「再折一次」,吃毛利。
--
-- 政策 (Sean 2026-06-27 確認):
--   特價品 = 完全隔離,不參與站內任何優惠
--     ✗ 不吃等級折 (95-85)
--     ✗ 不吃生日折 (90)
--     ✗ 不吃滿額現折 (-300 / -1000 / -2500)
--     ✗ 不計入滿額門檻判定 (例 5000 / 10000 / 19000)
--     ✗ 不能用註冊禮金折抵
--     ✓ 樓地板只看正常品部分,特價品按品牌方標的價成交
--
-- 實現:加旗標 + discount-engine 拆 regular_items vs promo_items 雙軌計算。
-- ============================================================

BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_promo   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS promo_note text;

COMMENT ON COLUMN products.is_promo IS
  'Phase 2.2 — 品牌方特價商品旗標。true 時不參與站內 tier/birthday/bulk/credit 折扣,不計入 bulk 門檻,樓地板只看 regular items。';

COMMENT ON COLUMN products.promo_note IS
  '特價說明 (顯示在前台徽章下方),例:「品牌方季末促銷」「節慶限定」';

-- order_items 也加 is_promo 副本,做歷史紀錄
-- (避免日後產品改回 is_promo=false 時,過去訂單看不到當時的狀態)
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS is_promo boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN order_items.is_promo IS
  '下單當下該 line item 是否為品牌方特價,從 products.is_promo 複製。歷史紀錄用,不可變。';

-- 統計快查 view (Sean 之後想看「目前共有幾件特價品」「特價品總銷售」)
CREATE OR REPLACE VIEW v_promo_stats AS
SELECT
  (SELECT COUNT(*) FROM products WHERE is_promo = true AND is_active = true AND sold_out = false) AS active_promo_count,
  (SELECT COUNT(*) FROM products WHERE is_promo = true) AS total_promo_count,
  (SELECT COALESCE(SUM(quantity), 0) FROM order_items WHERE is_promo = true) AS promo_units_sold,
  (SELECT COALESCE(SUM(unit_price * quantity), 0) FROM order_items WHERE is_promo = true) AS promo_revenue;

COMMENT ON VIEW v_promo_stats IS '特價商品統計 — Sean 可在 Supabase Studio 直接 SELECT * FROM v_promo_stats; 查看';

COMMIT;

-- ── 驗證(Sean 可在 Supabase Studio 跑) ────────────────────
-- SELECT column_name, data_type, column_default
--   FROM information_schema.columns
--  WHERE table_name = 'products' AND column_name IN ('is_promo', 'promo_note');
-- SELECT * FROM v_promo_stats;
-- ─────────────────────────────────────────────────────────
