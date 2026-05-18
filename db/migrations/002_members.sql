-- ──────────────────────────────────────────────────────
-- Phase 2.0 — Members & Audit Log Schema
-- NEON LOTUS TW
--
-- 執行方式:
--   1. Supabase Dashboard → SQL Editor → New Query
--   2. 整段貼上,按 RUN
--   3. 確認最下方 ✅ 驗證查詢都回傳預期結果
--
-- 此 migration 是冪等的 (idempotent):重複跑不會出錯。
-- ──────────────────────────────────────────────────────

-- ============================================================
-- 1. members 表 — 每個註冊客人一列,累積消費跟著這列走
-- ============================================================
create table if not exists members (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid references auth.users(id) on delete cascade unique,
  email                    text unique not null,
  display_name             text,
  phone                    text,
  birthday                 date,                                      -- 生日 (年月日)
  accumulated_spend        integer not null default 0,                -- 累積消費 TWD,折扣前商品小計
  tier                     text    not null default 'bronze'
                                  check (tier in ('bronze','silver','gold','diamond')),
  founding_member          boolean not null default false,            -- 創始會員旗標
  founding_credit_balance  integer not null default 0,                -- 創始會員 NT$500 剩餘額
  birthday_used_year       integer,                                   -- 今年生日折扣是否用過 (西元年)
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists idx_members_user_id on members(user_id);
create index if not exists idx_members_email   on members(email);
create index if not exists idx_members_tier    on members(tier);

-- updated_at 自動 bump
create or replace function _set_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_members_updated_at on members;
create trigger trg_members_updated_at
before update on members
for each row execute function _set_updated_at();


-- ============================================================
-- 2. member_audit_log — 累積金額/等級/折抵金所有變動的紀錄
-- ============================================================
create table if not exists member_audit_log (
  id                uuid primary key default gen_random_uuid(),
  member_id         uuid not null references members(id) on delete cascade,
  delta             integer not null,                       -- 加減金額 (可負); 對應 accumulated_spend 或 credit
  field             text not null default 'accumulated_spend'
                          check (field in ('accumulated_spend','founding_credit_balance','tier')),
  reason            text not null,                          -- '老客戶遷移' / '訂單' / '訂單退貨' / 'admin 手動調整' / '創始折抵金使用'
  ref_order_number  text,                                   -- 關聯訂單號 (若有)
  operator_email    text,                                   -- 操作者 (admin 或 system)
  created_at        timestamptz not null default now()
);

create index if not exists idx_audit_member_id  on member_audit_log(member_id);
create index if not exists idx_audit_created_at on member_audit_log(created_at desc);


-- ============================================================
-- 3. orders 表加欄 — 訂單可選綁定會員(訪客結帳保留 NULL)
-- ============================================================
alter table orders add column if not exists member_id              uuid references members(id);
alter table orders add column if not exists tier_at_purchase       text;    -- 下單當下會員等級(歷史快照)
alter table orders add column if not exists tier_discount          integer not null default 0;  -- 等級折扣金額
alter table orders add column if not exists birthday_discount      integer not null default 0;  -- 生日月折扣金額
alter table orders add column if not exists founding_credit_used   integer not null default 0;  -- 使用的創始折抵金

create index if not exists idx_orders_member_id on orders(member_id);


-- ============================================================
-- 4. Row Level Security (RLS) Policies
-- ============================================================
alter table members           enable row level security;
alter table member_audit_log  enable row level security;

-- ── members: 客人能讀自己、insert 自己、改非敏感欄位 ──

drop policy if exists "members_select_own" on members;
create policy "members_select_own"
on members for select
using (auth.uid() = user_id);

drop policy if exists "members_insert_self" on members;
create policy "members_insert_self"
on members for insert
with check (auth.uid() = user_id);

drop policy if exists "members_update_own" on members;
create policy "members_update_own"
on members for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- ── 防止客人改敏感欄位 (tier, accumulated_spend, founding_*) ──
--    一般使用者 (authenticated) update 時,trigger 會把敏感欄位還原成 old。
--    service_role (server-side admin) 不受限制。
create or replace function _protect_sensitive_member_fields()
returns trigger as $$
declare
  caller_role text;
begin
  -- auth.role() 在 service_role 連線時回 'service_role',
  -- 一般登入客人是 'authenticated',匿名是 'anon'
  caller_role := coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '');

  if caller_role <> 'service_role' then
    new.accumulated_spend       := old.accumulated_spend;
    new.tier                    := old.tier;
    new.founding_member         := old.founding_member;
    new.founding_credit_balance := old.founding_credit_balance;
    new.birthday_used_year      := old.birthday_used_year;
  end if;

  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_protect_member_fields on members;
create trigger trg_protect_member_fields
before update on members
for each row execute function _protect_sensitive_member_fields();


-- ── member_audit_log: 客人能讀自己的歷史,完全不能寫 ──
--   寫入只允許 service_role (透過後端 API 操作)

drop policy if exists "audit_select_own" on member_audit_log;
create policy "audit_select_own"
on member_audit_log for select
using (
  member_id in (select id from members where user_id = auth.uid())
);

-- ⚠️ 不建立 insert / update / delete policy → 預設拒絕,只有 service_role 能寫


-- ============================================================
-- 5. 驗證查詢 — 跑完後手動執行確認
-- ============================================================
-- ✅ 應該看到 'members' 與 'member_audit_log' 兩列
-- select tablename from pg_tables where schemaname = 'public' and tablename in ('members','member_audit_log');

-- ✅ 應該看到 4 個新欄位 (member_id, tier_at_purchase, tier_discount, birthday_discount, founding_credit_used)
-- select column_name from information_schema.columns
--   where table_name = 'orders' and column_name in
--   ('member_id','tier_at_purchase','tier_discount','birthday_discount','founding_credit_used');

-- ✅ 應該看到 2 列 (members + member_audit_log 都啟用 RLS)
-- select relname, relrowsecurity from pg_class where relname in ('members','member_audit_log');
