# NEON LOTUS TW — 定價對照表 (NT$ 平加運費版本)

> 更新日期: 2026-05-05 (v3 — psych v2 rule + hoodie reclassify)
> 公式版本: NT$ flat-shipping + 拆分結尾規則 (carry=round10 / ship=psych v2)
> 同步檔案: `main.js` § 0/§ 2  /  `index.html` `calcHuntPrice()`  /  `admin.html` `_featuredCalc()`

---

## 1. 公式總覽

```
親自帶回 NT$  =  round10( marginalAdjVnd(VND) ÷ 800 )                    ← 四捨五入到 10
國際運送 NT$  =  psychPrice( marginalAdjVnd(VND) ÷ 800 + SHIP_NTD[品相] ) ← 50/90 v2
```

**psychPrice v2 規則** (本次調整):
- 結尾 **01–50** → `xx50`   (例 2230 → 2250)
- 結尾 **51–99** → `xx90`   (例 2270 → 2290)
- 結尾 **00**    → `(xx-1)90` ← **新**: 整百數歸到上一百的 90 (例 **2800 → 2790**)

之前 v1 版本的整百 (00 結尾) 會被歸到同一百的 50 (例 2800 → 2850),v2 改成歸到上一百的 90,賣相比 X850 更乾淨。

---

## 2. 累進倍率 TIERS (不變)

| VND 區間              | 倍率   |
| --------------------- | ------ |
| 0 ~ 300,000           | ×1.75  |
| 300,000 ~ 500,000     | ×1.5   |
| 500,000 ~ 1,300,000   | ×1.4   |
| 1,300,000 ~ 2,000,000 | ×1.4   |
| > 2,000,000           | ×1.35  |

---

## 3. 各品相 NT$ 運費 (SHIP_NTD)

| 品相 (Category) | 重量估算 | NT$ 運費 | 包含商品 |
| --------------- | -------- | -------- | -------- |
| Top  上衣       | 0.40 kg  | **130**  | T恤 / 襯衫 / Polo / Tank / 長袖 |
| Outerwear 外套  | 1.00 kg  | **150**  | Jacket / Coat / Parka / **Hoodie** / **Sweater** ← 新加入 |
| Bottom 褲款     | 0.70 kg  | **150**  | Pants / Jeans / Shorts / Skirts |
| Set 套裝        | 1.30 kg  | **200**  | 套裝 / 兩件式 |
| Accessories 配件| 0.20 kg  | **100**  | Cap / Bag / Belt / Jewelry |
| _default 通用   | 0.50 kg  | **100**  | 其他 |

**Hoodie / Sweater 重新分類**:
- UI 端: `index.html` 獵物雷達 dropdown 已調整,從「Top」移到「Outerwear」
- DB 端: 既有產品的 `tag` 仍是 `Top`,需跑下方 SQL 一次性遷移

---

## 4. 全品相對照表 (NT$) — psych v2

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
|     750,000 |        1,470 |        1,590 |  120 |
|     900,000 |        1,730 |        1,890 |  160 |
|   1,000,000 |        1,910 |        2,050 |  140 |
|   1,200,000 |        2,260 |        2,390 |  130 |
|   1,500,000 |        2,780 |        2,950 |  170 |
|   1,800,000 |        3,310 |        3,450 |  140 |
|   2,000,000 |        3,660 |        3,790 |  130 |
|   2,500,000 |        4,500 |        4,650 |  150 |

### Outerwear 外套 + Hoodie/Sweater (運費 NT$ 150)
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
|   2,500,000 |        4,500 |        4,690 |  190 |

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
|   2,500,000 |        4,500 |        4,590 |   90 |

### _default 通用 (運費 NT$ 100)
與 Accessories 表完全相同。

---

## 5. tuyen 品牌 + Hoodie 重分類 SQL

到 Supabase Dashboard → SQL Editor 跑這幾段:

```sql
-- ⓪ 先看 brands / products 兩張表的欄位
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name in ('brands', 'products')
order by table_name, ordinal_position;

-- ① 確認 brands 表裡有沒有 tuyen
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
```

