# NEON LOTUS TW — 定價對照表 (NT$ 平加運費版本)

> 更新日期: 2026-05-05 (v2)
> 公式版本: NT$ flat-shipping + 拆分結尾規則 (carry=round10 / ship=psych)
> 同步檔案: `main.js` § 0/§ 2  /  `index.html` `calcHuntPrice()`  /  `admin.html` `_featuredCalc()`

---

## 1. 公式總覽

```
親自帶回 NT$  =  round10( marginalAdjVnd(VND) ÷ 800 )                    ← 四捨五入到 10
國際運送 NT$  =  psychPrice( marginalAdjVnd(VND) ÷ 800 + SHIP_NTD[品相] ) ← 50/90 心理定價
```

---

## 2. 累進倍率 TIERS (不變)

| VND 區間              | 倍率   |
| --------------------- | ------ |
| 0 ~ 300,000           | ×1.75  |
| 300,000 ~ 500,000     | ×1.5   |
| 500,000 ~ 1,300,000   | ×1.4   |
| 1,300,000 ~ 2,000,000 | ×1.4   |
| > 2,000,000           | ×1.35  |

**範例 (VND 400,000)**:
前 300k × 1.75 + 後 100k × 1.5 = 525,000 + 150,000 = 675,000 → 843.75 NT$

---

## 3. 各品相 NT$ 運費 (SHIP_NTD) — 最新

| 品相 (Category) | 重量估算 | NT$ 運費 |
| --------------- | -------- | -------- |
| Top  上衣       | 0.40 kg  | **130**  |
| Outerwear 外套  | 1.00 kg  | **150**  ← 從 225 調降 |
| Bottom 褲款     | 0.70 kg  | **150**  ← 從 170 調降 |
| Set 套裝        | 1.30 kg  | **200**  ← 從 250 調降 |
| Accessories 配件| 0.20 kg  | **100**  |
| _default 通用   | 0.50 kg  | **100**  |

> ⚠️ **Hoodie / Sweater 注意**: 目前在 `categoryOf()` 邏輯裡 hoodie / sweater 歸類為 **Top** (130),不是 Outerwear (150)。如果你希望 hoodie 也走 150,需另外調整 `categoryOf()` 把 hoodie/sweater 重分類到 Outerwear。

---

## 4. 全品相對照表 (NT$) — 最新運費

### Top 上衣 (運費 NT$ 130)
| VND 越南價  | 親自帶回 NT$ | 國際運送 NT$ | Diff |
| ----------- | ------------ | ------------ | ---- |
|     100,000 |          220 |          350 |  130 |
|     200,000 |          440 |          590 |  150 |
|     300,000 |          660 |          790 |  130 |
|     350,000 |          750 |          890 |  140 |
|     400,000 |          840 |          990 |  150 |
|     500,000 |        1,030 |        1,190 |  160 |
|     600,000 |        1,210 |        1,350 |  140 |
|     750,000 |        1,470 |        1,650 |  180 |
|     900,000 |        1,730 |        1,890 |  160 |
|   1,000,000 |        1,910 |        2,050 |  140 |
|   1,200,000 |        2,260 |        2,390 |  130 |
|   1,500,000 |        2,780 |        2,950 |  170 |
|   1,800,000 |        3,310 |        3,450 |  140 |
|   2,000,000 |        3,660 |        3,790 |  130 |
|   2,500,000 |        4,500 |        4,650 |  150 |

### Outerwear 外套 (運費 NT$ 150)
| VND 越南價  | 親自帶回 NT$ | 國際運送 NT$ | Diff |
| ----------- | ------------ | ------------ | ---- |
|     100,000 |          220 |          390 |  170 |
|     200,000 |          440 |          590 |  150 |
|     300,000 |          660 |          850 |  190 |
|     400,000 |          840 |          990 |  150 |
|     500,000 |        1,030 |        1,190 |  160 |
|     750,000 |        1,470 |        1,650 |  180 |
|   1,000,000 |        1,910 |        2,090 |  180 |
|   1,500,000 |        2,780 |        2,950 |  170 |
|   2,000,000 |        3,660 |        3,850 |  190 |
|   2,500,000 |        4,500 |        4,650 |  150 |

### Bottom 褲款 (運費 NT$ 150) — 與 Outerwear 同表
| VND 越南價  | 親自帶回 NT$ | 國際運送 NT$ | Diff |
| ----------- | ------------ | ------------ | ---- |
|     100,000 |          220 |          390 |  170 |
|     200,000 |          440 |          590 |  150 |
|     300,000 |          660 |          850 |  190 |
|     400,000 |          840 |          990 |  150 |
|     500,000 |        1,030 |        1,190 |  160 |
|     750,000 |        1,470 |        1,650 |  180 |
|   1,000,000 |        1,910 |        2,090 |  180 |
|   1,500,000 |        2,780 |        2,950 |  170 |
|   2,000,000 |        3,660 |        3,850 |  190 |
|   2,500,000 |        4,500 |        4,650 |  150 |

### Set 套裝 (運費 NT$ 200)
| VND 越南價  | 親自帶回 NT$ | 國際運送 NT$ | Diff |
| ----------- | ------------ | ------------ | ---- |
|     100,000 |          220 |          450 |  230 |
|     200,000 |          440 |          650 |  210 |
|     300,000 |          660 |          890 |  230 |
|     400,000 |          840 |        1,050 |  210 |
|     500,000 |        1,030 |        1,250 |  220 |
|     750,000 |        1,470 |        1,690 |  220 |
|   1,000,000 |        1,910 |        2,150 |  240 |
|   1,500,000 |        2,780 |        2,990 |  210 |
|   2,000,000 |        3,660 |        3,890 |  230 |
|   2,500,000 |        4,500 |        4,750 |  250 |

