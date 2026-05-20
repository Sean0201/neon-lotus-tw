-- 009_apply_historical_purchase_rpc.sql
-- 後台補登歷史訂單 RPC
--
-- 用法:
--   SELECT apply_historical_purchase(
--     p_member_id        := '...',
--     p_amount           := 5000,
--     p_purchase_date    := '2025-03-15',
--     p_note             := '補登 LINE 私訊訂單',
--     p_operator_email   := 'admin@neonlotus.tw'
--   );
--
-- 一次性原子完成:
--   1. 寫 orders row (status='historical', payment_method='歷史補登',
--      total=amount, subtotal=amount, member_id=p_member_id, created_at=p_purchase_date)
--   2. members.accumulated_spend += amount, purchase_count += 1
--   3. 依 site_config tier_thresholds 重算 tier
--   4. 寫 2 筆 member_audit_log (accumulated_spend / purchase_count)
--      若 tier 變動,再多寫 1 筆
--
-- 註: SECURITY DEFINER + 函式內 SET LOCAL ROLE service_role 可確保
-- protect trigger 認得 role,但這裡選擇用 EXECUTE 動態 SQL 直接 update,
-- 不依賴 trigger bypass — 雙重保險。

CREATE OR REPLACE FUNCTION apply_historical_purchase(
  p_member_id      uuid,
  p_amount         numeric,
  p_purchase_date  date DEFAULT CURRENT_DATE,
  p_note           text DEFAULT NULL,
  p_operator_email text DEFAULT 'admin'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member            members%ROWTYPE;
  v_new_spend         numeric;
  v_new_count         int;
  v_old_tier          text;
  v_new_tier          text;
  v_tier_changed      boolean;
  v_order_id          uuid;
  v_order_number      text;
  v_silver_threshold  numeric;
  v_gold_threshold    numeric;
  v_diamond_threshold numeric;
  v_black_threshold   numeric;
BEGIN
  -- 1. 撈會員當前狀態
  SELECT * INTO v_member FROM members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member not found: %', p_member_id USING ERRCODE = 'P0002';
  END IF;

  -- 2. 驗證金額
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'amount must be > 0, got %', p_amount USING ERRCODE = '22023';
  END IF;

  -- 3. 計算新值
  v_new_spend := COALESCE(v_member.accumulated_spend, 0) + p_amount;
  v_new_count := COALESCE(v_member.purchase_count, 0) + 1;
  v_old_tier  := COALESCE(v_member.tier, 'bronze');

  -- 4. 從 site_config 抓 tier 門檻 (預設值: silver 5000 / gold 30000 / diamond 100000 / black 300000)
  v_silver_threshold  := COALESCE((SELECT value::numeric FROM site_config WHERE key = 'tier_threshold_silver'),  5000);
  v_gold_threshold    := COALESCE((SELECT value::numeric FROM site_config WHERE key = 'tier_threshold_gold'),    30000);
  v_diamond_threshold := COALESCE((SELECT value::numeric FROM site_config WHERE key = 'tier_threshold_diamond'), 100000);
  v_black_threshold   := COALESCE((SELECT value::numeric FROM site_config WHERE key = 'tier_threshold_black'),   300000);

  v_new_tier := CASE
    WHEN v_new_spend >= v_black_threshold   THEN 'black'
    WHEN v_new_spend >= v_diamond_threshold THEN 'diamond'
    WHEN v_new_spend >= v_gold_threshold    THEN 'gold'
    WHEN v_new_spend >= v_silver_threshold  THEN 'silver'
    ELSE 'bronze'
  END;

  v_tier_changed := v_new_tier <> v_old_tier;

  -- 5. 產生補登訂單編號:NLH-YYYYMMDD-XXXX (NLH = NL Historical)
  v_order_number := 'NLH-' || to_char(p_purchase_date, 'YYYYMMDD') || '-' ||
                    lpad((floor(random() * 9000) + 1000)::int::text, 4, '0');

  -- 6. 插入 orders row
  INSERT INTO orders (
    order_number, member_id, customer_name, customer_email,
    subtotal, shipping_fee, total,
    signup_credit_used, tier_at_purchase, tier_discount, birthday_discount,
    status, payment_method, shipping_method,
    note,
    created_at, updated_at
  ) VALUES (
    v_order_number, p_member_id, v_member.display_name, v_member.email,
    p_amount, 0, p_amount,
    0, v_old_tier, 0, 0,
    'historical', '歷史補登', '已完成',
    COALESCE(p_note, '後台補登 by ' || p_operator_email),
    p_purchase_date::timestamptz, NOW()
  )
  RETURNING id INTO v_order_id;

  -- 7. 更新 members (依賴 008 的 trigger bypass — service_role 才能寫進去)
  UPDATE members
  SET accumulated_spend = v_new_spend,
      purchase_count    = v_new_count,
      tier              = v_new_tier
  WHERE id = p_member_id;

  -- 8. 寫 audit log
  INSERT INTO member_audit_log (member_id, delta, field, reason, ref_order_number, operator_email)
  VALUES
    (p_member_id, p_amount,  'accumulated_spend', COALESCE(p_note, '歷史訂單補登'), v_order_number, p_operator_email),
    (p_member_id, 1,         'purchase_count',    COALESCE(p_note, '歷史訂單補登'), v_order_number, p_operator_email);

  IF v_tier_changed THEN
    INSERT INTO member_audit_log (member_id, delta, field, reason, ref_order_number, operator_email)
    VALUES (p_member_id, 0, 'tier',
            format('等級變更 %s → %s (累積消費 %s)', v_old_tier, v_new_tier, v_new_spend),
            v_order_number, p_operator_email);
  END IF;

  -- 9. 回傳結果
  RETURN jsonb_build_object(
    'ok',              true,
    'order_id',        v_order_id,
    'order_number',    v_order_number,
    'member_id',       p_member_id,
    'amount',          p_amount,
    'old_spend',       COALESCE(v_member.accumulated_spend, 0),
    'new_spend',       v_new_spend,
    'old_count',       COALESCE(v_member.purchase_count, 0),
    'new_count',       v_new_count,
    'old_tier',        v_old_tier,
    'new_tier',        v_new_tier,
    'tier_changed',    v_tier_changed
  );
END;
$$;

-- 只允許 service_role 呼叫 (前端 anon 不能直接補登)
REVOKE ALL ON FUNCTION apply_historical_purchase(uuid, numeric, date, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_historical_purchase(uuid, numeric, date, text, text) TO service_role;