### Hoodie / Sweater 從 Top → Outerwear 一次遷移

> ⚠️ **先 dry-run** (先看會影響哪些商品),確認沒問題再跑 UPDATE。

```sql
-- ③ Dry-run: 看哪些 Top 商品名稱含 hoodie / sweater 字眼
select id, brand_id, name, tag, price_vnd
from products
where tag = 'Top'
  and (
    name ilike '%hoodie%' or name ilike '%hood%' or
    name ilike '%sweat%'  or name ilike '%sweater%' or name ilike '%sweatshirt%' or
    name ilike '%jumper%' or name ilike '%knit%'    or name ilike '%cardigan%' or
    name ilike '%crewneck%'
  )
order by brand_id, name;

-- ④ 確認無誤後執行 (把上面 select 換成 update)
update products
set tag = 'Outerwear'
where tag = 'Top'
  and (
    name ilike '%hoodie%' or name ilike '%hood%' or
    name ilike '%sweat%'  or name ilike '%sweater%' or name ilike '%sweatshirt%' or
    name ilike '%jumper%' or name ilike '%knit%'    or name ilike '%cardigan%' or
    name ilike '%crewneck%'
  );

-- ⑤ 驗證: 跑完後 Top / Outerwear 各有多少
select tag, count(*) from products group by tag order by tag;
```

> **比對清單**: 上面的關鍵字是 `data-overlay-loader.js` 裡 `categoryOf()` 真實使用的 hoodie/sweater 詞庫。

**本地 repo 已確認** tuyen 是已註冊品牌:
- `scripts/match-config.json`: `"tuyen": { "style": "Streetwear, Casual" }`
- `assets/size-charts-default/tuyen.jpg` 公版尺寸圖存在

---

## 6. 公式驗證 (psych v2 規則)

1k ~ 3,000,000 VND 步進 1,000 全範圍掃描:

| 測試項目                                 | 結果                  |
| ---------------------------------------- | --------------------- |
| Carry / Ship 跳水 (drops)                | **0 次** ✓            |
| Ship < Carry 反轉 (inversions)           | **0 次** ✓            |
| 4 個 tier 邊界 (300k / 500k / 1.3M / 2M) | 完全平滑 ✓            |
| 使用者指定 case: 2800 → 2790             | ✓                     |
| Top 平均 diff                            | 145.0 (目標 130)      |
| Outerwear 平均 diff                      | 165.0 (目標 150)      |
| Bottom 平均 diff                         | 165.0 (目標 150)      |
| Set 平均 diff                            | 215.0 (目標 200)      |
| Accessories 平均 diff                    | 115.0 (目標 100)      |
| _default 平均 diff                       | 115.0 (目標 100)      |

> v2 規則讓平均 diff 從 v1 的 +20 NT$ 偏移降到 +15 NT$ — 整百 (00 結尾) 改判到上一百的 90 後,部分案例 ship 直接降 60 NT$,客戶看到的價格更友善。
> 重點仍然是: 單調遞增、不會跨界跳水、ship ≥ carry 永遠成立。

---

## 7. 改了哪些檔案 (本次 v3)

| 檔案                 | 區段                                | 修改                                         |
| -------------------- | ----------------------------------- | -------------------------------------------- |
| main.js              | psychPrice                          | v1 → v2 規則 (00 結尾改判上一百 90)          |
| main.js              | § 0 SHIP_NTD 註解                   | Hoodie/Sweater 從 Top 註解移到 Outerwear     |
| index.html           | _huntPsych                          | v2 規則同步                                  |
| index.html           | huntCategory dropdown               | Top label 改 (Tee/Shirt/Polo) + Outerwear 加 (Jacket/Hoodie/Sweater) |
| index.html           | `<script src="main.js">`            | 升 v=60 cache bust                           |
| admin.html           | _featuredPsych                      | v2 規則同步                                  |
| PRICING_REFERENCE.md | § 1, § 3, § 4, § 5, § 6, § 7        | 全表、SQL (含 hoodie 遷移)、驗證統計同步     |
