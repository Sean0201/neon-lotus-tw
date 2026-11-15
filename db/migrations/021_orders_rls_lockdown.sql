-- ═══════════════════════════════════════════════════════════════
-- 021_orders_rls_lockdown.sql — 封住訂單個資外洩
-- ───────────────────────────────────────────────────────────────
-- 問題:anon(網頁公開金鑰)可以 SELECT 全部 orders / order_items,
--       含客人姓名、Email、電話、地址。017 的修正從未套用,且會擋掉訪客結帳。
--
-- 修正後權限:
--   訪客 (anon)        只能「新增」自己的 pending 訂單與品項,完全不能讀、改、刪
--   會員 (authenticated) 新增訂單(member_id 只能是自己或空)、讀自己的訂單
--   管理員              is_admin_user() 白名單 Email,完整權限(後台)
--   後端 API            service_role,不受 RLS 限制(藍新通知、會員查詢…)
--
-- 前置:前台 cart.js 已改成「前端產生訂單 id、insert 後不讀回」(cart.js?v=23),
--       必須先部署前台,再執行本檔。
--
-- 執行:Supabase → SQL Editor → 貼上整份 → Run。可重複執行。
-- ═══════════════════════════════════════════════════════════════

begin;

alter table public.orders      enable row level security;
alter table public.order_items enable row level security;

-- 1. 移除這兩張表現有的所有 policy(包含不明來源、允許 anon 讀取的那條)
do $$
declare r record;
begin
  for r in
    select policyname, tablename from pg_policies
    where schemaname = 'public' and tablename in ('orders', 'order_items')
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- 2. 管理員判斷(Email 需與 admin.html 的 ADMIN_EMAILS 一致)
create or replace function public.is_admin_user()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) = any(array[
    'nhkbee184@gmail.com'
  ]);
$$;

-- 3. 品項只能加到「30 分鐘內建立、仍 pending」的訂單
--    (security definer:訪客看不到 orders,需由函式代查)
create or replace function public.order_accepts_items(p_order_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from orders
    where id = p_order_id
      and status = 'pending'
      and created_at > now() - interval '30 minutes'
  );
$$;

-- 4. orders
create policy orders_insert_guest on public.orders
  for insert to anon
  with check (member_id is null and status = 'pending');

create policy orders_insert_member on public.orders
  for insert to authenticated
  with check (
    status = 'pending'
    and (member_id is null
         or member_id in (select id from members where user_id = auth.uid()))
  );

create policy orders_select_own on public.orders
  for select to authenticated
  using (member_id in (select id from members where user_id = auth.uid()));

create policy orders_admin_all on public.orders
  for all to authenticated
  using (public.is_admin_user())
  with check (public.is_admin_user());

-- 5. order_items
create policy order_items_insert on public.order_items
  for insert to anon, authenticated
  with check (public.order_accepts_items(order_id));

create policy order_items_select_own on public.order_items
  for select to authenticated
  using (order_id in (
    select id from orders
    where member_id in (select id from members where user_id = auth.uid())
  ));

create policy order_items_admin_all on public.order_items
  for all to authenticated
  using (public.is_admin_user())
  with check (public.is_admin_user());

commit;

-- 驗證(執行後應只看到上面 7 條):
-- select tablename, policyname, roles, cmd from pg_policies
-- where schemaname = 'public' and tablename in ('orders','order_items') order by 1, 2;
