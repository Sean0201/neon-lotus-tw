-- 010_protect_trigger_bypass_v2.sql
-- 008 的 bypass 只認 JWT role = service_role,但 Supabase SQL editor 用 postgres
-- role 跑時 request.jwt.claims 是 NULL,bypass 不起作用,所有 admin UPDATE 都被
-- 默默 revert 了。
--
-- 這份 migration 把 bypass 條件擴大,讓:
--   1. JWT role = service_role / supabase_admin → bypass
--   2. current_user = postgres / supabase_admin / service_role → bypass (SQL editor)
--   3. session 有設 app.bypass_member_protection = 'on' → bypass (備用)
--
-- 一般使用者 (authenticated / anon) 仍然不能改保護欄位。

CREATE OR REPLACE FUNCTION _protect_sensitive_member_fields()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_role         text;
  v_session_flag text;
BEGIN
  -- 1. JWT role (PostgREST 注入)
  BEGIN
    v_role := current_setting('request.jwt.claims', true)::jsonb->>'role';
  EXCEPTION WHEN OTHERS THEN
    v_role := NULL;
  END;
  IF v_role IN ('service_role', 'supabase_admin') THEN
    RETURN NEW;
  END IF;

  -- 2. current_user (SQL editor / migration / RPC SECURITY DEFINER)
  IF current_user IN ('postgres', 'supabase_admin', 'service_role') THEN
    RETURN NEW;
  END IF;

  -- 3. 備用 session flag — 任何 client 可在執行前 SET LOCAL app.bypass_member_protection = 'on'
  BEGIN
    v_session_flag := current_setting('app.bypass_member_protection', true);
  EXCEPTION WHEN OTHERS THEN
    v_session_flag := NULL;
  END;
  IF v_session_flag = 'on' THEN
    RETURN NEW;
  END IF;

  -- 一般使用者:保持原本的保護
  NEW.accumulated_spend       := OLD.accumulated_spend;
  NEW.purchase_count          := OLD.purchase_count;
  NEW.tier                    := OLD.tier;
  NEW.founding_credit_balance := OLD.founding_credit_balance;
  NEW.birthday_used_year      := OLD.birthday_used_year;

  RETURN NEW;
END;
$$;
