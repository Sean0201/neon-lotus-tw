# Phase 2.1a 上線前外部設定清單

跑這份是「DB migration + Supabase Dashboard + Google/Facebook 開發者後台」的事，code 端已經寫完。

按順序做完下面 5 步，前端登入按鈕才能真的動。LINE 留到 Phase 2.1b。

---

## ✅ Step 1 — 跑 DB migration

Supabase Dashboard → SQL Editor → New Query → 整段貼上 → RUN：

1. `db/migrations/003_auth_trigger.sql`

跑完驗證：

```sql
-- 應該回 4 列設定
select * from site_config order by key;

-- 應該看到 'on_auth_user_created' trigger
select tgname from pg_trigger where tgname = 'on_auth_user_created';
```

⚠️ 預設創始期是 `2026-05-25 ~ 2026-07-24`。若要改：

```sql
update site_config set value='2026-06-01' where key='founding_period_start';
update site_config set value='2026-07-31' where key='founding_period_end';
```

---

## ✅ Step 2 — Supabase Dashboard：啟用 Auth Providers

到 **Authentication → Providers**（左邊選單）：

### 2-1. Email
- 點 **Email**
- Enable Email provider: **ON**
- Confirm email: 建議 **OFF**（magic link 已經是 email 驗證了，再要 confirm 多一層會很煩）
- Secure email change: ON
- Save

### 2-2. Google
- 點 **Google**
- Enable: **ON**
- Client ID / Client Secret: 先空著，做完 Step 3 回來填
- 把 **Callback URL (for OAuth)** 那串複製下來（長這樣：`https://epemuyojkprepknuzuzc.supabase.co/auth/v1/callback`），Step 3 會用到

### 2-3. Facebook
- 點 **Facebook**
- Enable: **ON**
- Client ID / Client Secret: 一樣先空著，做完 Step 4 回來填
- Callback URL 也複製一下（跟 Google 同一條）

### 2-4. （略過）LINE — 沒得選

Supabase 沒有內建 LINE provider，必須用 Custom OIDC 或 Custom JWT，留到 **Phase 2.1b** 再做。

---

## ✅ Step 3 — Google Cloud Console：建立 OAuth Client

1. 去 https://console.cloud.google.com
2. 新增專案（或選現有的）—— 例如叫 `neon-lotus-tw`
3. 左邊選單 **APIs & Services → OAuth consent screen**
   - User Type: **External**
   - App name: `NEON LOTUS TW`
   - User support email: 你的 email
   - Developer contact: 你的 email
   - Authorized domains: 加 `neonlotus.tw`（或你的正式網域）跟 `supabase.co`
   - Scopes: 預設的 `openid` `email` `profile` 就好
   - Test users (測試階段先用)：加你自己 email
   - Save → 之後再點 **Publish app** 讓所有人能登入
4. 左邊選單 **APIs & Services → Credentials**
   - **Create Credentials → OAuth client ID**
   - Application type: **Web application**
   - Name: `NEON LOTUS TW Web`
   - **Authorized JavaScript origins**:
     ```
     https://neonlotus.tw
     https://neon-lotus-tw.vercel.app
     http://localhost:3000        ← 本機開發
     ```
   - **Authorized redirect URIs**：貼 Step 2-2 那條 Supabase callback URL
     ```
     https://epemuyojkprepknuzuzc.supabase.co/auth/v1/callback
     ```
   - Create
5. 把跳出來的 **Client ID** 跟 **Client Secret** 複製
6. 回 Supabase Dashboard → Authentication → Providers → Google → 貼進去 → **Save**

---

## ✅ Step 4 — Facebook for Developers：建立 App

1. 去 https://developers.facebook.com → My Apps → **Create App**
2. Use case: **Authenticate and request data from users with Facebook Login**
3. App type: **Consumer**
4. App name: `NEON LOTUS TW`
5. 進去後，左邊選單 **Products → Add product → Facebook Login → Set up**
6. **Facebook Login → Settings**
   - Valid OAuth Redirect URIs:
     ```
     https://epemuyojkprepknuzuzc.supabase.co/auth/v1/callback
     ```
   - Save changes
