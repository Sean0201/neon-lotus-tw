-- ──────────────────────────────────────────────────────
-- 本週精選(首頁衣架)— 2026-11-01
-- NEON LOTUS TW
--
-- 執行方式:Supabase Dashboard → SQL Editor → 整段貼上 → RUN
-- 效果:
--   1. 把目前所有精選設為停用(不刪除,後台還看得到,可再打開)
--   2. 新增下列 6 件,依 sort_order 排在衣架上(左 → 右)
-- 可重複執行:會先刪掉這 6 件舊的精選紀錄再新增,不會重複。
-- ──────────────────────────────────────────────────────

begin;

update featured_products set is_active = false where is_active = true;

delete from featured_products where product_id in (
  'hades-hades-og-sweater-black-black',
  'dirtycoins-361',
  'bunnyhillconcept-maple-jacket-avocado-green-avocado-green',
  'hades-hades-ete-club-tee-black-black',
  'dirtycoins-191',
  'bunnyhillconcept-melios-mesh-top-black-black'
);

insert into featured_products (brand_id, product_id, is_active, sort_order) values
  -- HADES OG SWEATER(黑 / 灰 2 色)NT$1,390
  ('hades',            'hades-hades-og-sweater-black-black',                         true, 10),
  -- DIRTYCOINS × One Piece Luffy Raglan Hoodie(2 色)NT$1,550
  ('dirtycoins',       'dirtycoins-361',                                             true, 20),
  -- BUNNY HILL MAPLE JACKET(酪梨綠 / 黑 2 色)NT$3,390
  ('bunnyhillconcept', 'bunnyhillconcept-maple-jacket-avocado-green-avocado-green',  true, 30),
  -- HADES ETE CLUB TEE(黑 / 粉 / 白 / 黃 4 色)NT$1,350
  ('hades',            'hades-hades-ete-club-tee-black-black',                       true, 40),
  -- DIRTYCOINS Letters Monogram Knit Sweater(棕 / 粉 / 藍 / 黑 4 色)NT$1,850
  ('dirtycoins',       'dirtycoins-191',                                             true, 50),
  -- BUNNY HILL MELIOS MESH TOP(5 色)NT$1,090
  ('bunnyhillconcept', 'bunnyhillconcept-melios-mesh-top-black-black',               true, 60);

commit;
