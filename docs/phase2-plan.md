# Phase 2 — 會員系統 + 老客戶遷移規劃

> 撰寫日期:2026-05-18
> 狀態:**Phase 2.0 進行中**(資料表建立)
> 前置條件:Phase 1 滿額折扣已上線

## ✅ 已拍板決策(2026-05-18)

| 決策點 | 採用 |
|--------|------|
| MVP 登入方式 | Google + Email Magic Link + **Facebook** + **訪客結帳保留** |
| 會員等級門檻 | 20K / 50K / 120K |
| 等級折扣率 | -3% / -5% / -8% |
| 折扣下限 | **75 折** |
| 創始會員福利 | 直升銀卡 + NT$500 折抵金 |
| 創始期長度 | 60 天 (上線前 30 + 後 30) |
| 生日折扣 | 整月 -5%,每年一筆訂單可用 |

**最壞情況疊加驗算**:Diamond -8% × 生日月 -5% × 88 折滿額 = 0.92 × 0.95 × 0.88 ≈ **76.9%**(僅 23.1% off),仍高於 75 折下限 ✅

---

## 0. 大方向

Phase 2 的目標是把「一次性的交易」變成「長期的關係」。三個支柱:

1. **登入** — 客人有帳號,訂單可以累積到同一個身分
2. **累積消費 → 會員等級** — 消費越多享更深折扣
3. **生日優惠** — 給情感連結,讓客人記得這個品牌

老客戶遷移流程是 Day 0 必做的工作,不然第一波詢問會很多。

---

## 1. 登入系統 (Supabase Auth)

### 1.1 用 Supabase Auth 而不是自己刻

理由:你已經在用 Supabase,Auth 是內建的,免費額度 50,000 MAU,完全夠用。OAuth、密碼、Email Magic Link 都包好,前端 import `supabase.auth.signInWithOAuth({ provider })` 一行搞定。

### 1.2 OAuth 提供者比較

| 提供者 | Supabase 原生支援 | 設定難度 | 客人接受度 (台灣) |
|--------|-------------------|---------|------------------|
| Google | ✅ 原生 | 低 — Google Cloud 設 OAuth client | 高 |
| Apple  | ✅ 原生 | 中 — 需 Apple Developer $99/年 | 中(iOS 用戶) |
| Facebook | ✅ 原生 | 中 — Meta for Developers app review | 中 |
| LINE | ❌ 不支援 | 高 — 需自行串 LINE Login (OIDC) + Supabase Custom JWT | **最高** |

### 1.3 建議的上線策略

**MVP (Phase 2.1):** Google + Email Magic Link
- Google 對台灣客人涵蓋率 > 95%
- Magic Link 是後備,不會 Google 的也能登入
- 開發時間:1-2 天

**強化 (Phase 2.2):** 加 LINE Login
- 台灣電商 LINE 是必備,但要自己串
- 流程:LINE Login 拿到 access_token → 自家後端驗證 → 簽 Supabase JWT
- 需要新增 `/api/auth-line.js` serverless function
- 開發時間:2-3 天

**選配 (Phase 2.3):** Apple + Facebook
- 若 Apple Developer 已有可加,沒有就先跳過
- Facebook 近年註冊客人少,優先度低

### 1.4 帳號合併原則

同一個 email 用不同 provider 登入時(Google + LINE 都是 sean@gmail.com),要視為**同一個會員**,合併到同一個 `members.id`。Supabase Auth 有 `identities` 表處理多 provider linking,但 LINE 走 Custom JWT 時需要手動處理。

---

## 2. 資料表設計

```sql
-- members: 1 個人 1 列, 累積消費跟著這列走
create table members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) unique,  -- Supabase Auth 主鍵
  email text unique not null,
  display_name text,
  phone text,
  birthday date,                       -- 生日月份折扣用
  accumulated_spend integer default 0, -- 累積消費 (TWD, 折扣前)
  tier text default 'bronze',          -- bronze/silver/gold/diamond
  founding_member boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- member_audit_log: 累積金額手動調整紀錄 (避免日後爭議)
create table member_audit_log (
  id uuid primary key default gen_random_uuid(),
  member_id uuid references members(id),
  delta integer not null,              -- 加減金額 (可負)
  reason text not null,                -- '老客戶遷移' / '訂單退貨' / 'admin 手動調整'
  ref_order_number text,               -- 對應的訂單號(若有)
  operator_email text,                 -- 是誰調整的
  created_at timestamptz default now()
);

-- orders: 加一欄關聯到會員 (現有訂單表加欄即可,不需新建)
alter table orders add column member_id uuid references members(id);
alter table orders add column tier_at_purchase text;     -- 下單時的等級 (歷史快照)
alter table orders add column birthday_discount integer default 0;
```

