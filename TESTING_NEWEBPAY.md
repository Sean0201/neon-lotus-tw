# 藍新金流 (NewebPay) 測試指南

本文件涵蓋 NewebPay MPG 金流串接的環境變數設定、沙箱測試流程與正式上線步驟。

---

## 1. Vercel 環境變數設定

到 **Vercel Dashboard → 你的專案 → Settings → Environment Variables**,新增下列 5 組:

| 變數名稱 | 值 | 來源 | 環境 |
|---|---|---|---|
| `NEWEBPAY_MERCHANT_ID` | `MS********` | 藍新後台 / 開通信件 | Production / Preview / Development |
| `NEWEBPAY_HASH_KEY` | (32 字元字串) | 藍新後台 / 開通信件 | Production / Preview / Development |
| `NEWEBPAY_HASH_IV` | (16 字元字串) | 藍新後台 / 開通信件 | Production / Preview / Development |
| `NEWEBPAY_API_URL` | `https://ccore.newebpay.com/MPG/mpg_gateway` | (測試環境固定) | Production / Preview / Development |
| `SITE_URL` | `https://neon-lotus-tw.vercel.app` | Vercel domain | Production / Preview / Development |

> ⚠️ **千萬不要把 MerchantID / HashKey / HashIV 寫進 git**。它們等同於金流密碼,只能放在 Vercel 環境變數裡。實際的測試與正式憑證請從藍新開通信件中取得,不要分享在公開頻道或 commit log。

設定完後,**Redeploy** 一次,環境變數才會被新 deploy 讀到。

---

## 2. 沙箱測試流程

### A. 沙箱測試卡號

藍新測試環境的信用卡號 (隨意一組可用):

```
卡號:     4000-2211-1111-1111
有效期:   12/30 (任意未來日)
背面 CVC: 123
```

ATM / 超商代碼 / 條碼測試:走藍新測試後台給的虛擬帳號 / 代碼即可,不會真的扣款。

### B. 端到端測試步驟

1. **下單**:在前端選國際配送 → 填寫姓名/Email/電話 → 點「前往付款」
2. **檢查 console**:應該看到 `'正在導向藍新付款頁面...'` 的覆蓋層
3. **跳轉藍新**:會自動 POST 到 `ccore.newebpay.com/MPG/mpg_gateway`
4. **選擇付款方式**:應該看到 信用卡 / ATM / WebATM / 超商代碼 / 超商條碼 五種
5. **完成付款**:用上面的測試卡完成
6. **回到網站**:藍新會 POST 到 `/api/newebpay-return` → 我們 302 redirect 回首頁 `#order-success?order=NLxxx&amount=xxx&status=paid`
7. **檢查訂單頁**:`cart.js` 的 `checkPaymentResult` 會偵測 hash 並顯示成功頁

### C. 驗證 Server-to-Server Notify

1. 到 **Vercel Dashboard → Functions → newebpay-notify** 看 logs
2. 應該看到:
   ```
   [NewebPay Notify] Received: { Status: 'SUCCESS', MerchantID: 'MS...', ... }
   [NewebPay Notify] Decoded: {
     payloadStatus: 'SUCCESS',
     respondCode: '00',
     merchantOrderNo: 'NL...',
     tradeNo: '...',
     paymentType: 'CREDIT',
     amt: 1500,
     payTime: '2026-...',
     isPaid: true
   }
   ```
3. 回應應該是 `200 OK`

### D. 失敗情境測試

故意刷一張會被拒絕的卡 (藍新測試後台有提供) → 應該:
- Return endpoint:`#order-failed?status=failed&msg=...`
- Notify endpoint:`isPaid: false`,respondCode 不是 "00"

---

## 3. Sandbox vs Production 切換

當測試完畢、要上正式環境:

1. **聯絡藍新客服**取得正式商店的 MerchantID / HashKey / HashIV (跟測試的不同!)
2. 把 Vercel 環境變數改成正式的:
   - `NEWEBPAY_MERCHANT_ID` = (正式商店代碼)
   - `NEWEBPAY_HASH_KEY` = (正式 HashKey)
   - `NEWEBPAY_HASH_IV` = (正式 HashIV)
   - `NEWEBPAY_API_URL` = `https://core.newebpay.com/MPG/mpg_gateway` ← **拿掉開頭的 `c`**
3. **Redeploy**

> 提醒: 沙箱與正式是**完全獨立的兩個系統**,測試卡在正式環境會直接被拒。

---

## 4. 啟用 Supabase 訂單寫入 (TODO)

目前 `api/newebpay-notify.js` 裡面 Supabase update 的區塊是註解掉的 (約 102-126 行)。

要啟用時:

1. 確認 Supabase 有 `orders` table,至少要有以下欄位:
   - `order_no` (text, unique) — 對應 `MerchantOrderNo`
   - `payment_status` (text) — `pending` / `paid` / `failed`
   - `newebpay_trade_no` (text)
   - `payment_type` (text)
   - `payment_date` (text 或 timestamptz)
   - `payment_error` (text)
   - `updated_at` (timestamptz)
2. 確認 Vercel 已設 `SUPABASE_URL` 和 `SUPABASE_SERVICE_KEY`
3. 把 `/* */` 拿掉就可以

---

## 5. 檔案結構速查

```
api/
  newebpay-create.js    ← 前端呼叫 → 回傳自動提交 form
  newebpay-notify.js    ← 藍新 server-to-server 通知 (權威來源)
  newebpay-return.js    ← 使用者瀏覽器 redirect 回站
cart.js                 ← 前端 checkout 流程,呼叫 newebpay-create
```

* **NotifyURL** = 真正用來更新訂單狀態 (server-to-server,不會被使用者操作影響)
* **ReturnURL** = 只負責 UX,不應該拿來判定付款成功/失敗

---

## 6. 常見問題 (FAQ)

**Q: TradeSha 驗證一直失敗?**
A: 99% 是 HashKey 或 HashIV 設錯,或者誤把 sandbox 的拿到 production 用。

**Q: 解密出來是亂碼?**
A: 通常是 HashKey 不對 (32 字元),或 HashIV 不對 (16 字元)。

**Q: 付款成功但訂單沒更新?**
A: 沒啟用 Notify 裡的 Supabase 寫入區塊 (目前是 TODO 註解)。

**Q: 藍新一直重試 Notify?**
A: 我們的 notify endpoint 永遠回 `200 OK`,即使內部出錯,所以這不太會發生。如果還是發生,看 Vercel function logs 。

**Q: 付款後跳到 `#order-failed` 但藍新後台顯示成功?**
A: ReturnURL 的 TradeSha 驗證掛了。看 Vercel function logs 找 `[NewebPay Return]` 的錯誤訊息。
