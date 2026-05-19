-- ──────────────────────────────────────────────────────
-- Phase 2.1a-fixup — 重寫 handle_new_user trigger
--
-- 之前:只有「創始期內」註冊的會員拿 NT$500 折抵金
-- 現在:每一位新註冊會員一律拿 NT$100 折抵金,等級從 bronze 起跳
--
-- ⚠️ 必須在 004_signup_credit_and_purchase_count.sql 跑完後才能跑
-- ──────────────────────────────────────────────────────

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_credit_amount integer;
  v_display_name  text;
begin
  -- 從 site_config 撈註冊禮金金額 (預設 100)
  select coalesce(value::integer, 100) into v_credit_amount
  from site_config where key = 'signup_credit_amount';
  if v_credit_amount is null then
    v_credit_amount := 100;
  end if;

  -- 從 OAuth provider 的 raw_user_meta_data 取顯示名稱
  -- Google 給 'full_name' 或 'name';Facebook 給 'name';LINE (Phase 2.1b) 給 'name'
  v_display_name := coalesce(
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'name',
    new.raw_user_meta_data ->> 'display_name',
    split_part(new.email, '@', 1),
    '會員'
  );

  insert into public.members (
    user_id,
    email,
    display_name,
    tier,
    accumulated_spend,
    purchase_count,
    founding_credit_balance
  ) values (
    new.id,
    new.email,
    v_display_name,
    'bronze',
    0,
    0,
    v_credit_amount
  )
  on conflict (user_id) do nothing;

  -- audit log: 每位新會員的註冊禮金都記一筆
  insert into public.member_audit_log (
    member_id, delta, field, reason, operator_email
  )
  select
    m.id,
    v_credit_amount,
    'founding_credit_balance',
    '註冊禮金',
    'system'
  from public.members m
  where m.user_id = new.id;

  return new;
end;
$$;

-- ============================================================
-- 重建 trigger
-- ============================================================
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function handle_new_user();


-- ============================================================
-- 驗證
-- ============================================================
-- ✅ Function 內容應該看不到 'founding_period' / 'v_is_founding' 字串
-- select pg_get_functiondef(oid) from pg_proc where proname = 'handle_new_user';

-- ✅ Trigger 應該存在
-- select tgname from pg_trigger where tgname = 'on_auth_user_created';

-- ⚠️ 實測:Authentication → Users → Invite 一個測試 email,
--    然後 select user_id, email, display_name, tier, accumulated_spend,
--                purchase_count, founding_credit_balance
--    from members where email = '剛邀請的 email';
--    應該看到 tier='bronze', accumulated_spend=0, purchase_count=0,
--    founding_credit_balance=100
