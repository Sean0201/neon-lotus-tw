-- ──────────────────────────────────────────────────────
-- Migration 019 — 蝦皮通路支援 (channel + shopee 商品/訂單欄位)
-- NEON LOTUS TW
--
-- 目的:
--   讓官網 orders/order_items 也能收蝦皮訂單,共用同一張表,
--   月底「成本利潤表」才能兩通路一次合併對帳。
--
-- 新增欄位:
--   orders.channel          text    — 'official' (預設) / 'shopee'
--   orders.channel_order_sn text    — 蝦皮訂單編號 (order_sn),官網訂單為 NULL
--   orders.channel_fee      numeric — 蝦皮平台/金流手續費 (從 escrow 明細回填),官網為 NULL
--
--   products.shopee_enabled boolean — 是否要上架到蝦皮 (先小範圍試跑用)
--   products.shopee_item_id text    — 蝦皮上架後回傳的 item_id,同步更新用
--   products.shopee_markup  numeric — 個別商品加價倍率覆寫,NULL 則用全站預設 (目前 1.08)
--
-- 執行方式:
--   Supabase Dashboard → SQL Editor → 整段貼上 → RUN
-- 冪等 (可重複跑)。
-- ──────────────────────────────────────────────────────

-- ============================================================
-- 1. orders — 通路欄位
-- ============================================================

alter table orders
  add column if not exists channel text not null default 'official';

alter table orders
  add column if not exists channel_order_sn text;

alter table orders
  add column if not exists channel_fee numeric;

comment on column orders.channel
  is '訂單來源通路: official (官網) / shopee (蝦皮)';
comment on column orders.channel_order_sn
  is '蝦皮訂單編號 (order_sn),用來 upsert 避免重複匯入;官網訂單為 NULL';
comment on column orders.channel_fee
  is '蝦皮平台手續費 + 金流手續費 (從 escrow 明細回填 NT$);官網訂單為 NULL,沿用 admin 匯出時手填的「金流手續費」欄';

-- 同一通路的同一筆蝦皮訂單不能重複匯入
create unique index if not exists orders_channel_order_sn_uniq
  on orders (channel, channel_order_sn)
  where channel_order_sn is not null;

create index if not exists orders_channel_idx on orders (channel);

-- ============================================================
-- 2. products — 蝦皮上架欄位
-- ============================================================

alter table products
  add column if not exists shopee_enabled boolean not null default false;

alter table products
  add column if not exists shopee_item_id text;

alter table products
  add column if not exists shopee_markup numeric;

comment on column products.shopee_enabled
  is '是否推送到蝦皮上架 (先小範圍試跑,預設 false)';
comment on column products.shopee_item_id
  is '蝦皮 item_id,上架成功後由 sync script 回填,之後 update 用這個 ID';
comment on column products.shopee_markup
  is '個別商品蝦皮加價倍率覆寫 (例如 1.10);NULL 則用全站預設 1.08';

create index if not exists products_shopee_enabled_idx
  on products (shopee_enabled) where shopee_enabled = true;

-- ============================================================
-- 3. order_items — 標記蝦皮平台商品編號 (方便對帳)
-- ============================================================

alter table order_items
  add column if not exists channel_item_id text;

comment on column order_items.channel_item_id
  is '蝦皮 item_id / model_id,官網品項為 NULL';

-- ============================================================
-- 驗證查詢
-- ============================================================
-- select column_name, data_type from information_schema.columns
--   where table_name = 'orders' and column_name like 'channel%';
-- select column_name, data_type from information_schema.columns
--   where table_name = 'products' and column_name like 'shopee%';
