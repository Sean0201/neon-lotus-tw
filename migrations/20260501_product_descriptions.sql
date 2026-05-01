-- ============================================================================
-- NEON LOTUS TW — 商品多語描述欄位
-- File:    migrations/20260501_product_descriptions.sql
-- Date:    2026-05-01
-- Purpose: 在 products 表新增中英泰三語描述欄位,跟 brands 表一致。
--          品牌(brands)早就有 description_en/th/zh 三欄,
--          這次補上 products 同樣三欄。
-- ============================================================================

alter table public.products
  add column if not exists description_zh text,
  add column if not exists description_en text,
  add column if not exists description_th text;

-- 為了讓 admin 看得到欄位、前端能讀到內容,RLS policy 已經是 select * 不用動。
-- 確認:
select 'products multilingual description columns added ✓' as status;
