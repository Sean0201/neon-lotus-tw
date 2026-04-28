# 公版尺寸表 (Brand-Default Size Charts)

當品牌沒有為每件商品提供獨立尺寸表 (公版尺寸表),
請把該品牌的尺寸表圖片上傳到此資料夾,檔名規則:

```
<brand_id>.<ext>
```

支援格式: `.png`, `.jpg`, `.jpeg`, `.webp`

## 已設定品牌

| Supabase brand_id | 檔案路徑 | 備註 |
|---|---|---|
| `hades` | `hades.jpg` | 官網無尺寸表 |
| `tuyen` | `tuyen.jpg` | 官網無尺寸表 |
| `laneci` | `laneci.jpg` | 官網無尺寸表 |
| `intoeight` | `intoeight.jpg` | 蝦皮 — 個別 size guide 抓取困難 |
| `offonoff-club` | `offonoff-club.jpg` | 蝦皮 |
| `blish` | `blish.jpg` | 蝦皮 |
| `tryst` | `tryst.jpg` | 蝦皮 |
| `phonchay` | `phonchay.jpg` | 蝦皮 |
| `niyu` | `niyu.jpg` | 蝦皮 |
| `lizardman` | `lizardman.jpg` | 蝦皮 |

## 使用流程

1. 把尺寸表圖片放到此資料夾,檔名跟 `match-config.json` 的 `brand_defaults` 設定一致
2. 跑 `node scripts/match-sizes-to-supabase.js` 重新生成 overlay
3. Bump `index.html` 的 `data-overlay.js?v=N` 版本
4. Commit + push

## 邏輯

`data-overlay-loader.js` 在 patch 商品 `size_chart` 時的優先順序:

1. **Exact name match** — `by_name[brand_id].size_charts[product_name]`
2. **Same category fallback** — `by_name[brand_id].size_charts_by_category[category]`
3. **Brand default (公版)** — `brand_defaults[brand_id]` ← 此資料夾的圖片

只要產品名稱不是配件 (cap/beanie/bag/belt 等),都會 fallback 到公版圖。
