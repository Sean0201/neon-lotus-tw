-- 012_apply_order_refund_rpc.sql
-- 後台退款 RPC (帳本端 only,不串金流)
--
-- 設計:
--   1. orders 加四個退款欄位:refund_amount / refunded_at / refund_note / refund_operator
--   2. orders.status 多兩個合法值:refunded (全退) / partial_refunded (部分退)
--   3. RPC apply_order_refund 一次性處理:
--      - 訂單 refund_amount 累加,status 轉換
--      - members.accumulated_spend 扣回退款金額(下限 0)
--      - 全退時 purchase_count -1, 還原 birthday_used_year
--      - signup_credit 按比例退回 founding_credit_balance
--      - tier 用新 accumulated_spend 重算(可能降等)
--      - 寫 member_audit_log
--
-- 金流退款本動作不處理 — admin 須在 NewebPay 後台手動退實際金額。
-- 本 RPC 只更新帳本與會員狀態。

-- ── 1. 加退款欄位 (冪等) ──
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS refund_amount   numeric DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS refunded_at     timestamptz,
  ADD COLUMN IF NOT EXISTS refund_note     text,
  ADD COLUMN IF NOT EXISTS refund_operator text;

-- ── 2. RPC ──
CREATE OR REPLACE FUNCTION apply_order_refund(
  p_order_id        uuid,
  p_refund_amount   numeric,
  p_full_refund     boolean DEFAULT false,
  p_note            text DEFAULT NULL,
  p_operator_email  text DEFAULT 'admin'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order             orders%ROWTYPE;
  v_member            members%ROWTYPE;
  v_already_refunded  numeric;
  v_remaining         numeric;
  v_credit_refund     numeric;
  v_new_spend         numeric;
  v_new_count         int;
  v_new_tier          text;
  v_old_tier          text;
  v_tier_changed      boolean;
  v_new_status        text;
  v_silver_threshold  numeric;
  v_gold_threshold    numeric;
  v_diamond_threshold numeric;
  v_black_threshold   numeric;
  v_restore_birthday  boolean := false;
  v_order_year        int;
BEGIN
  -- 1. 撈訂單
  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found: %', p_order_id USING ERRCODE = 'P0002';
  END IF;

  -- 2. 驗證 status (只允許 paid / partial_refunded 進入退款)
  IF v_order.status NOT IN ('paid', '已付款', 'partial_refunded') THEN
    RAISE EXCEPTION 'order status not refundable: % (only paid / partial_refunded allowed)', v_order.status
      USING ERRCODE = '22023';
  END IF;

  -- 3. 驗證金額
  IF p_refund_amount IS NULL OR p_refund_amount <= 0 THEN
    RAISE EXCEPTION 'refund_amount must be > 0, got %', p_refund_amount USING ERRCODE = '22023';
  END IF;

  v_already_refunded := COALESCE(v_order.refund_amount, 0);
  v_remaining        := COALESCE(v_order.total, 0) - v_already_refunded;

  IF p_refund_amount > v_remaining THEN
    RAISE EXCEPTION 'refund_amount % exceeds remaining refundable %', p_refund_amount, v_remaining
      USING ERRCODE = '22023';
  END IF;

  -- 4. 撈會員(如果有)
  IF v_order.member_id IS NOT NULL THEN
    SELECT * INTO v_member FROM members WHERE id = v_order.member_id;
  END IF;

  -- 5. 計算 credit 退回(按比例,但全退時直接 = 原扣的 signup_credit_used)
  IF p_full_refund OR (v_already_refunded + p_refund_amount) >= COALESCE(v_order.total, 0) THEN
    v_credit_refund := COALESCE(v_order.signup_credit_used, 0) -
                       (CASE WHEN v_already_refunded > 0
                             THEN ROUND(COALESCE(v_order.signup_credit_used, 0) * (v_already_refunded / NULLIF(v_order.total, 0)))
                             ELSE 0 END);
    v_new_status := 'refunded';
    v_restore_birthday := (COALESCE(v_order.birthday_discount, 0) > 0);
  ELSE
    v_credit_refund := ROUND(COALESCE(v_order.signup_credit_used, 0) * (p_refund_amount / NULLIF(v_order.total, 0)));
    v_new_status := 'partial_refunded';
  END IF;

  IF v_credit_refund < 0 THEN v_credit_refund := 0; END IF;

  -- 6. 算新會員狀態(若有 member)
  IF v_member.id IS NOT NULL THEN
    v_new_spend := GREATEST(0, COALESCE(v_member.accumulated_spend, 0) - p_refund_amount);
    -- 全退才 -1 purchase_count
    IF v_new_status = 'refunded' THEN
      v_new_count := GREATEST(0, COALESCE(v_member.purchase_count, 0) - 1);
    ELSE
      v_new_count := COALESCE(v_member.purchase_count, 0);
    END IF;

    v_old_tier := COALESCE(v_member.tier, 'bronze');

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
  END IF;

  -- 7. 更新 orders
  UPDATE orders
  SET refund_amount   = v_already_refunded + p_refund_amount,
      refunded_at     = NOW(),
      refund_note     = COALESCE(refund_note || E'\n', '') ||
                        to_char(NOW() AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD HH24:MI') ||
                        ' [' || p_operator_email || '] ' ||
                        'NT$ ' || p_refund_amount::text ||
                        COALESCE(' — ' || p_note, ''),
      refund_operator = p_operator_email,
      status          = v_new_status,
      updated_at      = NOW()
  WHERE id = p_order_id;

  -- 8. 更新 members + audit log
  IF v_member.id IS NOT NULL THEN
    UPDATE members
    SET accumulated_spend       = v_new_spend,
        purchase_count          = v_new_count,
        tier                    = v_new_tier,
        founding_credit_balance = COALESCE(founding_credit_balance, 0) + v_credit_refund,
        birthday_used_year      = CASE
                                    WHEN v_restore_birthday
                                      AND birthday_used_year = EXTRACT(YEAR FROM v_order.created_at)::int
                                    THEN NULL
                                    ELSE birthday_used_year
                                  END
    WHERE id = v_member.id;

    -- audit log: 累積消費扣回
    INSERT INTO member_audit_log (member_id, delta, field, reason, ref_order_number, operator_email)
    VALUES (v_member.id, -p_refund_amount, 'accumulated_spend',
            COALESCE(p_note, '訂單退款'), v_order.order_number, p_operator_email);

    -- 全退才寫 purchase_count -1
    IF v_new_status = 'refunded' AND v_new_count <> COALESCE(v_member.purchase_count, 0) THEN
      INSERT INTO member_audit_log (member_id, delta, field, reason, ref_order_number, operator_email)
      VALUES (v_member.id, -1, 'purchase_count',
              COALESCE(p_note, '訂單全退'), v_order.order_number, p_operator_email);
    END IF;

    -- credit 退回
    IF v_credit_refund > 0 THEN
      INSERT INTO member_audit_log (member_id, delta, field, reason, ref_order_number, operator_email)
      VALUES (v_member.id, v_credit_refund, 'founding_credit_balance',
              '退款退回註冊金 (' || COALESCE(p_note, '訂單退款') || ')',
              v_order.order_number, p_operator_email);
    END IF;

    -- tier 變動
    IF v_tier_changed THEN
      INSERT INTO member_audit_log (member_id, delta, field, reason, ref_order_number, operator_email)
      VALUES (v_member.id, 0, 'tier',
              format('退款後降等 %s -> %s (累積消費 %s)', v_old_tier, v_new_tier, v_new_spend),
              v_order.order_number, p_operator_email);
    END IF;

    -- 生日還原
    IF v_restore_birthday THEN
      INSERT INTO member_audit_log (member_id, delta, field, reason, ref_order_number, operator_email)
      VALUES (v_member.id, 0, 'birthday_used_year',
              '訂單全退,還原生日優惠額度',
              v_order.order_number, p_operator_email);
    END IF;
  END IF;

  -- 9. 回傳
  RETURN jsonb_build_object(
    'ok',               true,
    'order_id',         p_order_id,
    'order_number',     v_order.order_number,
    'refund_amount',    p_refund_amount,
    'total_refunded',   v_already_refunded + p_refund_amount,
    'order_total',      v_order.total,
    'new_status',       v_new_status,
    'credit_refunded',  v_credit_refund,
    'member_id',        v_member.id,
    'old_spend',        COALESCE(v_member.accumulated_spend, 0),
    'new_spend',        COALESCE(v_new_spend, 0),
    'old_count',        COALESCE(v_member.purchase_count, 0),
    'new_count',        COALESCE(v_new_count, 0),
    'old_tier',         v_old_tier,
    'new_tier',         v_new_tier,
    'tier_changed',     COALESCE(v_tier_changed, false),
    'birthday_restored', v_restore_birthday
  );
END;
$$;

REVOKE ALL ON FUNCTION apply_order_refund(uuid, numeric, boolean, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_order_refund(uuid, numeric, boolean, text, text) TO service_role;
