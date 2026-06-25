-- 013_fix_tier_thresholds_in_rpcs.sql
-- ============================================================
-- BUG FIX:tier 階梯讀錯來源 + 一次性重算所有會員等級
--
-- 問題:
--   migration 009 (apply_historical_purchase) 跟 012 (apply_order_refund)
--   都從 site_config 讀「個別 keys」(tier_threshold_silver / _gold / _diamond
--   / _black) 來算 tier。但 migration 006 把所有門檻塞進「一個」JSON key
--   叫 tier_thresholds,個別 keys 從來沒被建出來,所以 SELECT 永遠
--   找不到,COALESCE 一律退回 RPC 內硬寫的 fallback。
--
--   RPC 寫死的 fallback 還是「舊版且錯誤」的階梯:
--     fallback:     silver 5000 / gold  30000 / diamond 100000 / black 300000
--     真實 (006): silver 5000 / gold  15000 / diamond  30000 / black  60000
--
--   後果:任何透過後台補登或退款重算等級的會員,等級可能算錯。
--   例:nhkbee177 累積 NT$100,150,真值應該是 black (>= 60,000),
--   但 RPC 算成 diamond (因為它的 black 門檻被誤認為 300,000)。
--
-- 修補:
--   1. 建 helper _compute_tier_from_spend(numeric),統一從 tier_thresholds
--      JSON 算 tier。未來若要改階梯,只動 site_config 一個地方,RPC 不用碰。
--   2. CREATE OR REPLACE 兩個 RPC,改用 helper。
--   3. 一次性 UPDATE 所有 members,用真實階梯重算 tier;有變動的寫 audit log。
--
-- 安全性:
--   * 一次性 UPDATE 用 SECURITY DEFINER 函式包起來,透過 010 的 trigger
--     bypass 規則 (current_user = postgres) 順利寫入。
--   * 整段在 transaction 內,失敗會 rollback。
-- ============================================================


-- ============================================================
-- 1. Helper: 從累積消費算 tier
-- ============================================================
CREATE OR REPLACE FUNCTION _compute_tier_from_spend(p_spend numeric)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_thresholds jsonb;
  v_black      numeric;
  v_diamond    numeric;
  v_gold       numeric;
  v_silver     numeric;
BEGIN
  -- 從 site_config 抓 JSON (key = 'tier_thresholds')
  SELECT value::jsonb INTO v_thresholds
    FROM site_config WHERE key = 'tier_thresholds';

  -- fallback:若 site_config 沒設,用 migration 006 的預設值
  IF v_thresholds IS NULL THEN
    v_thresholds := '{"bronze":0,"silver":5000,"gold":15000,"diamond":30000,"black":60000}'::jsonb;
  END IF;

  v_black   := COALESCE((v_thresholds->>'black')::numeric,   60000);
  v_diamond := COALESCE((v_thresholds->>'diamond')::numeric, 30000);
  v_gold    := COALESCE((v_thresholds->>'gold')::numeric,    15000);
  v_silver  := COALESCE((v_thresholds->>'silver')::numeric,  5000);

  RETURN CASE
    WHEN COALESCE(p_spend, 0) >= v_black   THEN 'black'
    WHEN COALESCE(p_spend, 0) >= v_diamond THEN 'diamond'
    WHEN COALESCE(p_spend, 0) >= v_gold    THEN 'gold'
    WHEN COALESCE(p_spend, 0) >= v_silver  THEN 'silver'
    ELSE 'bronze'
  END;
END;
$$;

GRANT EXECUTE ON FUNCTION _compute_tier_from_spend(numeric)
  TO service_role, authenticated, anon;


-- ============================================================
-- 2. CREATE OR REPLACE apply_historical_purchase — 改用 helper
--    (原 009 邏輯保持不變,僅 tier 計算改走 helper)
-- ============================================================
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
  v_member       members%ROWTYPE;
  v_new_spend    numeric;
  v_new_count    int;
  v_old_tier     text;
  v_new_tier     text;
  v_tier_changed boolean;
  v_order_id     uuid;
  v_order_number text;
