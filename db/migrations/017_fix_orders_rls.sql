-- ──────────────────────────────────────────────────────
-- Migration 017 — 修補 orders / order_items RLS 資安漏洞
-- NEON LOTUS TW
--
-- 背景:
--   舊 policy:
--     * "Anyone can read orders/order items" (anon SELECT, using=true)
--       → 任何拿到 anon key 的人都能 SELECT 全部訂單 (PII 外洩)
--     * "Admin full access orders/order_items" ({authenticated}, using=true)
--       → 任何登入會員 (不只 admin) 都能 UPDATE/DELETE 任何訂單
--
-- 新 policy 設計:
--   1. anon INSERT — 保留 (訪客結帳需要)
--   2. authenticated INSERT — 新增 (登入會員結帳,限 member_id NULL 或自己的)
--   3. authenticated SELECT — 新增 (只能讀自己的訂單)
--   4. admin (email 白名單) 全權限 — 新增
--   5. service_role 不受 RLS 限制 (server-side API 照舊運作)
--
-- 執行方式:
--   Supabase Dashboard → SQL Editor → 整段貼上 → RUN
--
-- 冪等 (可重複跑)。
-- ──────────────────────────────────────────────────────

-- ============================================================
-- 1. 移除舊的危險 policy
-- ============================================================

-- orders
DROP POLICY IF EXISTS "Anyone can read orders" ON orders;
DROP POLICY IF EXISTS "Admin full access orders" ON orders;

-- order_items
DROP POLICY IF EXISTS "Anyone can read order items" ON order_items;
DROP POLICY IF EXISTS "Admin full access order_items" ON order_items;

-- 注意:保留 "Anyone can create orders" 和 "Anyone can create order items"
--       這兩個是訪客結帳需要的 (anon INSERT)


-- ============================================================
-- 2. 定義 admin 白名單 helper function
-- ============================================================
-- 未來要加/減 admin 只要改這個 function 一個地方即可,不用改 policy

CREATE OR REPLACE FUNCTION is_admin_user()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT lower(coalesce(auth.jwt() ->> 'email', '')) = ANY(ARRAY[
    'nhkbee184@gmail.com'
    -- 要加更多 admin 就加在這裡,例如:
    -- , 'teammate@example.com'
  ]);
$$;


-- ============================================================
-- 3. orders 新 policy
-- ============================================================

-- SELECT:登入會員只能讀自己的訂單
DROP POLICY IF EXISTS "orders_select_own" ON orders;
CREATE POLICY "orders_select_own"
ON orders FOR SELECT
TO authenticated
USING (
  member_id IN (SELECT id FROM members WHERE user_id = auth.uid())
);

-- INSERT:登入會員可以下單,但只能綁自己的 member_id (或訪客身份 NULL)
DROP POLICY IF EXISTS "orders_insert_own" ON orders;
CREATE POLICY "orders_insert_own"
ON orders FOR INSERT
TO authenticated
WITH CHECK (
  member_id IS NULL
  OR member_id IN (SELECT id FROM members WHERE user_id = auth.uid())
);

-- Admin 白名單:全權限
DROP POLICY IF EXISTS "orders_admin_all" ON orders;
CREATE POLICY "orders_admin_all"
ON orders FOR ALL
TO authenticated
USING (is_admin_user())
WITH CHECK (is_admin_user());


-- ============================================================
-- 4. order_items 新 policy
-- ============================================================

-- SELECT:透過 orders 反查,只能讀自己訂單的 items
DROP POLICY IF EXISTS "order_items_select_own" ON order_items;
CREATE POLICY "order_items_select_own"
ON order_items FOR SELECT
TO authenticated
USING (
  order_id IN (
    SELECT id FROM orders
    WHERE member_id IN (SELECT id FROM members WHERE user_id = auth.uid())
  )
);

-- INSERT:登入會員只能插自己訂單的 items
DROP POLICY IF EXISTS "order_items_insert_own" ON order_items;
CREATE POLICY "order_items_insert_own"
ON order_items FOR INSERT
TO authenticated
WITH CHECK (
  order_id IN (
    SELECT id FROM orders
    WHERE member_id IS NULL
       OR member_id IN (SELECT id FROM members WHERE user_id = auth.uid())
  )
);

-- Admin 白名單:全權限
DROP POLICY IF EXISTS "order_items_admin_all" ON order_items;
CREATE POLICY "order_items_admin_all"
ON order_items FOR ALL
TO authenticated
USING (is_admin_user())
WITH CHECK (is_admin_user());


-- ============================================================
-- 5. 驗證查詢
-- ============================================================
-- ✅ 應該看到 orders 有 4 個 policy:
--    Anyone can create orders (anon INSERT)
--    orders_select_own (auth SELECT)
--    orders_insert_own (auth INSERT)
--    orders_admin_all (auth ALL)
--
-- ✅ 應該看到 order_items 有 4 個 policy (對應):
--    Anyone can create order items
--    order_items_select_own
--    order_items_insert_own
--    order_items_admin_all
--
-- 驗證 SQL:
-- SELECT tablename, policyname, cmd, roles, qual, with_check
-- FROM pg_policies
-- WHERE tablename IN ('orders','order_items')
-- ORDER BY tablename, policyname;
