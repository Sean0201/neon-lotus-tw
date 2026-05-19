# Phase 2.1a-fixup — Tier System + Signup Credit + Purchase Count

> 從原本 Phase 2.1a 的「創始期 NT$500」改成「每位新會員一律 NT$100 註冊禮金」,
> 並加上 purchase_count(消費次數)+ 75% 折扣樓地板。
>
> **訪客結帳完全不受影響。** 登入是「可選的加值」。

---

## 規格摘要

| 項目 | 設定 |
|---|---|
| 訪客結帳 | ✅ 無需登入,Phase 1 滿額折扣照常 |
| 登入方式 | Google / Facebook(LINE 在 Phase 2.1b) |
| 等級制度 | bronze(銅)→ silver(銀)→ gold(金)→ diamond(鑽石) |
| 升等依據 | accumulated_spend(累積消費,折扣前商品小計) |
| 註冊禮金 | NT$100 — **每位新會員建立帳號立刻享有** |
| 消費次數 | purchase_count — 付款成功 +1 |
| 生日 9 折 | 一年用一次(birthday_used_year 追蹤) |
| 生日修改 | 客人只能填**第一次**,之後鎖死 → 改要透過客服(service_role) |
| 折扣樓地板 | 75% — 所有折扣疊加後最低不能低於原價 75% |

### 折扣疊加範例(以白金鑽石卡為例)
- 商品 NT$10,000
- 等級折扣 8.5 折 → 8,500
- 滿額折扣 9 折 → 7,650
- 生日 9 折 → 6,885
- **檢查樓地板**:6,885 < 10,000 × 0.75 = 7,500 → **拉回 7,500**

實作上 server 端 (`newebpay-create.js`) 也會跑同樣計算,客人無法竄改前端金額。

---

## ① 跑兩份 SQL migration

進 Supabase Dashboard → **SQL Editor** → New query → 整段貼上 → **RUN**。
**順序很重要,先 004 再 005。**

### Step 1 — 004_signup_credit_and_purchase_count.sql

把 `db/migrations/004_signup_credit_and_purchase_count.sql` 整份貼上 RUN。
應該看到 `Success. No rows returned`。

**驗證:**
```sql
-- members 應該有 purchase_count, 不應該有 founding_member
select column_name from information_schema.columns
  where table_name='members' order by ordinal_position;
```

預期欄位:
`id, user_id, email, display_name, phone, birthday,
accumulated_spend, tier, founding_credit_balance, birthday_used_year,
purchase_count, created_at, updated_at`

```sql
-- site_config 應該長這樣
select key, value from site_config order by key;
```

預期看到:
- `birthday_discount_rate = 0.9`
- `discount_floor_rate = 0.75`
- `signup_credit_amount = 100`

**不應該**看到任何 `founding_period_*`、`founding_credit_amount`、`founding_initial_tier`。

```sql
-- orders 應該有 signup_credit_used(不是 founding_credit_used)
select column_name from information_schema.columns
  where table_name='orders' and column_name like '%credit_used%';
```

### Step 2 — 005_signup_credit_trigger.sql

把 `db/migrations/005_signup_credit_trigger.sql` 整份貼上 RUN。
應該看到 `Success`。

**驗證:**
```sql
-- Function 內容不應該再 reference founding_period
select pg_get_functiondef(oid) from pg_proc where proname = 'handle_new_user';
-- 內容應該找不到 'founding_period' 或 'v_is_founding' 字串

-- Trigger 應該存在
select tgname from pg_trigger where tgname = 'on_auth_user_created';
```

**實測(建議):**
Supabase Dashboard → Authentication → Users → **Invite user** →
輸入測試 email → 寄出邀請。然後:
```sql
select user_id, email, display_name,
       tier, accumulated_spend, purchase_count, founding_credit_balance, birthday
  from members where email = '剛邀請的 email';
```
應該看到:
- `tier = 'bronze'`
- `accumulated_spend = 0`
- `purchase_count = 0`
- `founding_credit_balance = 100` ✨(這就是 NT$100 註冊禮金)
- `birthday = null`

---

## ② Supabase Auth Providers 設定