BEGIN
  SELECT * INTO v_member FROM members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member not found: %', p_member_id USING ERRCODE = 'P0002';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'amount must be > 0, got %', p_amount USING ERRCODE = '22023';
  END IF;

  v_new_spend    := COALESCE(v_member.accumulated_spend, 0) + p_amount;
  v_new_count    := COALESCE(v_member.purchase_count, 0) + 1;
  v_old_tier     := COALESCE(v_member.tier, 'bronze');
  v_new_tier     := _compute_tier_from_spend(v_new_spend);
  v_tier_changed := v_new_tier <> v_old_tier;

  v_order_number := 'NLH-' || to_char(p_purchase_date, 'YYYYMMDD') || '-' ||
                    lpad((floor(random() * 9000) + 1000)::int::text, 4, '0');

  INSERT INTO orders (
    order_number, member_id,
    customer_name, customer_email, customer_phone, customer_address,
    subtotal, shipping_fee, total,
    signup_credit_used, tier_at_purchase, tier_discount, birthday_discount,
    status, payment_method, shipping_method,
    note,
    created_at, updated_at
  ) VALUES (
    v_order_number, p_member_id,
    COALESCE(v_member.display_name, ''), v_member.email, COALESCE(v_member.phone, ''), '',
    p_amount, 0, p_amount,
    0, v_old_tier, 0, 0,
    'historical', '歷史補登', '已完成',
    COALESCE(p_note, '後台補登 by ' || p_operator_email),
    p_purchase_date::timestamptz, NOW()
  )
  RETURNING id INTO v_order_id;

  UPDATE members
  SET accumulated_spend = v_new_spend,
      purchase_count    = v_new_count,
      tier              = v_new_tier
  WHERE id = p_member_id;

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

  RETURN jsonb_build_object(
    'ok',           true,
    'order_id',     v_order_id,
    'order_number', v_order_number,
    'member_id',    p_member_id,
    'amount',       p_amount,
    'old_spend',    COALESCE(v_member.accumulated_spend, 0),
    'new_spend',    v_new_spend,
    'old_count',    COALESCE(v_member.purchase_count, 0),
    'new_count',    v_new_count,
    'old_tier',     v_old_tier,
    'new_tier',     v_new_tier,
    'tier_changed', v_tier_changed
  );
END;
$$;

REVOKE ALL ON FUNCTION apply_historical_purchase(uuid, numeric, date, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_historical_purchase(uuid, numeric, date, text, text) TO service_role;


-- ============================================================
-- 3. CREATE OR REPLACE apply_order_refund — 改用 helper
--    (原 012 邏輯保持不變,僅 tier 計算改走 helper)
-- ============================================================
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
  v_restore_birthday  boolean := false;
BEGIN
  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found: %', p_order_id USING ERRCODE = 'P0002';
  END IF;

  IF v_order.status NOT IN ('paid', '已付款', 'partial_refunded') THEN
    RAISE EXCEPTION 'order status not refundable: % (only paid / partial_refunded allowed)', v_order.status
      USING ERRCODE = '22023';
  END IF;

  IF p_refund_amount IS NULL OR p_refund_amount <= 0 THEN
    RAISE EXCEPTION 'refund_amount must be > 0, got %', p_refund_amount USING ERRCODE = '22023';
  END IF;

  v_already_refunded := COALESCE(v_order.refund_amount, 0);
  v_remaining        := COALESCE(v_order.total, 0) - v_already_refunded;

  IF p_refund_amount > v_remaining THEN
    RAISE EXCEPTION 'refund_amount % exceeds remaining refundable %', p_refund_amount, v_remaining
      USING ERRCODE = '22023';
  END IF;

  IF v_order.member_id IS NOT NULL THEN
    SELECT * INTO v_member FROM members WHERE id = v_order.member_id;
  END IF;

  IF p_full_refund OR (v_already_refunded + p_refund_amount) >= COALESCE(v_order.total, 0) THEN
    v_credit_refund := COALESCE(v_order.signup_credit_used, 0) -
                       (CASE WHEN v_already_refunded > 0
                             THEN ROUND(COALESCE(v_order.signup_credit_used, 0) * (v_already_refunded / NULLIF(v_order.total, 0)))
                             ELSE 0 END);
    v_new_status       := 'refunded';
    v_restore_birthday := (COALESCE(v_order.birthday_discount, 0) > 0);
  ELSE
    v_credit_refund := ROUND(COALESCE(v_order.signup_credit_used, 0) * (p_refund_amount / NULLIF(v_order.total, 0)));
    v_new_status    := 'partial_refunded';
  END IF;

  IF v_credit_refund < 0 THEN v_credit_refund := 0; END IF;

  IF v_member.id IS NOT NULL THEN
    v_new_spend := GREATEST(0, COALESCE(v_member.accumulated_spend, 0) - p_refund_amount);
    IF v_new_status = 'refunded' THEN
      v_new_count := GREATEST(0, COALESCE(v_member.purchase_count, 0) - 1);
    ELSE
      v_new_count := COALESCE(v_member.purchase_count, 0);
    END IF;

    v_old_tier     := COALESCE(v_member.tier, 'bronze');
    v_new_tier     := _compute_tier_from_spend(v_new_spend);
    v_tier_changed := v_new_tier <> v_old_tier;
  END IF;

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

    INSERT INTO member_audit_log (member_id, delta, field, reason, ref_order_number, operator_email)
    VALUES (v_member.id, -p_refund_amount, 'accumulated_spend',
            COALESCE(p_note, '訂單退款'), v_order.order_number, p_operator_email);

    IF v_new_status = 'refunded' AND v_new_count <> COALESCE(v_member.purchase_count, 0) THEN
      INSERT INTO member_audit_log (member_id, delta, field, reason, ref_order_number, operator_email)
      VALUES (v_member.id, -1, 'purchase_count',
              COALESCE(p_note, '訂單全退'), v_order.order_number, p_operator_email);
    END IF;

    IF v_credit_refund > 0 THEN
      INSERT INTO member_audit_log (member_id, delta, field, reason, ref_order_number, operator_email)
      VALUES (v_member.id, v_credit_refund, 'founding_credit_balance',
              '退款退回註冊金 (' || COALESCE(p_note, '訂單退款') || ')',
              v_order.order_number, p_operator_email);
    END IF;

    IF v_tier_changed THEN
      INSERT INTO member_audit_log (member_id, delta, field, reason, ref_order_number, operator_email)
      VALUES (v_member.id, 0, 'tier',
              format('退款後降等 %s -> %s (累積消費 %s)', v_old_tier, v_new_tier, v_new_spend),
              v_order.order_number, p_operator_email);
    END IF;

    IF v_restore_birthday THEN
      INSERT INTO member_audit_log (member_id, delta, field, reason, ref_order_number, operator_email)
      VALUES (v_member.id, 0, 'birthday_used_year',
              '訂單全退,還原生日優惠額度',
              v_order.order_number, p_operator_email);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok',                true,
    'order_id',          p_order_id,
    'order_number',      v_order.order_number,
    'refund_amount',     p_refund_amount,
    'total_refunded',    v_already_refunded + p_refund_amount,
    'order_total',       v_order.total,
    'new_status',        v_new_status,
    'credit_refunded',   v_credit_refund,
    'member_id',         v_member.id,
    'old_spend',         COALESCE(v_member.accumulated_spend, 0),
    'new_spend',         COALESCE(v_new_spend, 0),
    'old_count',         COALESCE(v_member.purchase_count, 0),
    'new_count',         COALESCE(v_new_count, 0),
    'old_tier',          v_old_tier,
    'new_tier',          v_new_tier,
    'tier_changed',      COALESCE(v_tier_changed, false),
    'birthday_restored', v_restore_birthday
  );
