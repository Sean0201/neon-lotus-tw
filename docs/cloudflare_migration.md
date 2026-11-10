# Vercel → Cloudflare Pages 搬家手冊

網站程式已經可以在 Cloudflare Pages 上執行(`feat/cloudflare-pages` 分支)。
`api/` 底下 18 支 API **完全沒改寫**,由 `functions/_lib/vercel-adapter.js` 轉接。

| 項目 | Vercel(現在) | Cloudflare Pages(搬家後) |
|---|---|---|
| 網站檔案 | 整個專案根目錄 | 只有 `dist/`(`scripts/build-pages.mjs` 白名單複製) |
| API | `api/*.js` | `functions/api/[name].js` → 轉接 `api/*.js` |
| 建置 | `node scripts/dump-snapshot.js` | `npm run build:pages`(快照 + 複製 + `_headers`) |
| 網址轉址、標頭 | `vercel.json` | Pages 內建單頁應用轉址 + `dist/_headers` |
| Threads 排程 | `vercel.json` crons | GitHub Actions(`.github/workflows/threads-cron.yml`) |
| 「重建快照」按鈕 | `VERCEL_DEPLOY_HOOK_URL` | `DEPLOY_HOOK_URL`(Cloudflare 部署 Hook) |

---

## 步驟 1:建立 Pages 專案

Cloudflare 後台 → **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → 選 `Sean0201/neon-lotus-tw`

| 設定 | 值 |
|---|---|
| Production branch | `main`(DNS 還沒切之前,`*.pages.dev` 網址不會影響正式網站) |
| Framework preset | None |
| Build command | `npm run build:pages` |
| Build output directory | `dist` |
| Root directory | (留空) |

## 步驟 2:環境變數

**Settings → Variables and Secrets**,Production 和 Preview 都要設。
值直接從 Vercel 複製:Vercel 專案 → Settings → Environment Variables(每一個都能點開看值)。
金鑰類請選 **Secret(加密)**。

| 變數 | 用途 | 備註 |
|---|---|---|
| `NODE_VERSION` | 建置用 Node 版本 | 填 `20` |
| `NEXT_PUBLIC_SUPABASE_URL` | 快照、API | |
| `SUPABASE_SERVICE_ROLE_KEY` | 快照、API | Secret |
| `SITE_URL` | 金流 / 物流回呼網址 | 正式:`https://www.neonlotus-tw.com`;Preview 填 pages.dev 網址 |
| `ADMIN_EMAILS` | 後台權限 | |
| `NEWEBPAY_MERCHANT_ID` `NEWEBPAY_HASH_KEY` `NEWEBPAY_HASH_IV` `NEWEBPAY_API_URL` `NEWEBPAY_PAYMENT_METHODS` | 藍新金流 | Secret;**Preview 建議填藍新測試環境** |
| `ECPAY_MERCHANT_ID` `ECPAY_HASH_KEY` `ECPAY_HASH_IV` `ECPAY_LOGISTICS_*` `ECPAY_MAP_API_URL` | 綠界物流 | 依 Vercel 上有設的照填 |
| `TELEGRAM_BOT_TOKEN` `TELEGRAM_CHAT_ID` `TELEGRAM_WEBHOOK_SECRET` | 訂單通知、Threads 機器人 | Secret |
| `THREADS_USER_ID` `THREADS_USER_ACCESS_TOKEN` | Threads 發文 | Secret |
| `OPENAI_API_KEY` | Threads 改稿 | Secret |
| `GEMINI_API_KEY` | 試衣間 | Secret |
| `CRON_SECRET` | 排程驗證 | 自訂一串亂碼,GitHub Actions 也要填同一個 |
| `DEPLOY_HOOK_URL` | 後台「重建快照」 | 步驟 3 建立後填入 |

## 步驟 3:部署 Hook(後台「🚀 重建快照 + 發佈」用)

Pages 專案 → Settings → **Builds** → **Deploy hooks** → 建立(分支 `main`)→ 複製網址填進 `DEPLOY_HOOK_URL` → 重新部署一次讓變數生效。

## 步驟 4:在 pages.dev 網址測試

- [ ] 首頁、衣架、木櫃、品牌頁、單品檢視
- [ ] 會員登入(Supabase → Authentication → URL Configuration 的 Redirect URLs 要加上 pages.dev 網址)
- [ ] 後台登入、精選商品、會員查詢
- [ ] **藍新測試環境**完整付款一次(Preview 的 `SITE_URL` 要是 pages.dev 網址,付款通知才會回到測試站)
- [ ] 超商門市選擇(綠界電子地圖)
- [ ] 獵物雷達送出(會發 Telegram 通知)
- [ ] 後台「重建快照」按鈕

## 步驟 5:切換網域

1. Pages 專案 → **Custom domains** → 加入 `www.neonlotus-tw.com`(和根網域)→ 照指示改 DNS
   - 網域的 DNS 若不在 Cloudflare,`www` 可以用 CNAME 指到 `<專案>.pages.dev`;根網域通常需要把 DNS 搬到 Cloudflare
2. 藍新、綠界後台的回呼網址若是寫正式網域,**不用改**
3. **停掉 Vercel 的排程,避免重複發文**:Vercel 專案 → Settings → Cron Jobs 停用(或刪除 `vercel.json` 的 `crons`)
4. GitHub → Settings → Secrets and variables → Actions:設定 `SITE_URL`、`CRON_SECRET` → Threads 排程開始由 GitHub Actions 執行
   (Actions 頁面可以手動按 **Run workflow** 測試一次)
5. 觀察幾天沒問題,再把 Vercel 專案停用。期間有狀況可以把 DNS 切回 Vercel。

---

## 本機測試

```bash
node scripts/build-pages.mjs --skip-snapshot   # 沿用現有 data/,不連資料庫
npx wrangler@4 pages dev dist --port 8788      # 金鑰放 .dev.vars(已在 .gitignore)
```

## 注意

- Cloudflare 免費方案每次請求約 10 毫秒 CPU 時間(等待外部回應不算)。藍新加解密已在本機的 Cloudflare 執行環境測過 PKCS#7 與 zero-padding 兩種格式。
- 新增 API:在 `api/` 加檔案後,也要在 `functions/api/[name].js` 加一行 import 和路由。