RLS 政策:
- `members.select`: 只能讀自己的(`user_id = auth.uid()`)
- `members.update`: 客人可改 `display_name`, `phone`, `birthday`,**不能改** `accumulated_spend`, `tier`
- `member_audit_log`: 一般客人完全禁讀禁寫,只有 admin role 可寫,客人可讀自己的(透過 view)

---

## 3. 會員等級設計

### 3.1 等級門檻(建議)

| 等級 | 累積消費門檻 | 額外折扣 | 視覺色 |
|------|-------------|---------|--------|
| 🥉 Bronze 銅卡 | NT$0 起 | 無 | 古銅 |
| 🥈 Silver 銀卡 | NT$30,000 | -2% | 銀白 |
| 🥇 Gold 金卡   | NT$80,000 | -4% | 金 |
| 💎 Diamond 鑽石 | NT$200,000 | -6% | 漸層紫 |

**累積標準**:用「下單時的商品原價小計」累加,不扣折扣後金額。理由是讓客人感覺累積快、有成就感。

### 3.2 與滿額折扣的疊加規則

兩種折扣**可以疊加**,但設定上限避免毛利失控:

```
最終價 = 商品小計 × Phase1 滿額折扣 × 會員等級折扣 × 生日月折扣
最低折扣下限:75 折 (不能再低)
```

範例:
- 商品 10,000,客人是 Gold + 生日月 + 觸發 88 折滿額
- 計算:10000 × 0.88 × 0.96 × 0.95 = 8023
- 約 80 折,在 75 折下限以內 ✅

範例 2:
- 商品 20,000,Diamond + 生日月 + 88 折滿額
- 計算:20000 × 0.88 × 0.94 × 0.95 = 15716
- 約 78.6 折,還在限內 ✅

### 3.3 等級升降規則

- **升等**:即時生效,當下訂單就用新等級
- **保級**:每年 1/1 重置累積,但保留前一年的等級「保送一年」
- **降等**:連續兩年沒達到累積門檻才降

---

## 4. 生日優惠

### 4.1 設計

生日**整個月**享 -5%(不是只生日當天)。理由:
- 客人不會剛好生日當天上線購物
- 整月活動可推「生日月專屬通知」,刺激消費
- 一年只能用一次該客人的生日月

### 4.2 防濫用

- 註冊時填生日,**只能設定一次**,改要找客服
- 同一個 `member_id` 該年的生日月只能用一筆訂單(資料庫加 unique index)
- 後台可看到生日月折扣使用紀錄

---

## 5. 老客戶遷移流程 ⭐(本次新增)

這是 Day 0 必做工作。三條軌道並行:

### 5.1 創始會員開放期(Day -30 到 Day +30)

- 在 Phase 2 上線**前** 30 天 + 上線**後** 30 天,共 60 天為「創始會員期」
- 這段期間任何新註冊客人都自動加上 `founding_member = true`
- 創始會員福利:
  - **直升 Silver 銀卡**(視同已消費 NT$30,000)
  - **贈 NT$500 一次性折抵金**(下次消費滿 NT$2,000 可用)
  - 創始會員勛章(UI 上的識別)

公告文案(放在首頁、購物車、LINE 公告):
> 🎉 NEON LOTUS 會員制度正式啟動!
> 2026/XX/XX - XX/XX 加入會員即享:
> ✨ 直升銀卡會員 (享每筆訂單 -2%)
> 🎁 NT$500 創始會員回饋金
> 🎂 生日月專屬 -5% 優惠

### 5.2 個別老客戶回補(永久開放)

對於主動詢問「我以前消費過怎麼沒算到」的客人,提供手動回補:

**前端流程:**
1. 客人在 LINE / Email 提供:註冊用 email + 舊訂單編號(或下單姓名 + 電話)
2. 你在 admin 後台:
   - 輸入客人 email → 查到該會員 → 看現有 `accumulated_spend`
   - 搜尋舊訂單表中匹配的 `customer_email` 或 `customer_phone`
   - 列出所有匹配訂單,勾選要計入的訂單
   - 點「確認加總」→ 寫入 `members.accumulated_spend` + 一筆 `member_audit_log` 紀錄

**後端 API:** `POST /api/admin/credit-legacy-orders`
- body: `{ memberId, orderNumbers[], reason: '老客戶遷移' }`
- 必須驗證 admin token
- 用 transaction 確保 audit_log 跟 accumulated_spend 同步寫入

