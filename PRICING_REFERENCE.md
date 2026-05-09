# NEON LOTUS TW — 定價對照表 (NT$ 平加運費版本)

> 更新日期: 2026-05-09 (v4 — 中價段倍率上調)
> 公式版本: NT$ flat-shipping + 拆分結尾規則 (carry=round10 / ship=psych v2)
> 同步檔案: `main.js` § 0/§ 2  /  `index.html` `calcHuntPrice()`  /  `admin.html` `_featuredCalc()`

---

## 1. 公式總覽

```
親自帶回 NT$  =  round10( marginalAdjVnd(VND) ÷ 800 )                    ← 四捨五入到 10
國際運送 NT$  =  psychPrice( marginalAdjVnd(VND) ÷ 800 + SHIP_NTD[品相] ) ← 50/90 v2
```

**psychPrice v2 規則** (沿用):
- 結尾 **01–50** → `xx50`   (例 2230 → 2250)
- 結尾 **51–99** → `xx90`   (例 2270 → 2290)
- 結尾 **00**    → `(xx-1)90`(例 **2800 → 2790**)

---

## 2. 累進倍率 TIERS (v4 — 中價段微調)

| VND 區間              | 倍率   | v3 倍率 | 變化       |
| --------------------- | ------ | ------- | ---------- |
| 0 ~ 300,000           | ×1.75  | 1.75    | 不變       |
| 300,000 ~ 500,000     | **×1.65** | 1.5  | **+0.15** ↑|
| 500,000 ~ 1,300,000   | **×1.5**  | 1.4  | **+0.10** ↑|
| 1,300,000 ~ 2,000,000 | ×1.4   | 1.4     | 不變       |
| > 2,000,000           | ×1.35  | 1.35    | 不變       |

**v4 變更動機**: 中價位商品 (30萬-130萬 VND) 利潤偏低,微調讓中段曲線更合理。低價段 (<30萬) 與高價段 (>130萬) 維持不變。

---

## 3. 各品相 NT$ 運費 (SHIP_NTD)

| 品相 (Category) | 重量估算 | NT$ 運費 | 包含商品 |
| --------------- | -------- | -------- | -------- |
| Top  上衣       | 0.40 kg  | **130**  | T恤 / 襯衫 / Polo / Tank / 長袖 |
| Outerwear 外套  | 1.00 kg  | **150**  | Jacket / Coat / Parka / Hoodie / Sweater |
| Bottom 褲款     | 0.70 kg  | **150**  | Pants / Jeans / Shorts / Skirts |
| Set 套裝        | 1.30 kg  | **200**  | 套裝 / 兩件式 |
| Accessories 配件| 0.20 kg  | **100**  | Cap / Bag / Belt / Jewelry |
| _default 通用   | 0.50 kg  | **100**  | 其他 |

---

## 4. 全品相對照表 (NT$) — v4 倍率 + psych v2

### Top 上衣 (運費 NT$ 130)
| VND 越南價  | 親自帶回 NT$ | 國際運送 NT$ | Diff |
| ----------- | ------------ | ------------ | ---- |
|     100,000 |          220 |          350 |  130 |
|     200,000 |          440 |          590 |  150 |
|     300,000 |          660 |          790 |  130 |
|     350,000 |          760 |          890 |  130 |
|     400,000 |          860 |          990 |  130 |
|     500,000 |        1,070 |        1,190 |  120 |
|     600,000 |        1,260 |        1,390 |  130 |
|     750,000 |        1,540 |        1,690 |  150 |
|     900,000 |        1,820 |        1,950 |  130 |
|   1,000,000 |        2,010 |        2,150 |  140 |
|   1,200,000 |        2,380 |        2,550 |  170 |
|   1,500,000 |        2,920 |        3,050 |  130 |
|   1,800,000 |        3,440 |        3,590 |  150 |
|   2,000,000 |        3,790 |        3,950 |  160 |
|   2,500,000 |        4,640 |        4,790 |  150 |

