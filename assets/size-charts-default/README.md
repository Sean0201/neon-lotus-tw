# 公版尺寸表 (Brand-Default Size Charts)

當品牌沒有為每件商品提供獨立尺寸表 (公版尺寸表),
請把該品牌的尺寸表圖片上傳到此資料夾,檔名規則:

```
<brand_id>.<ext>
```

支援格式: `.png`, `.jpg`, `.jpeg`, `.webp`

## 已設定品牌

| Supabase brand_id | 檔案路徑 |
|---|---|
| `hades` | `hades.png` 或 `hades.jpg` |
| `tuyen` | `tuyen.png` 或 `tuyen.jpg` |
| `laneci` | `laneci.png` 或 `laneci.jpg` |

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