7. **Settings → Basic**（左邊選單最上面）
   - App Domains: `neonlotus.tw`（你的網域）
   - Privacy Policy URL: 必填（先填 `https://neonlotus.tw/privacy` 之類，之後再補頁面）
   - Save changes
   - 把 **App ID** 跟 **App Secret**（點 Show）複製
8. 回 Supabase Dashboard → Authentication → Providers → Facebook → 貼 App ID + App Secret → **Save**
9. 在 Facebook App Dashboard 上方把 **App Mode** 從 **Development** 切到 **Live**（不然只有你自己能登入）

---

## ✅ Step 5 — Supabase Authentication → URL Configuration

到 **Authentication → URL Configuration**：

### Site URL
```
https://neonlotus.tw
```
（你的主網域，正式網站。沒上正式網域之前先填 `https://neon-lotus-tw.vercel.app`）

### Redirect URLs (allow list)
```
https://neonlotus.tw
https://neonlotus.tw/**
https://neon-lotus-tw.vercel.app
https://neon-lotus-tw.vercel.app/**
http://localhost:3000
http://localhost:3000/**
```

Save。

---

## ✅ Step 6 — 測試流程

1. 部署到 Vercel（推 git）
2. 開瀏覽器無痕視窗 → https://neonlotus.tw
3. 右上角應該看到 **👤 登入** 按鈕
4. 點下去 → 跳出 modal，看到 4 個 provider 按鈕（LINE 是灰的，hover 顯示「即將推出」）
5. 點 **Google 登入** → 跳 Google 授權頁 → 回來應該變成 `🥈 顯示名稱` 徽章
6. 去 Supabase Dashboard → Authentication → Users，應該看到剛登入的 user
7. SQL Editor 跑：
   ```sql
   select email, display_name, founding_member, tier, founding_credit_balance
   from members order by created_at desc limit 5;
   ```
   今天 (2026-05-18) 還沒到創始期 5/25，所以 `founding_member=false`、`tier=bronze`、`credit=0`，這是對的。
   等 5/25 之後再註冊一個測試帳號，應該看到 `tier=silver`、`credit=500`。
8. 點徽章 → dropdown 看到 email、等級、累積消費、創始折抵金、登出按鈕
9. **Email magic link**: 在 modal 切到「Email 登入」分頁，輸入 email → 應該收到一封信，點裡面的連結會直接登入

---

## ✅ Step 7 — 客人登入後購物車合併（之後做）

目前購物車是 localStorage，登入不會合併。Phase 2.1c 再做：
- 登入後拿出當前 localStorage 購物車
- 上傳到 `cart_drafts` 表
- 下次任何裝置登入都能還原

訪客結帳本來就還能用，這部分不影響現有流程。

---

## 故障排除

**Q: 點 Google 登入沒反應 / console 報 `Invalid login provider`**
A: Supabase Dashboard → Providers → Google 沒 Enable，或 Client ID/Secret 沒填。

**Q: Google 登入跳回來但是沒登入 / URL 有 `error=access_denied`**
A: Google OAuth Consent Screen 還在 Testing 模式，且你的 email 不在 test users。要嘛加 test user，要嘛 **Publish app**。

**Q: Facebook 登入「This app is in development mode」**
A: Facebook App Dashboard 上方把 mode 切到 **Live**。

**Q: 登入後右上角還是顯示 👤 登入**
A: 開 DevTools console，看有沒有 `[AuthSystem] SIGNED_IN: xxxx@xxx.com`。沒有就是 detectSessionInUrl 沒抓到，檢查 URL 是否在 Redirect allowlist 內。

**Q: members 表沒有自動建列**
A: trigger 沒裝。回 Step 1 跑一次 `003_auth_trigger.sql`，注意 `handle_new_user()` 是 security definer，必須以 postgres role 跑（Dashboard SQL Editor 預設就是）。

**Q: 已經有 auth user 但 members 沒對應列（trigger 之前註冊的）**
A: 跑 backfill：
```sql
insert into members (user_id, email, display_name, tier)
select id, email, split_part(email,'@',1), 'bronze'
from auth.users
where id not in (select user_id from members where user_id is not null)
on conflict (user_id) do nothing;
```
