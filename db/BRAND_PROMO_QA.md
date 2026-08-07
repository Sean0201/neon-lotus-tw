# 品牌週活動 QA & 監控手冊

> Migration 015 — 品牌週 (`brand_promos`) 上線後的檢查、監控、疑難排解指南。
> Migration 016 — 品牌週會員加碼 (per-tier discount %),見「零、政策 (2026-08 更新)」。

## 零、政策 (2026-08-07 更新 — 方案 B 3 級合併加碼)

品牌週對其他優惠仍完全互斥(is_promo=true 商品自動跳過 tier/生日/滿額,只保留折抵金可扣)。但**同一階梯內,不同會員等級享不同 discount_percent**,讓白金/鑽石客有專屬感,防止「品牌週吃掉會員尊榮感」問題。

實作方式:`brand_promos.tier_rules` 從 flat 升級成 per-tier nested 格式(見 `db/migrations/016_brand_promo_member_tier.sql`),`brand-promo-engine.js` 新增 `pickTierBenefit(rule, memberTier)` 挑選對應等級的折扣。**未登入 / bronze / 未 match tier → 用 `rule.default` fallback**。舊格式(flat rule)完全向後相容。

HADES 加碼結構速查:

| 件數 | 一般 / bronze | silver / gold | diamond / black |
|---|---|---|---|
| 1 | 免運 | 免運 | 95 折 + 免運 |
| 2 | 95 折 + 免運 | 9 折 + 免運 | 88 折 + 免運 |
| 3 | 92 折 + 免運 | 87 折 + 免運 | 85 折 + 免運 |
| 5 | 88 折 + 免運 | 82 折 + 免運 | **80 折 + 免運 + HADES x NL 限定貼紙** |

**Server 端 audit**:`newebpay-create.js` 每筆訂單會用 `member.tier + tier_rules` 重算期望價格,`|client_price - expected_price| > 2` 就寫 Vercel `console.warn` (不擋單,±NT$5 總額 tolerance 是最終防線)。搜尋 log `[audit] brand_promo price mismatch` 可稽核異常訂單。

## 一、上線 / 換品牌前的 checklist

- [ ] 目標品牌在 `brands` 表有 row(`SELECT id, name FROM brands WHERE id = 'xxx';`)
- [ ] 目標品牌旗下有 `is_active = true` 的商品(`SELECT COUNT(*) FROM products WHERE brand_id = 'xxx' AND is_active = true AND sold_out = false;`)
- [ ] `brand_promos` 已建 row(admin → 品牌週活動 → +新增)
- [ ] tier_rules JSON 正確,件數升冪(1→2→3→5),`discount_percent` 是「折扣掉幾%」不是「打幾折」(15 = 打 85 折)
- [ ] **(016)** 若採加碼格式,每個 min_qty 至少要有 `default`;silver/gold/diamond/black 缺 key 會 fallback 到 default(不會噴錯,但銀/金客會拿到 bronze 折扣)
- [ ] **(016)** 用 bronze / silver / gold / diamond / black 四種帳號各測一次(至少 bronze + diamond),確認 banner 顯示對的折扣、cart 折後價對得上
- [ ] 前端 hard refresh 後,購物車拉到該品牌商品看到「🔥 XXX 品牌週 (N 件, X 折…): -NT$…」row
- [ ] 該品牌頁頂端看到 upsell 橫幅(階梯樓層)
- [ ] 前往結帳頁面,運費顯示「🔥 XXX 品牌週 免運已啟用!」(若 tier 有 `free_shipping:true`)
- [ ] 導向藍新金流成功(**沒有跳「訂單金額計算不一致」**)
- [ ] 完成付款後,`orders` 有一筆新訂單,`order_items` 的 `brand_promo_label / brand_promo_discount_percent / brand_promo_free_shipping` 都有值

## 二、常見疑難排解

### 症狀:購物車有折扣,結帳時跳「訂單金額計算不一致」

```sql
-- 1. 檢查品牌週是否真的 is_active
SELECT brand_id, label, is_active, starts_at, ends_at
FROM brand_promos WHERE brand_id = 'xxx';

-- 2. 檢查該商品的 brand_id 是否對得上
SELECT id, name, brand_id, is_promo
FROM products WHERE id IN ('<product_id_1>', '<product_id_2>');
```