### 5.3 主動推送通知(可選)

如果你的舊訂單表有完整的 email,可以一次性發送 email blast:

> 親愛的 [客人姓名],
>
> 感謝您在 [上次下單日期] 支持 NEON LOTUS。
> 為了讓老客戶享有更好的回饋,我們特別保留了您過去的累積消費 NT$ [金額]。
>
> 立即註冊會員,即可使用累積消費直升 [Silver/Gold/Diamond] 等級:
> [註冊連結]
>
> ※ 創始會員額外贈送 NT$500 購物金

技術上:跑一個 script 撈 orders 表所有 unique email,計算 sum(total),寄出個人化郵件。郵件內含一個 magic link,點擊後直接帶入該 email 註冊,並把累積金額預先寫入。

### 5.4 對外話術(客服標準回應)

> 您好,真的非常感謝您一直以來的支持 🙏
>
> 會員制度是我們 2026/XX 才新建立的,過去因為系統還沒上線,
> 訂單沒辦法自動對應到會員帳號。但因為您是我們的老客人,
> 我們很樂意幫您手動補上累積金額。
>
> 麻煩您提供:
> 1️⃣ 註冊會員時使用的 email
> 2️⃣ 過去訂單編號(或下訂時用的姓名 + 電話)
>
> 我們會在 1-2 個工作天內幫您處理升等 ✨

---

## 6. 實作順序建議

| 階段 | 內容 | 預估時間 |
|------|------|----------|
| 2.0 | 建立 members + member_audit_log 表 + RLS | 0.5 天 |
| 2.1 | Supabase Auth (Google + Email Magic Link) + 註冊/登入 UI | 1-2 天 |
| 2.2 | 會員中心頁(個人資料、訂單歷史、累積金額) | 1 天 |
| 2.3 | 結帳整合會員資訊 + 等級折扣 + 折扣上限保護 | 1 天 |
| 2.4 | Admin 後台:手動回補老客戶累積金額介面 | 1 天 |
| 2.5 | 創始會員開放期啟動 + 公告 + email blast | 0.5 天 |
| 2.6 | 生日月折扣邏輯 + UI 提示 | 0.5 天 |
| 2.7 | LINE Login 整合(/api/auth-line.js + custom JWT) | 2-3 天 |
| 2.8 | 完整測試 + 監控 + 上線 | 1 天 |

**總計約 9-12 個工作天**,可拆 3-4 週執行。

---

## 7. 需要先決定的事

在開始 2.0 前,以下決策請確認(可改我提的數字,但要先定下來):

1. **OAuth providers MVP** — 建議:Google + Email Magic Link
2. **會員等級門檻 + 折扣** — 建議:30K/80K/200K → -2/-4/-6%
3. **折扣下限** — 建議:75 折
4. **創始會員期天數** — 建議:60 天 (上線前 30 + 後 30)
5. **創始會員福利** — 建議:Silver 直升 + NT$500 折抵金
6. **生日折扣** — 建議:整月 -5%,年限一筆訂單
7. **保級制度** — 建議:每年重置但保留前一年等級
8. **email blast 是否要做** — 看你舊客 email 資料完整度決定

---

## 8. 風險與注意事項

- **隱私**:儲存 email、生日是個資,需在站上掛 Privacy Policy / 個資使用同意書
- **GDPR / 個資法**:客人可要求刪除帳號 → 預先設計 soft delete + 30 天後 hard delete
- **稅務**:會員折扣不影響開發票金額;發票金額 = 客人實付金額
- **重複領取**:創始會員 NT$500 折抵金要記在 `member_audit_log`,避免被多次領取
- **退貨**:訂單退貨時 `accumulated_spend` 要扣回,等級可能因此降等(設計上選擇「不降」較友善)
- **跨裝置同步**:登入後購物車要從 localStorage 遷移到資料庫 — 不然客人換手機看不到購物車

---

## 9. 我的建議下一步

1. 先看這份規劃,把第 7 節的 8 個決策點過一遍,告訴我哪幾項要調整
2. 確認後我們就進 Phase 2.0(建表 + RLS)
3. Phase 2.1-2.3 一鼓作氣做完是個自然里程碑 — 客人就能登入、看訂單歷史、享等級折扣
4. 2.4 老客戶回補介面可以提早做,因為一上線就會被問

之後 Phase 3 可考慮:
- 集點(每消費 NT$100 = 1 點,1 點 = NT$1 折抵)
- 推薦碼(老帶新雙方各得 NT$300 折抵)
- VIP 專屬商品 / 預售權
- 訂閱制(每月固定運費或固定 box)

— 完 —
