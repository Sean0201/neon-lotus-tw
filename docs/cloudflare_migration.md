# Vercel → Cloudflare Workers 搬家手冊

網站程式已經可以在 Cloudflare Workers 上執行(`feat/cloudflare-pages` 分支)。
`api/` 底下 14 支 API **完全沒改寫**,由 `worker/vercel-adapter.js` 轉接。
綠界物流的 4 支(`api/logistics-*.js`)**不部署**:前台結帳沒有使用,之後改接藍新物流。

| 項目 | Vercel(現在) | Cloudflare Workers(搬家後) |
|---|---|---|
| 網站檔案 | 整個專案根目錄 | 只有 `dist/`(`scripts/build-pages.mjs` 白名單複製) |
| API | `api/*.js` | `worker/index.js` → 轉接 `api/*.js` |
| 建置 | `node scripts/dump-snapshot.js` | `npm run build:cf`(快照 + 複製 + `_headers`) |
| 網址轉址、標頭 | `vercel.json` | `wrangler.toml` 的 assets(單頁應用模式)+ `dist/_headers` |
| Threads 排程 | `vercel.json` crons | `wrangler.toml` 的 `[triggers]`,需 `ENABLE_CRON=1` 才發文 |
| 「重建快照」按鈕 | `VERCEL_DEPLOY_HOOK_URL` | `DEPLOY_HOOK_URL`(Workers Builds 部署 Hook) |

---

## 步驟 1:Worker 的建置設定

Worker → **Settings** → **Build**

| 設定 | 值 |
|---|---|
| Git repository | `Sean0201/neon-lotus-tw` |
| Branch control → Production branch | `main` |
| Builds for non-production branches | **開啟**(測試 `feat/cloudflare-pages` 分支用) |
| Build command | `npm run build:cf` |
| Deploy command | `npx wrangler deploy` |
| Non-production branch deploy command | `npx wrangler versions upload` |
| Root directory | `/`(留空) |

⚠️ Worker 名稱必須是 `neon-lotus-tw`(和 `wrangler.toml` 的 `name` 一樣),不一樣會建置失敗。

**建置變數**(Settings → Build → **Variables and secrets**,建置快照時用):

| 變數 | 值 |
|---|---|
| `NODE_VERSION` | `22`(新版 supabase-js 需要 Node 22 以上) |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 網址 |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role 金鑰(Secret) |

另外到 Settings → **Domains & Routes**,確認 **Preview URLs** 是開啟的。

## 步驟 2:執行時的環境變數

Worker → **Settings** → **Variables and Secrets** → **Add**(勾 Production / Previews)

**兩邊都勾**:`NEXT_PUBLIC_SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`(Secret)、`ADMIN_EMAILS`、
`TELEGRAM_BOT_TOKEN`(Secret)、`TELEGRAM_CHAT_ID`、`GEMINI_API_KEY`(Secret)

**只勾 Production**:

| 變數 | 值 |
|---|---|
| `SITE_URL` | `https://www.neonlotus-tw.com` |
| `NEWEBPAY_MERCHANT_ID` `NEWEBPAY_HASH_KEY` `NEWEBPAY_HASH_IV` | 正式值(Secret) |
| `NEWEBPAY_API_URL` | `https://core.newebpay.com/MPG/mpg_gateway` |
| `NEWEBPAY_PAYMENT_METHODS` | 照 Vercel |
| `TELEGRAM_WEBHOOK_SECRET` `THREADS_USER_ACCESS_TOKEN` `OPENAI_API_KEY` `CRON_SECRET` | Secret |
| `THREADS_USER_ID` | 照 Vercel |
| `DEPLOY_HOOK_URL` | 步驟 3 建立後填(Secret) |
| `ENABLE_CRON` | **先不要加**,步驟 5 切換網域後才加 `1` |

**只勾 Previews**:

| 變數 | 值 |
|---|---|
| `SITE_URL` | 預覽網址(見步驟 4) |
| `NEWEBPAY_MERCHANT_ID` `NEWEBPAY_HASH_KEY` `NEWEBPAY_HASH_IV` | **測試商店**的值(Secret) |
| `NEWEBPAY_API_URL` | `https://ccore.newebpay.com/MPG/mpg_gateway` |
| `NEWEBPAY_PAYMENT_METHODS` | `CREDIT,VACC` |

Preview 不要填 Threads,避免測試時誤發文。

## 步驟 3:部署 Hook(後台「🚀 重建快照 + 發佈」用)

Worker → Settings → **Builds** → **Deploy Hooks** → 建立(分支 `main`)→ 複製網址 → 填進 `DEPLOY_HOOK_URL`。

## 步驟 4:在預覽網址測試

推送 `feat/cloudflare-pages` 分支後,Worker → **Deployments** 會出現這個分支的版本,點開可以看到預覽網址。

- [ ] 首頁、衣架、木櫃、品牌頁、單品檢視
- [ ] 會員登入(Supabase → Authentication → URL Configuration 的 Redirect URLs 加上預覽網址)
- [ ] 後台登入、精選商品、會員查詢
- [ ] **藍新測試環境**完整付款一次(Previews 的 `SITE_URL` 要是預覽網址,付款通知才會回到測試站)
- [ ] 獵物雷達送出(會發 Telegram 通知)

## 步驟 5:切換網域

1. `feat/cloudflare-pages` 合併到 `main`(Vercel 照樣能建置,兩邊並存)
2. Worker → Settings → **Domains & Routes** → **Add** → **Custom domain** → `www.neonlotus-tw.com`(和根網域)
   - 網域的 DNS 需要在 Cloudflare 上;不在的話照畫面指示把 nameserver 改到 Cloudflare
3. 藍新後台的回呼網址寫的是正式網域,**不用改**
4. **先停掉 Vercel 的排程**(Vercel 專案 → Settings → Cron Jobs 停用),再在 Cloudflare 加 `ENABLE_CRON=1`(Production),避免重複發文
5. 觀察幾天沒問題,再把 Vercel 專案停用。期間有狀況可以把網域切回 Vercel。

---

## 本機測試

```bash
node scripts/build-pages.mjs --skip-snapshot        # 沿用現有 data/,不連資料庫
npx wrangler@4 dev --port 8788 --test-scheduled     # 金鑰放 .dev.vars(已在 .gitignore)
curl "http://127.0.0.1:8788/__scheduled?cron=0+4%2C12+*+*+*"   # 測排程(ENABLE_CRON 未開只會寫 log)
```

## 注意

- Cloudflare 免費方案每次請求約 10 毫秒 CPU 時間(等待外部回應不算)。藍新加解密已在本機的 Cloudflare 執行環境測過 PKCS#7 與 zero-padding 兩種格式。
- 靜態檔案(網頁、圖片、快照)不算進 Worker 請求次數;只有 `/api/*` 會。
- 新增 API:在 `api/` 加檔案後,也要在 `worker/routes.js` 加一行 import 和路由。
