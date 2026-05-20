-- 011_reset_nhkbee177_state.sql
-- 一次性 SQL — 把 nhkbee177 的會員狀態調到「8657 訂單付款後 + 折抵金帳務修正後」
-- 的正確絕對值。前提:010 已部署 (postgres role bypass 已啟用)。
--
-- 目標狀態:
--   accumulated_spend       = 150   (8657 商品實付 NT$150)
--   purchase_count          = 1
--   founding_credit_balance = 50    (原 100 - 8657 實際扣抵 50,因樓地板吃掉另 50)
--   tier                    = bronze (150 < silver 門檻 5000)
--
-- 跑完後可立即在前台會員中心看到正確的累積金額 / 折抵金。
-- 注意:audit log 不動,過去的 +150/+1/-100/+50 ledger 紀錄保留為歷史線索。

UPDATE members
SET accumulated_spend       = 150,
    purchase_count          = 1,
    founding_credit_balance = 50,
    tier                    = 'bronze'
WHERE id = '5f9384d7-9f0a-466f-b3b2-c1b81b9567a4'
  AND email = 'nhkbee177@gmail.com';  -- 防呆,確保只動到對的人

-- 驗證
SELECT id, email, tier, accumulated_spend, purchase_count, founding_credit_balance
FROM members
WHERE id = '5f9384d7-9f0a-466f-b3b2-c1b81b9567a4';