若 brand_id 對不上(例如商品 brand_id = 'HADES' 但 promo brand_id = 'hades'):

```sql
-- brand_id 大小寫敏感,統一小寫
UPDATE brand_promos SET brand_id = LOWER(brand_id) WHERE brand_id != LOWER(brand_id);
```

看 Vercel function log(`/api/newebpay-create`),找 `[NewebPay create] totalAmount mismatch` 訊息 — 內含 `declared / expected / result / items`,可以馬上定位差距在哪段 pipeline。

### 症狀:活動關了,前端還顯示折扣

- 前端 cache TTL 60 分鐘。加購新東西 / 硬重整都會 refresh。
- 想立刻清乾淨:把 `supabase-client.js` 的 `CACHE_KEY` 從 `V14` +1 到 `V15`,commit + push。所有訪客的 cache 立刻作廢。

### 症狀:兩檔品牌週同時開,想只留一檔

```sql
-- 一鍵切換 (推薦:BEGIN…COMMIT 包起來)
BEGIN;
UPDATE brand_promos SET is_active = false, ends_at = NOW() WHERE brand_id = 'hades';
UPDATE brand_promos SET is_active = true, starts_at = NOW(), ends_at = NULL WHERE brand_id = 'mbi';
COMMIT;
```

## 三、Dashboard 查詢 SQL

### 3.1 目前活動狀況

```sql
SELECT * FROM v_brand_promo_stats;
-- 欄位:brand_id / label / is_active / starts_at / ends_at / active_products
```

### 3.2 該檔品牌週的總訂單數 / GMV / 節省金額

```sql
-- 換 :brand_id 跟時間窗
SELECT
  COUNT(DISTINCT o.id)                                              AS orders,
  SUM(oi.quantity)                                                  AS units_sold,
  SUM(oi.unit_price * oi.quantity)                                  AS gross_gmv,
  SUM(oi.unit_price * oi.quantity * COALESCE(oi.brand_promo_discount_percent, 0) / 100.0)
                                                                    AS promo_discount_given,
  SUM(oi.unit_price * oi.quantity
      * (1 - COALESCE(oi.brand_promo_discount_percent, 0) / 100.0)) AS net_gmv
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
WHERE oi.brand_id = 'hades'
  AND oi.brand_promo_label IS NOT NULL
  AND o.created_at >= '2026-08-01'
  AND o.created_at <  '2026-09-01'
  AND o.status IN ('paid','confirmed','shipped','delivered');
```

### 3.3 每日銷量 (畫折線圖用)

```sql
SELECT
  DATE(o.created_at)                             AS day,
  COUNT(DISTINCT o.id)                           AS orders,
  SUM(oi.quantity)                               AS units,
  SUM(oi.unit_price * oi.quantity)               AS gross
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
WHERE oi.brand_id = 'hades'
  AND oi.brand_promo_label = 'HADES 品牌週'
  AND o.status IN ('paid','confirmed','shipped','delivered')
GROUP BY DATE(o.created_at)
ORDER BY day;
```

### 3.35 (016) 依會員等級拆解 GMV — 看加碼有沒有拉動高階客

```sql
-- 用下單當下的 tier_at_purchase 分組 (orders 表已有,見 002_members.sql)
SELECT
  COALESCE(o.tier_at_purchase, 'guest')                  AS tier,
  COUNT(DISTINCT o.id)                                    AS orders,
  SUM(oi.quantity)                                        AS units,
  SUM(oi.unit_price * oi.quantity)                        AS net_gmv,
  ROUND(AVG(oi.brand_promo_discount_percent)::numeric, 1) AS avg_discount_pct
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
WHERE oi.brand_id = 'hades'
  AND oi.brand_promo_label IS NOT NULL
  AND o.status IN ('paid','confirmed','shipped','delivered')
GROUP BY COALESCE(o.tier_at_purchase, 'guest')
ORDER BY net_gmv DESC;
-- 期望結果:diamond/black 的 avg_discount_pct 應該高於 bronze/silver
-- (代表加碼真的被套用)
```

