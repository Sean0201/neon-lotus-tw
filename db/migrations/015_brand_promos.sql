-- 015_brand_promos.sql
-- ============================================================
-- FEATURE:品牌活動促銷(階梯折 + 免運)
--
-- 背景:
--   014 的 is_promo 是「品牌方特價」永久性、綁在單品。
--   這支是「品牌方跑活動」時間性、綁在品牌 —— 例如「HADES 品牌週」。
--   活動期間該品牌全品自動套用階梯折(買 N 件 X 折 + 免運)。
--
-- 政策 (Sean 2026-08-05 確認):
--   1. 折扣型式:階梯數量折(quantity tier)+ 免運疊加
--      HADES 首波:1 件免運、2 件 95 折 + 免運、3-4 件 92 折 + 免運、5+ 件 88 折 + 免運
--   2. 「不與其他優惠共同使用」= 全部三種都不共用:
--      ✗ 品牌折壓過 會員等級折
--      ✗ 品牌折壓過 商品 is_promo(品牌活動優先於單品促銷)
--      ✗ 品牌折商品 不計入全站滿額現折的門檻(不能一邊拿品牌折一邊拉高滿額門檻)
--      ✗ 品牌折商品 不能用註冊禮金折抵(統一互斥)
--   3. 「依然能累積會員」= 訂單金額全額計入 accumulated_spend(升等/積分照算)
--
-- 實現:
--   brand_promos 表 + tier_rules JSONB(未來擴充彈性)
--   discount-engine.js 在最前面加一層「品牌促銷 pre-pass」,
--   把該品牌商品當「加強版 is_promo」處理(單價替換為折後價、不參與其他折扣)。
--
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS brand_promos (
  brand_id              TEXT PRIMARY KEY REFERENCES brands(id) ON DELETE CASCADE,
  label                 TEXT NOT NULL,
  -- 階梯規則 JSONB,格式:
  --   [ { "min_qty": 1, "free_shipping": true, "discount_percent": 0 },
  --     { "min_qty": 2, "free_shipping": true, "discount_percent": 5 },
  --     ... ]
  -- 引擎會挑出符合 quantity 的最大 min_qty 那條套用。
  tier_rules            JSONB NOT NULL,
  excludes_other_promos BOOLEAN NOT NULL DEFAULT true,
  counts_toward_member  BOOLEAN NOT NULL DEFAULT true,
  starts_at             TIMESTAMPTZ,
  ends_at               TIMESTAMPTZ,
  is_active             BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  brand_promos                       IS '品牌活動促銷(時間性、綁品牌)。跟 products.is_promo(永久性、綁單品)不同。';
COMMENT ON COLUMN brand_promos.tier_rules            IS 'JSONB 陣列。每條 rule 有 min_qty / discount_percent / free_shipping。引擎挑 min_qty ≤ 該品牌購買件數 的最大條套用。';
COMMENT ON COLUMN brand_promos.excludes_other_promos IS 'true = 該品牌商品不吃 tier/生日/滿額/is_promo/credit(壓過)。false 保留給未來想做「疊加型」品牌折。';
COMMENT ON COLUMN brand_promos.counts_toward_member  IS 'true = 訂單金額計入 accumulated_spend(會員升等/積分照算),即使折扣被套用。';
COMMENT ON COLUMN brand_promos.starts_at             IS '活動開始時間。NULL = 立即生效(以 is_active 為準)。';
COMMENT ON COLUMN brand_promos.ends_at               IS '活動結束時間。NULL = 手動控制(以 is_active 為準)。';
COMMENT ON COLUMN brand_promos.is_active             IS '總開關。false 時忽略此 row。同時檢查 now() 是否在 starts_at ~ ends_at 內(若有設)。';

-- 自動 updated_at
CREATE OR REPLACE FUNCTION touch_brand_promos_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_brand_promos_updated_at ON brand_promos;
CREATE TRIGGER trg_brand_promos_updated_at
  BEFORE UPDATE ON brand_promos
  FOR EACH ROW EXECUTE FUNCTION touch_brand_promos_updated_at();

-- RLS:公開 SELECT,寫入僅 service_role
ALTER TABLE brand_promos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS brand_promos_public_read ON brand_promos;
CREATE POLICY brand_promos_public_read
  ON brand_promos FOR SELECT
  USING (true);

-- (寫入不設 policy → 只有 service_role 能寫,anon 讀不了寫)

-- ── 訂單紀錄:order_items 加個欄位存「當下的品牌折是幾折」
--    保留歷史,避免品牌活動結束後對不回舊訂單的算法
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS brand_promo_label            TEXT,
  ADD COLUMN IF NOT EXISTS brand_promo_discount_percent NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS brand_promo_free_shipping    BOOLEAN;

COMMENT ON COLUMN order_items.brand_promo_label            IS '下單當下該 line item 套用的品牌活動名稱(e.g. "HADES 品牌週")。歷史紀錄,不可變。';
COMMENT ON COLUMN order_items.brand_promo_discount_percent IS '下單當下該 line item 套用的品牌折百分比(e.g. 8 = 92 折)。0/NULL 表沒套。';
COMMENT ON COLUMN order_items.brand_promo_free_shipping    IS '下單當下該 line item 是否觸發品牌活動免運。';

-- ── HADES 首波 seed(is_active=false,先把資料建好,啟動時 flip 開關)──
INSERT INTO brand_promos
  (brand_id, label, tier_rules, excludes_other_promos, counts_toward_member,
   starts_at, ends_at, is_active)
VALUES
  ('hades',
   'HADES 品牌週',
   '[
      {"min_qty": 1, "free_shipping": true, "discount_percent": 0},
      {"min_qty": 2, "free_shipping": true, "discount_percent": 5},
      {"min_qty": 3, "free_shipping": true, "discount_percent": 8},
      {"min_qty": 5, "free_shipping": true, "discount_percent": 12}
    ]'::jsonb,
   true,     -- 壓過其他優惠
   true,     -- 會員累積照算
   NULL,     -- 手動開關,不排期
   NULL,
   false     -- ⚠️ 預設關閉,Sean 準備好再 flip
  )