END;
$$;

REVOKE ALL ON FUNCTION apply_order_refund(uuid, numeric, boolean, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_order_refund(uuid, numeric, boolean, text, text) TO service_role;


-- ============================================================
-- 4. 一次性重算所有會員 tier
--    包成 SECURITY DEFINER 函式呼叫,避免在 anon JWT context 被 trigger 擋住
--    回傳變動清單以利稽核
-- ============================================================
CREATE OR REPLACE FUNCTION _recompute_all_member_tiers(p_operator_email text DEFAULT 'system')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_changes jsonb := '[]'::jsonb;
  v_member  RECORD;
  v_new_tier text;
  v_changed_count int := 0;
BEGIN
  FOR v_member IN
    SELECT id, email, display_name, accumulated_spend, tier
      FROM members
     ORDER BY accumulated_spend DESC
  LOOP
    v_new_tier := _compute_tier_from_spend(COALESCE(v_member.accumulated_spend, 0));

    IF v_new_tier <> COALESCE(v_member.tier, 'bronze') THEN
      UPDATE members
         SET tier = v_new_tier
       WHERE id = v_member.id;

      INSERT INTO member_audit_log (member_id, delta, field, reason, operator_email)
      VALUES (v_member.id, 0, 'tier',
              format('一次性等級重算 (migration 013): %s → %s (累積消費 %s)',
                     COALESCE(v_member.tier, 'bronze'), v_new_tier,
                     COALESCE(v_member.accumulated_spend, 0)),
              p_operator_email);

      v_changes := v_changes || jsonb_build_object(
        'member_id', v_member.id,
        'email', v_member.email,
        'display_name', v_member.display_name,
        'accumulated_spend', v_member.accumulated_spend,
        'old_tier', COALESCE(v_member.tier, 'bronze'),
        'new_tier', v_new_tier
      );
      v_changed_count := v_changed_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok',            true,
    'changed_count', v_changed_count,
    'changes',       v_changes
  );
END;
$$;

GRANT EXECUTE ON FUNCTION _recompute_all_member_tiers(text) TO service_role;


-- ============================================================
-- 5. 跑一次重算 — 這個 SELECT 會印出變動清單
-- ============================================================
SELECT _recompute_all_member_tiers('migration_013');


-- ============================================================
-- 驗證 SQL (執行後手動跑):
--   -- 確認 nhkbee177 是黑卡
--   SELECT email, accumulated_spend, tier
--     FROM members
--    WHERE email LIKE 'nhkbee177%';
--
--   -- 看本次重算寫了哪些 audit log
--   SELECT m.email, l.reason, l.created_at
--     FROM member_audit_log l
--     JOIN members m ON m.id = l.member_id
--    WHERE l.reason LIKE '一次性等級重算%'
--    ORDER BY l.created_at DESC;
--
--   -- 確認 helper 在不同金額下回傳正確 tier
--   SELECT _compute_tier_from_spend(0),
--          _compute_tier_from_spend(4999),
--          _compute_tier_from_spend(5000),
--          _compute_tier_from_spend(14999),
--          _compute_tier_from_spend(15000),
--          _compute_tier_from_spend(29999),
--          _compute_tier_from_spend(30000),
--          _compute_tier_from_spend(59999),
--          _compute_tier_from_spend(60000),
--          _compute_tier_from_spend(100150);
--   -- 期望: bronze, bronze, silver, silver, gold, gold, diamond, diamond, black, black
-- ============================================================
