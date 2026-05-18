-- ──────────────────────────────────────────────────────
-- Phase 2.1a — Auth user → Members 自動 provisioning
--
-- 當 Supabase Auth 有人註冊 (auth.users insert) 時,自動建立對應
-- 的 public.members 列,並判斷是否在「創始會員期」內。
--
-- ⚠️ 跑這份前請確認:
--   - 002_members.sql 已執行完畢
--   - 創始期日期 (見下方常數) 已調整成你要的範圍
-- ──────────────────────────────────────────────────────

-- ============================================================
-- 1. 站點設定表 — 創始期日期等可調參數
-- ============================================================
create table if not exists site_config (
  key   text primary key,
  value text not null,
  description text,
  updated_at timestamptz not null default now()
);

-- 預設值:創始期 2026-05-25 ~ 2026-07-24 (60 天)
-- 若要改:update site_config set value='2026-XX-XX' where key='founding_period_start';
insert into site_config (key, value, description) values
  ('founding_period_start', '2026-05-25', '創始會員開放期起始日'),
  ('founding_period_end',   '2026-07-24', '創始會員開放期結束日'),
  ('founding_credit_amount','500',        '創始會員贈送折抵金 (TWD)'),
  ('founding_initial_tier', 'silver',     '創始會員直升等級')
on conflict (key) do nothing;

-- ============================================================
-- 2. handle_new_user() — auth.users insert 後自動執行
-- ============================================================
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_founding_start  date;
  v_founding_end    date;
  v_credit_amount   integer;
  v_initial_tier    text;
  v_is_founding     boolean;
  v_display_name    text;
begin
  -- 撈設定
  select value::date    into v_founding_start  from site_config where key = 'founding_period_start';
  select value::date    into v_founding_end    from site_config where key = 'founding_period_end';
  select value::integer into v_credit_amount   from site_config where key = 'founding_credit_amount';
  select value          into v_initial_tier    from site_config where key = 'founding_initial_tier';

  -- 判斷是否在創始期
  v_is_founding := (current_date >= v_founding_start and current_date <= v_founding_end);

  -- 從 raw_user_meta_data 取 display_name (Google/Facebook 給 'full_name' 或 'name')
  v_display_name := coalesce(
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'name',
    new.raw_user_meta_data ->> 'display_name',
    split_part(new.email, '@', 1)
  );

  insert into public.members (
    user_id,
    email,
    display_name,
    founding_member,
    founding_credit_balance,
    tier
  ) values (
    new.id,
    new.email,
    v_display_name,
    v_is_founding,
    case when v_is_founding then v_credit_amount else 0 end,
    case when v_is_founding then v_initial_tier  else 'bronze' end
  )
  on conflict (user_id) do nothing;

  -- 若是創始會員,寫一筆 audit log
  if v_is_founding then
    insert into public.member_audit_log (
      member_id, delta, field, reason, operator_email
    )
    select
      m.id,
      v_credit_amount,
      'founding_credit_balance',
      '創始會員贈送折抵金',
      'system'
    from public.members m
    where m.user_id = new.id;
  end if;

  return new;
end;
$$;

-- ============================================================
-- 3. trigger on auth.users
-- ============================================================
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function handle_new_user();


-- ============================================================
-- 4. site_config 的 RLS — 客人可讀 (給前端拿日期),不可寫
-- ============================================================
alter table site_config enable row level security;

drop policy if exists "site_config_select_all" on site_config;
create policy "site_config_select_all"
on site_config for select
using (true);  -- 公開可讀 (這些是非敏感設定)


-- ============================================================
-- 5. 驗證查詢 — 跑完後手動執行確認
-- ============================================================
-- ✅ 應該回 4 列設定
-- select * from site_config order by key;

-- ✅ 應該看到 'on_auth_user_created' trigger 存在
-- select tgname, tgrelid::regclass from pg_trigger where tgname = 'on_auth_user_created';

-- ⚠️ 真正測試方法:在 Supabase Authentication → Users → Invite 一個測試 email,
--    然後 select * from members; 應該看到對應的列。