進 Supabase Dashboard → **Authentication → Providers**:

### Google
1. Google Cloud Console → APIs & Services → Credentials → Create OAuth Client ID
2. Application type: **Web application**
3. Authorized redirect URIs 加:
   - `https://epemuyojkprepknuzuzc.supabase.co/auth/v1/callback`
4. 拿到 Client ID + Client Secret → 貼回 Supabase Provider 設定 → **Enable**

### Facebook
1. https://developers.facebook.com → My Apps → Create App → Consumer
2. 加 **Facebook Login** product
3. Valid OAuth Redirect URIs:
   - `https://epemuyojkprepknuzuzc.supabase.co/auth/v1/callback`
4. 把 App ID + App Secret → 貼回 Supabase → **Enable**

### LINE
**Phase 2.1b 才做** — 目前 modal 上的 LINE 按鈕是 `disabled`,點不下去。

---

## ③ 開啟前端 nav 登入按鈕

provider 接通後,把 `auth-ui.js` 第 18 行改成 `true`:

```js
// 原本
const AUTH_UI_ENABLED = false;
// 改成
const AUTH_UI_ENABLED = true;
```

然後 cache bump:`index.html` 把 `auth-ui.js?v=4` 改成 `v=5`,push 上 Vercel。

---

## ④ 還沒做 — Phase 2.2 任務

⚠️ **以下這幾項是「會員系統實際生效」的關鍵,但屬於 Phase 2.2 範圍,本次沒做:**

### a. 付款成功後 +累積消費 / +消費次數
位置:`api/newebpay-notify.js`(收到 NewebPay 付款成功通知後)
動作:
```sql
update members set
  accumulated_spend = accumulated_spend + 訂單商品小計,
  purchase_count    = purchase_count + 1,
  tier              = case when accumulated_spend+小計 >= 15000 then 'diamond'
                           when accumulated_spend+小計 >= 8000  then 'gold'
                           when accumulated_spend+小計 >= 4000  then 'silver'
                           else 'bronze' end
where id = order.member_id;

-- 寫 audit_log
insert into member_audit_log (member_id, delta, field, reason, ref_order_number, operator_email)
values (..., 訂單小計, 'accumulated_spend', '訂單', 訂單編號, 'system');
```

### b. cart.js 加上等級折扣 + 生日 9 折 + 75% 樓地板
- 等級折扣百分比要決定(目前 site_config 沒記,需要新增 `tier_discount_rates` JSON 或多個 keys)
- 結帳前計算:`tier_discount + 滿額折扣 + birthday 9折`,最後檢查 `total >= subtotal × 0.75`
- 若 birthday_used_year = 今年 → 不給 birthday 折扣
- 折抵金扣抵:結帳頁可勾選「使用 NT$X 折抵金」,扣完更新 founding_credit_balance

### c. newebpay-create.js 加上 server 端等級折扣驗證
- 不能信任前端送來的金額,server 重算一遍。
- 若客戶送來的金額 vs server 算的差距 > NT$5,拒絕並回 400。

### d. 會員中心頁面 (Phase 2.1c)
- 編輯電話、第一次設定生日、看歷史訂單。
- Admin UI 可改生日(走 service_role)。

---

## 影響範圍 (誰會壞掉?)

✅ **訪客結帳** — 完全不受影響,Phase 1 滿額折扣照常
✅ **舊資料相容** — 舊的創始會員 (founding_member=true, founding_credit_balance=500)
   在跑 004 後,founding_member 欄位被刪,founding_credit_balance 維持 500 不動。
   等於把他們也視為「拿了 NT$500 註冊禮金」的會員 — 沒虧到客人。
✅ **舊 orders** — tier_at_purchase / tier_discount / birthday_discount 都保留;
   founding_credit_used 被 rename 成 signup_credit_used,歷史值不動。
⚠️ **Phase 2.2 沒做之前** — 登入後 dropdown 會看到「累積消費 NT$0 / 消費次數 0 次」
   永遠是 0,因為還沒有任何地方 +1。先這樣 deploy 沒問題,Phase 2.2 補上後就會動。
