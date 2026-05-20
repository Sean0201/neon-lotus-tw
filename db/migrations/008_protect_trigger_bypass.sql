-- 008_protect_trigger_bypass.sql
-- 讓 _protect_sensitive_member_fields 對 service_role / supabase_admin 放行
--
-- 背景: 原本的 trigger 把 accumulated_spend / purchase_count / tier /
-- founding_credit_balance / birthday_used_year 在所有 UPDATE 時無條件 revert
-- 回 OLD 值。這讓 newebpay-notify (用 service_role) 也寫不進去,造成付款後
-- 累積消費 / 折抵金沒更新。
--
-- 修法: trigger 看 PostgREST 注入的 JWT role claim,若是 service_role 就放行,
-- 一般 authenticated/anon 使用者仍然不能改這些保護欄位。
--
-- 這份 migration 是 idempotent — CREATE OR REPLACE,可重複跑。

CREATE OR REPLACE FUNCTION _protect_sensitive_member_fields()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_role text;
BEGIN
  BEGIN
    v_role := current_setting('request.jwt.claims', true)::jsonb->>'role';
  EXCEPTION WHEN OTHERS THEN
    v_role := NULL;
  END;

  -- service_role / supabase_admin / postgres 直接放行
  IF v_role IN ('service_role', 'supabase_admin') THEN
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