### 3.4 每個階梯被觸發的次數

```sql
SELECT
  oi.brand_promo_discount_percent AS discount_pct,
  COUNT(DISTINCT o.id)            AS orders_at_this_tier,
  SUM(oi.quantity)                AS units
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
WHERE oi.brand_id = 'hades'
  AND oi.brand_promo_label IS NOT NULL
  AND o.status IN ('paid','confirmed','shipped','delivered')
GROUP BY oi.brand_promo_discount_percent
ORDER BY discount_pct;
-- 看你的階梯設計是不是「大部分人只買 1 件」還是有效推到 5 件
```

### 3.5 品牌週 vs 非品牌週對照(同一品牌時間對照)

```sql
-- 把品牌週上線前後各 30 天的平均單品客單價比一比
WITH windows AS (
  SELECT DATE '2026-08-01' AS promo_start, DATE '2026-08-31' AS promo_end
)
SELECT
  CASE WHEN o.created_at::date BETWEEN w.promo_start AND w.promo_end THEN 'during_promo' ELSE 'before_promo' END AS phase,
  COUNT(DISTINCT o.id)                          AS orders,
  ROUND(AVG(o.total)::numeric, 0)               AS aov,
  SUM(oi.quantity)::float / COUNT(DISTINCT o.id) AS units_per_order
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
CROSS JOIN windows w
WHERE oi.brand_id = 'hades'
  AND o.status IN ('paid','confirmed','shipped','delivered')
  AND o.created_at >= (w.promo_start - INTERVAL '30 days')
  AND o.created_at <  (w.promo_end   + INTERVAL '1 day')
GROUP BY phase;
```

## 四、Edge cases 測試場景

| # | 情境 | 預期行為 |
|---|------|---------|
| 1 | 未登入 + 1 件 HADES | 免運。無折扣 (0%)。checkout 通過。`order_items.brand_promo_label='HADES 品牌週'`, `discount_percent=0`, `free_shipping=true`。 |
| 2 | 未登入 + 5 件 HADES | 免運 + 85 折。checkout 通過。 |
| 3 | 銀卡 + 3 件 HADES | 走品牌週 (90 折) *不套* 銀卡 (95 折),因 `excludes_other_promos=true`。 |
| 4 | 銀卡 + 3 件 HADES + 3 件其他品牌 | HADES 部分走品牌週。其他品牌走銀卡 tier + 滿額。互不干擾。 |
| 5 | 混合品牌週 (HADES + MBI 都 active) | 兩個品牌各自算階梯。checkout 通過。 |
| 6 | 加購中活動被停用 | 下一筆訂單 server 立刻不認 → 拒單 → 使用者被逼刷新 → 前端 (60min cache 後) 拿新資料。 |
| 7 | 換品牌 (hades stop → mbi start) | 舊 HADES cart 使用者刷新後看到原價。新 MBI 使用者看到 MBI 週。歷史 HADES 訂單的 `brand_promo_label='HADES 品牌週'` 不變。 |
| 8 | 觸發免運 + 用註冊禮金 | 免運 + credit 扣得動 promo 商品。tier/生日/滿額仍被 skip。checkout 通過。 |
| 9 | tier_rules 為空 (`[]`) | Engine 無 tier 可套 → 該品牌不套折扣。前端不顯示 banner。 |
| 10 | brand_id 打錯 (DB 沒對應) | Server warn `product_id not found in DB`,fallback 當 non-promo。checkout 會失敗(因為 client 算折扣了但 server 沒認)→ 修 brand_id。 |

## 五、監控 & 警報 (未來 nice-to-have)

- Vercel function log filter `[NewebPay create] totalAmount mismatch` — 累計 > 10 筆/小時就 alert
- `SELECT COUNT(*) FROM orders WHERE created_at > NOW() - INTERVAL '1 hour' AND status = 'pending';` — 品牌週開跑第一小時每 5 分鐘看一次,確認訂單有正常進來
- 品牌週結束後跑 3.2 的 SQL,把「promo_discount_given」給營運看,決定下一檔要不要再跑 / 調整階梯
