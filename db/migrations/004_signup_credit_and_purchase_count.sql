-- ──────────────────────────────────────────────────────
-- Phase 2.1a-fixup — 從「創始期專屬 NT$500」改成「每人都享 NT$100」
-- + 加 purchase_count(消費次數)
-- + 折扣 75% 樓地板設定
--
-- 保留 Phase 2.1a 的等級制度 (bronze/silver/gold/diamond) +
-- accumulated_spend 累積消費,只是去除「創始期限」的概念 — 改成
-- 每一位註冊會員都立刻享有 NT$100 折抵金。
--
-- 此 migration 是冪等的 (idempotent):重複跑不會出錯。
-- ──────────────────────────────────────────────────────

-- ============================================================
-- 1. 先把 trigger drop 掉,允許動 schema
-- ============================================================
drop trigger if exists trg_protect_member_fields on members;

-- ============================================================
-- 2. members 表 — 加 purchase_count,丟掉 founding_member 旗標
-- ============================================================
-- 每個會員從現在起一律享 NT$100 折抵金,不需要 founding_member 區分
alter table members drop column if exists founding_member;

-- 消費次數(server-only,每次付款成功 +1)
alter table members add column if not exists purchase_count integer not null default 0;

-- founding_credit_balance 留著,但語意變成「註冊禮金餘額」。
-- 把預設值改成 100。已存在的舊資料維持原值不動 (舊創始會員仍保有他們的 NT$500)。
alter table members alter column founding_credit_balance set default 100;

-- 加註解,讓 Supabase Dashboard 一看就懂
comment on column members.founding_credit_balance is
  '註冊禮金餘額 TWD (新註冊立刻享 NT$100,舊創始會員可能仍保有 NT$500)';
comment on column members.purchase_count is
  '成功付款訂單次數,server-only,client 不能改';


-- ============================================================
-- 3. site_config — 把創始期相關設定砍掉,加新設定
-- ============================================================
-- 砍掉舊的創始期設定
delete from site_config where key in (
  'founding_period_start',
  'founding_period_end',
  'founding_initial_tier'
);

-- 改名:founding_credit_amount → signup_credit_amount
update site_config set
  value = '100',
  description = '註冊禮金 (TWD) — 每位新會員建立帳號立刻享有'
where key = 'founding_credit_amount';

update site_config set key = 'signup_credit_amount'
where key = 'founding_credit_amount';

-- 萬一上面那筆不存在(乾淨環境),補一筆
insert into site_config (key, value, description) values
  ('signup_credit_amount', '100', '註冊禮金 (TWD) — 每位新會員建立帳號立刻享有')
on conflict (key) do nothing;

-- 生日 9 折 + 折扣樓地板
insert into site_config (key, value, description) values
  ('birthday_discount_rate', '0.9',  '生日月折扣比率 (0.9 = 9 折,一年用一次)'),
  ('discount_floor_rate',    '0.75', '所有折扣疊加後的最低樓地板 (0.75 = 不能低於原價 75%)')
on conflict (key) do nothing;


-- ============================================================
-- 4. orders 表 — founding_credit_used 改名 signup_credit_used
-- ============================================================
-- 重新命名,讓欄位意思跟新 schema 一致
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name='orders' and column_name='founding_credit_used'
  ) and not exists (
    select 1 from information_schema.columns
    where table_name='orders' and column_name='signup_credit_used'
  ) then
    alter table orders rename column founding_credit_used to signup_credit_used;
  end if;
end$$;

-- 若是乾淨環境(沒跑過 002),補上欄位
alter table orders add column if not exists signup_credit_used integer not null default 0;

comment on column orders.signup_credit_used is
  '此訂單抵用的註冊禮金金額 (TWD)';


-- ============================================================
-- 5. 重建敏感欄位保護 trigger
-- ============================================================
-- 現在要保護的欄位:
--   accumulated_spend, tier, founding_credit_balance, birthday_used_year,
--   purchase_count, email
-- 生日「設定後鎖死」:若 old.birthday 已有值,new.birthday 不准被改成別的
create or replace function _protect_sensitive_member_fields()
returns trigger as $$
declare
  caller_role text;
begin
  caller_role := coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '');

  if caller_role <> 'service_role' then
    -- 純伺服器才能改:累積消費 / 等級 / 註冊禮金餘額 / 生日折扣使用 / 消費次數 / email
    new.accumulated_spend       := old.accumulated_spend;
    new.tier                    := old.tier;
    new.founding_credit_balance := old.founding_credit_balance;
    new.birthday_used_year      := old.birthday_used_year;
    new.purchase_count          := old.purchase_count;
    new.email                   := old.email;

    -- 生日:第一次可以填,填了之後就鎖
    if old.birthday is not null then
      new.birthday := old.birthday;
    end if;
  end if;

  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_protect_member_fields on members;
create trigger trg_protect_member_fields
before update on members
for each row execute function _protect_sensitive_member_fields();


-- ============================================================
-- 6. 驗證查詢 — 跑完後手動執行確認
-- ============================================================
-- ✅ members 應該有 purchase_count, 不應該有 founding_member
-- select column_name from information_schema.columns
--   where table_name='members' order by ordinal_position;

-- ✅ site_config 應該看到 signup_credit_amount, birthday_discount_rate, discount_floor_rate
--    不應該有 founding_period_*, founding_credit_amount, founding_initial_tier
-- select key, value from site_config order by key;

-- ✅ orders 應該有 signup_credit_used (不是 founding_credit_used)
-- select column_name from information_schema.columns
--   where table_name='orders' and column_name like '%credit_used%';