### Outerwear 外套 + Hoodie/Sweater (運費 NT$ 150)
### Bottom 褲款 (運費 NT$ 150) — 與 Outerwear 同表
| VND 越南價  | 親自帶回 NT$ | 國際運送 NT$ | Diff |
| ----------- | ------------ | ------------ | ---- |
|     100,000 |          220 |          390 |  170 |
|     200,000 |          440 |          590 |  150 |
|     300,000 |          660 |          850 |  190 |
|     400,000 |          860 |        1,050 |  190 |
|     500,000 |        1,070 |        1,250 |  180 |
|     750,000 |        1,540 |        1,690 |  150 |
|   1,000,000 |        2,010 |        2,190 |  180 |
|   1,500,000 |        2,920 |        3,090 |  170 |
|   2,000,000 |        3,790 |        3,950 |  160 |
|   2,500,000 |        4,640 |        4,790 |  150 |

### Set 套裝 (運費 NT$ 200)
| VND 越南價  | 親自帶回 NT$ | 國際運送 NT$ | Diff |
| ----------- | ------------ | ------------ | ---- |
|     100,000 |          220 |          450 |  230 |
|     200,000 |          440 |          650 |  210 |
|     300,000 |          660 |          890 |  230 |
|     400,000 |          860 |        1,090 |  230 |
|     500,000 |        1,070 |        1,290 |  220 |
|     750,000 |        1,540 |        1,750 |  210 |
|   1,000,000 |        2,010 |        2,250 |  240 |
|   1,500,000 |        2,920 |        3,150 |  230 |
|   2,000,000 |        3,790 |        3,990 |  200 |
|   2,500,000 |        4,640 |        4,850 |  210 |

### Accessories 配件 / 帽款 (運費 NT$ 100)
| VND 越南價  | 親自帶回 NT$ | 國際運送 NT$ | Diff |
| ----------- | ------------ | ------------ | ---- |
|     100,000 |          220 |          350 |  130 |
|     200,000 |          440 |          550 |  110 |
|     300,000 |          660 |          790 |  130 |
|     400,000 |          860 |          990 |  130 |
|     500,000 |        1,070 |        1,190 |  120 |
|     750,000 |        1,540 |        1,650 |  110 |
|   1,000,000 |        2,010 |        2,150 |  140 |
|   1,500,000 |        2,920 |        3,050 |  130 |
|   2,000,000 |        3,790 |        3,890 |  100 |
|   2,500,000 |        4,640 |        4,750 |  110 |

### _default 通用 (運費 NT$ 100)
與 Accessories 表完全相同。

---

## 5. v3 → v4 漲幅範例 (Top 上衣)

| VND       | v3 親帶 | **v4 親帶** | 親帶差 | v3 國際 | **v4 國際** | 國際差 |
| --------- | ------- | ----------- | ------ | ------- | ----------- | ------ |
| ≤ 300,000 | (不變)  | (不變)      | +0     | (不變)  | (不變)      | +0     |
| 350,000   | 750     | **760**     | +10    | 890     | 890         | +0     |
| 400,000   | 840     | **860**     | +20    | 990     | 990         | +0     |
| 500,000   | 1,030   | **1,070**   | +40    | 1,190   | 1,190       | +0     |
| 600,000   | 1,210   | **1,260**   | +50    | 1,350   | **1,390**   | +40    |
| 750,000   | 1,470   | **1,540**   | +70    | 1,590   | **1,690**   | +100   |
| 1,000,000 | 1,910   | **2,010**   | +100   | 2,050   | **2,150**   | +100   |
| 1,500,000 | 2,780   | **2,920**   | +140   | 2,950   | **3,050**   | +100   |
| 2,000,000 | 3,660   | **3,790**   | +130   | 3,790   | **3,950**   | +160   |

> **影響範圍**: 30萬 VND 以下完全不變,30萬-130萬 VND 微幅上漲,130萬 VND 以上累積上漲約 130-160 NT$。

---

## 6. tuyen 品牌 + Hoodie 重分類 SQL

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

---

## 7. 改了哪些檔案 (本次 v4)

| 檔案                 | 區段                                | 修改                                         |
| -------------------- | ----------------------------------- | -------------------------------------------- |
| main.js              | TIERS                               | 30-50萬 1.5→1.65, 50-130萬 1.4→1.5           |
| index.html           | HUNT_TIERS                          | 同上,獵物雷達同步                            |
| index.html           | `<script src="main.js">`            | v=61 → **v=62** cache bust                   |
| admin.html           | FEATURED_TIERS                      | 同上,管理後台精選計算同步                    |
| PRICING_REFERENCE.md | § 1, § 2, § 4, § 5, § 7             | 全表、漲幅範例、改檔清單同步                 |
