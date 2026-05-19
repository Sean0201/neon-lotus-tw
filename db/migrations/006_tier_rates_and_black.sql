-- ──────────────────────────────────────────────────────
-- Phase 2.2 — 五階等級 (新增 black) + 折扣率 / 樓地板 / 雙軌滿額現折 site_config
--
-- 規格:
--   等級   門檻 (累積消費)  折扣率   樓地板
--   bronze  $0               100%    75%
--   silver  $5,000           95%     75%
--   gold    $15,000          92%     75%
--   diamond $30,000          88%     75%
--   black   $60,000          85%     70%   ← 新增
--
--   雙軌滿額現折 (僅會員,以「等級折扣後」金額判定):
--     親自帶回:  $4,000 → −$300,  $8,000 → −$1,000,  $15,000 → −$2,500
--     國際運送:  $5,000 → −$300, $10,000 → −$1,000,  $19,000 → −$2,500
--
--   超商滿 $3,000 免運 (全館共通,不分會員)
--
-- 此 migration 是冪等的 (idempotent):重複跑不會出錯。
-- ──────────────────────────────────────────────────────

-- ============================================================
-- 1. 先把 trigger drop 掉,允許動 schema
-- ============================================================
drop trigger if exists trg_protect_member_fields on members;


-- ============================================================
-- 2. members.tier CHECK constraint — 加入 'black'
-- ============================================================
alter table members drop constraint if exists members_tier_check;
alter table members add constraint members_tier_check
  check (tier in ('bronze','silver','gold','diamond','black'));


-- ============================================================
-- 3. member_audit_log.field CHECK — 加入 purchase_count
--    Phase 2.2 newebpay-notify hook 會 audit 累積消費 / 消費次數 / 等級升級 / 折抵金扣抵
-- ============================================================
alter table member_audit_log drop constraint if exists member_audit_log_field_check;
alter table member_audit_log add constraint member_audit_log_field_check
  check (field in ('accumulated_spend','founding_credit_balance','tier','purchase_count'));


-- ============================================================
-- 4. site_config — 五階等級門檻 / 折扣率 / 樓地板 / 雙軌滿額現折 / 免運
-- ============================================================

-- 廢除舊的單一樓地板設定 (被 tier_floor_rates 取代)
delete from site_config where key = 'discount_floor_rate';

-- 新增 / 覆寫五階等級設定 (JSON 格式,前後端解析後使用)
insert into site_config (key, value, description) values
  ('tier_thresholds',
   '{"bronze":0,"silver":5000,"gold":15000,"diamond":30000,"black":60000}',
   '等級升級門檻 — JSON object,累積消費 TWD'),

  ('tier_discount_rates',
   '{"bronze":1.0,"silver":0.95,"gold":0.92,"diamond":0.88,"black":0.85}',
   '等級會員折扣率 — JSON object (1.0 = 無折扣)'),

  ('tier_floor_rates',
   '{"bronze":0.75,"silver":0.75,"gold":0.75,"diamond":0.75,"black":0.70}',
   '等級樓地板比率 — JSON object,整單折後不得低於原價 × floor_rate'),

  ('bulk_discount_carryback',
   '[[4000,300],[8000,1000],[15000,2500]]',
   '親自帶回滿額現折 (僅會員) — JSON array of [門檻,折扣],以等級折扣後金額判定'),

  ('bulk_discount_shipping',
   '[[5000,300],[10000,1000],[19000,2500]]',
   '國際運送滿額現折 (僅會員) — JSON array of [門檻,折扣],以等級折扣後金額判定'),

  ('free_shipping_threshold',
   '3000',
   '超商免運門檻 TWD — 全館共通,不分會員')
on conflict (key) do update
  set value       = excluded.value,
      description = excluded.description;


-- ============================================================
-- 5. 重建 _protect_sensitive_member_fields trigger
--    (跟 migration 004 一樣,只是要重 attach;black 也適用同保護)
-- ============================================================
create or replace function _protect_sensitive_member_fields() returns trigger as $$
begin
  -- service_role 完全不受限 — 後端 newebpay-notify / admin 用
  if current_setting('request.jwt.claim.role', true) = 'service_role' then
    return new;
  end if;

  -- 客人不准動的欄位:強制保留舊值
  new.accumulated_spend       := old.accumulated_spend;
  new.tier                    := old.tier;
  new.founding_credit_balance := old.founding_credit_balance;
  new.birthday_used_year      := old.birthday_used_year;
  new.purchase_count          := old.purchase_count;
  new.email                   := old.email;

  -- 生日:一旦設定就鎖住 (要改必須走 service_role / 客服)
  if old.birthday is not null then
    new.birthday := old.birthday;
  end if;

  return new;
end$$ language plpgsql security definer;

create trigger trg_protect_member_fields
  before update on members
  for each row
  execute function _protect_sensitive_member_fields();


-- ============================================================
-- 6. 驗證 — 跑完後可手動執行以下 query 確認
-- ============================================================
-- ✅ tier 應該可以塞 'black'
-- update members set tier='black' where id='<some-id>';  ← service_role only

-- ✅ site_config 應該看到 6 個新 key
-- select key, value from site_config
-- where key in ('tier_thresholds','tier_discount_rates','tier_floor_rates',
--               'bulk_discount_carryback','bulk_discount_shipping','free_shipping_threshold')
-- order by key;

-- ✅ 不應該有 discount_floor_rate
-- select key from site_config where key='discount_floor_rate';  -- 應該空