ON CONFLICT (brand_id) DO NOTHING;

-- 統計 view(參考 014 的 v_promo_stats)
CREATE OR REPLACE VIEW v_brand_promo_stats AS
SELECT
  bp.brand_id,
  bp.label,
  bp.is_active,
  bp.starts_at,
  bp.ends_at,
  (SELECT COUNT(*) FROM products p WHERE p.brand_id = bp.brand_id AND p.is_active = true AND p.sold_out = false) AS active_products,
  (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.brand_promo_label = bp.label) AS lifetime_units_sold_under_this_promo,
  (SELECT COALESCE(SUM(oi.unit_price * oi.quantity), 0) FROM order_items oi WHERE oi.brand_promo_label = bp.label) AS lifetime_revenue_under_this_promo
FROM brand_promos bp
ORDER BY bp.is_active DESC, bp.brand_id;

COMMENT ON VIEW v_brand_promo_stats IS
  '品牌活動概觀。Sean 可在 Supabase Studio 直接 SELECT * FROM v_brand_promo_stats; 查目前活動狀態 + 歷史績效。';

COMMIT;


-- ═══════════════════════════════════════════════════════════════
-- 操作指南 (Sean 用)
-- ═══════════════════════════════════════════════════════════════

-- ── 檢查目前狀態 ──
-- SELECT * FROM v_brand_promo_stats;

-- ── 啟動 HADES 活動 ──
-- UPDATE brand_promos SET is_active = true, starts_at = NOW() WHERE brand_id = 'hades';

-- ── 停止 HADES 活動 ──
-- UPDATE brand_promos SET is_active = false, ends_at = NOW() WHERE brand_id = 'hades';

-- ── 修改階梯規則(不用停活動) ──
-- UPDATE brand_promos SET tier_rules = '[
--   {"min_qty": 1, "free_shipping": true,  "discount_percent": 0},
--   {"min_qty": 2, "free_shipping": true,  "discount_percent": 10},
--   {"min_qty": 4, "free_shipping": true,  "discount_percent": 15}
-- ]'::jsonb WHERE brand_id = 'hades';

-- ── 為其他品牌開活動(拷貝 HADES 模板)──
-- INSERT INTO brand_promos (brand_id, label, tier_rules, is_active) VALUES
-- ('mbi', 'MBI 週年慶', '[
--   {"min_qty": 1, "free_shipping": true, "discount_percent": 0},
--   {"min_qty": 3, "free_shipping": true, "discount_percent": 10}
-- ]'::jsonb, false);
