-- ──────────────────────────────────────────────────────
-- Migration 018 — products 表新增尺寸表欄位
-- NEON LOTUS TW
--
-- 目的:讓 admin 後台能存放商品尺寸表 (圖 + 文字表格)
--
-- 新增欄位:
--   size_chart_image  text        — 尺寸表圖片 URL (Supabase Storage)
--   size_chart_table  jsonb       — 尺寸表文字資料,固定欄位
--                                    結構:[{"size":"S","chest":88,"length":65,
--                                            "shoulder":42,"sleeve":20}, ...]
--                                    數值單位:公分
--
-- 執行方式:
--   Supabase Dashboard → SQL Editor → 整段貼上 → RUN
-- 冪等 (可重複跑)。
-- ──────────────────────────────────────────────────────

alter table products
  add column if not exists size_chart_image text;

alter table products
  add column if not exists size_chart_table jsonb;

comment on column products.size_chart_image
  is '尺寸表圖片 URL (Supabase Storage product-images bucket)';

comment on column products.size_chart_table
  is '尺寸表文字資料,JSONB array,結構 [{size,chest,length,shoulder,sleeve}, ...],單位公分';

-- ============================================================
-- 驗證查詢 — 跑完應該看到兩個新欄位
-- ============================================================
-- select column_name, data_type from information_schema.columns
--   where table_name = 'products'
--     and column_name in ('size_chart_image','size_chart_table');
