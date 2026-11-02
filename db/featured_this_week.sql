-- ──────────────────────────────────────────────────────
-- 本週精選(首頁衣架)— 2026-11-02
-- NEON LOTUS TW
--
-- 執行方式:Supabase Dashboard → SQL Editor → 整段貼上 → RUN
-- 效果:
--   1. 把目前所有精選設為停用(不刪除,後台還看得到,可再打開)
--   2. 新增下列 3 件,依 sort_order 排在衣架上(左 → 右)
--      同款其他顏色不用列,單品檢視會自動出現色點
-- 可重複執行:會先刪掉這 3 件舊的精選紀錄再新增,不會重複。
-- ──────────────────────────────────────────────────────

begin;

update featured_products set is_active = false where is_active = true;

delete from featured_products where product_id in (
  'hades-hades-bubble-dot-zip-hoodie-light-blue-light-blue',
  'viery-driftwood-rosso-set-black',
  'hades-hades-parade-zip-hoodie-black'
);

insert into featured_products (brand_id, product_id, is_active, sort_order) values
  -- HADES BUBBLE DOT ZIP HOODIE 淺藍(色點:白)NT$2,090
  ('hades', 'hades-hades-bubble-dot-zip-hoodie-light-blue-light-blue', true, 10),
  -- VIERY DRIFTWOOD ROSSO SET 黑(色點:棕 / 灰 / 紅 / 橄欖綠)NT$2,550
  ('viery', 'viery-driftwood-rosso-set-black',                          true, 20),
  -- HADES PARADE ZIP HOODIE 黑
  ('hades', 'hades-hades-parade-zip-hoodie-black',                      true, 30);
  -- 同款不同色只放一件;其他款式之後再加

commit;