### Accessories 配件 / 帽款 (運費 NT$ 100)
| VND 越南價  | 親自帶回 NT$ | 國際運送 NT$ | Diff |
| ----------- | ------------ | ------------ | ---- |
|     100,000 |          220 |          350 |  130 |
|     200,000 |          440 |          550 |  110 |
|     300,000 |          660 |          790 |  130 |
|     400,000 |          840 |          950 |  110 |
|     500,000 |        1,030 |        1,150 |  120 |
|     750,000 |        1,470 |        1,590 |  120 |
|   1,000,000 |        1,910 |        2,050 |  140 |
|   1,500,000 |        2,780 |        2,890 |  110 |
|   2,000,000 |        3,660 |        3,790 |  130 |
|   2,500,000 |        4,500 |        4,650 |  150 |

### _default 通用 (運費 NT$ 100)
與 Accessories 表完全相同 (運費同 100)。

---

## 5. tuyen 品牌 — Supabase 確認 SQL (修正 column 名稱)

> ❗ 上次出 `column "active" does not exist` (HINT: 應為 `is_active`)。
> 並且 `country` 不一定存在。先用最保險的 schema 探查,再依實際欄位查資料。

到 Supabase Dashboard → SQL Editor 跑這四段:

```sql
-- ⓪ 先看 brands 表有哪些欄位 (一勞永逸,以後 SQL 都對得到)
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'brands'
order by ordinal_position;

-- ① 確認 brands 表裡有沒有 tuyen (只用最低限度欄位)
select id, name
from brands
where id = 'tuyen' or name ilike '%tuyen%' or name ilike '%tuyên%';

-- ② tuyen 品牌的所有商品 + 各自的品相分布
select
  coalesce(p.tag, p.category, '_default') as 品相,
  count(*)                                as 商品數,
  min(p.price_vnd)                        as 最低_VND,
  max(p.price_vnd)                        as 最高_VND
from products p
where p.brand_id = 'tuyen'
group by 1
order by 商品數 desc;

-- ③ tuyen 全部商品逐筆 (套新公式 carry=round10 對照)
select
  p.id,
  p.name,
  coalesce(p.tag, p.category, '_default')                  as 品相,
  p.price_vnd                                              as VND,
  round(
    (
      least(p.price_vnd, 300000)*1.75 +
      greatest(least(p.price_vnd-300000, 200000), 0)*1.5 +
      greatest(least(p.price_vnd-500000, 800000), 0)*1.4 +
      greatest(least(p.price_vnd-1300000, 700000), 0)*1.4 +
      greatest(p.price_vnd-2000000, 0)*1.35
    ) / 800.0 / 10
  ) * 10                                                   as 親自帶回_NTD
from products p
where p.brand_id = 'tuyen'
  and p.price_vnd > 0
order by p.price_vnd;
```

> 跑完 ⓪ 就知道 brands 真正的欄位 (例: `is_active` / `is_visible` / `is_published`...)。
> 之後如果要篩「上架中」,把 ① 改成 `... and is_active = true` 即可。

**本地 repo 已確認** tuyen 是已註冊品牌:
- `scripts/match-config.json`: `"tuyen": { "style": "Streetwear, Casual" }`
- `assets/size-charts-default/tuyen.jpg` 公版尺寸圖存在
- `assets/size-charts-default/README.md`: tuyen 列入 brand-default 通用圖名單 (`hades / mbi / phonchay / tuyen / laneci / dirmior`)

---

## 6. 公式驗證 (新運費 + 拆分結尾規則)

1k ~ 3,000,000 VND 步進 1,000 全範圍掃描:

| 測試項目                                 | 結果                  |
| ---------------------------------------- | --------------------- |
| Carry / Ship 跳水 (drops)                | **0 次** ✓            |
| Ship < Carry 反轉 (inversions)           | **0 次** ✓            |
| 4 個 tier 邊界 (300k / 500k / 1.3M / 2M) | 完全平滑 ✓            |
| 200 NT$ cap                              | 已移除                |
| Top 平均 diff                            | 151.0 (目標 130)      |
| Outerwear 平均 diff                      | 170.9 (目標 150)      |
| Bottom 平均 diff                         | 170.9 (目標 150)      |
| Set 平均 diff                            | 221.0 (目標 200)      |
| Accessories 平均 diff                    | 121.0 (目標 100)      |
| _default 平均 diff                       | 121.0 (目標 100)      |

> 平均 diff 比 SHIP_NTD 目標**多約 20 NT$** 是 carry round-to-10 與 ship psych(50/90) 結尾規則拆分的自然結果。
> 重點: 單調遞增、不會跨界跳水、ship ≥ carry 永遠成立。

---

## 7. 改了哪些檔案 (本次)

| 檔案                 | 區段                       | 修改                                     |
| -------------------- | -------------------------- | ---------------------------------------- |
| main.js              | § 0 SHIP_NTD               | Outerwear 225→150 / Bottom 170→150 / Set 250→200 |
| index.html           | hunt section HUNT_SHIP_NTD | 同步                                     |
| index.html           | `<script src="main.js">`   | 升 v=59                                  |
| admin.html           | FEATURED_SHIP_NTD          | 同步                                     |
| PRICING_REFERENCE.md | § 3, § 4, § 5, § 6, § 7    | 全表、SQL (修正 is_active)、驗證統計同步 |
