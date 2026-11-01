-- ──────────────────────────────────────────────────────
-- Migration 020 — products 表新增衣架去背圖欄位
-- NEON LOTUS TW
--
-- 目的:首頁「本週精選」衣架展示 (rack.js) 使用去背商品圖
--
-- 新增欄位:
--   rack_image  text  — 去背商品圖 URL (透明背景 WebP/PNG,寬 560px 左右)
--                       存在 Supabase Storage product-images bucket 的 rack/ 底下
--                       沒有值時,衣架改用原本商品照當吊牌卡片
--
-- 執行方式:
--   Supabase Dashboard → SQL Editor → 整段貼上 → RUN
-- 冪等 (可重複跑)。
-- 前台不跑這支也不會壞:rack.js 讀不到欄位就自動改用商品照。
-- ──────────────────────────────────────────────────────

alter table products
  add column if not exists rack_image text;

comment on column products.rack_image
  is '首頁衣架展示用的去背商品圖 URL (Supabase Storage product-images/rack/)';
