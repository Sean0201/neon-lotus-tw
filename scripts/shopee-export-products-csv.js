/**
 * shopee-export-products-csv.js
 * ─────────────────────────────────────────────────────────────────
 * 蝦皮 Open Platform API 目前僅開放商城賣家申請 (2026-09-09 蝦皮客服確認),
 * 非商城賣家無法用 API 自動上架/改價。改用 CSV 半自動化:
 *
 *   1. 跑這支腳本 → 產出 outputs/shopee_products_<日期>.csv
 *   2. 打開蝦皮賣家中心 → 商品管理 → 批次上傳/更新 → 下載蝦皮官方範本
 *   3. 把這支腳本產出的欄位對照貼進蝦皮範本 (欄位名稱蝦皮會依類目而不同,
 *      無法完全自動對齊,需手動貼一次;之後改價可以只複製「蝦皮建議售價」欄)
 *   4. 上傳蝦皮範本完成上架/改價
 *
 * 定價規則: 蝦皮售價 = psychPrice( price_thb_shipping × markup )
 *   markup = products.shopee_markup (單品覆寫) 或 DEFAULT_MARKUP (全站預設 1.08)
 *
 * 使用:
 *   node scripts/shopee-export-products-csv.js
 * ────────────────────────────────────────────────────────────────
 */

import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const DEFAULT_MARKUP = 1.08;
const OUT_DIR = path.join(process.cwd(), "outputs");

function psychPrice(n) {
  if (n == null) return n;
  const r = Math.round(n / 10) * 10;
  const tail = ((r % 100) + 100) % 100;
  if (tail === 0) return r - 10;
  if (tail <= 50) return r - tail + 50;
  return r - tail + 90;
}

function calcShopeePrice(product) {
  const markup = product.shopee_markup || DEFAULT_MARKUP;
  const base = product.price_thb_shipping || product.price_thb_carryback || 0;
  return psychPrice(base * markup);
}

function csvEscape(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsvRow(fields) {
  return fields.map(csvEscape).join(",");
}

async function fetchPilotProducts() {
  const { data, error } = await supabase
    .from("products")
    .select("id, name, brand_id, price_thb_carryback, price_thb_shipping, shopee_enabled, shopee_item_id, shopee_markup, cover_image, is_active")
    .eq("shopee_enabled", true)
    .eq("is_active", true)
    .order("brand_id")
    .order("id");
  if (error) throw error;
  return data || [];
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  NEON LOTUS — 蝦皮商品匯出 CSV (非 API, 給手動批次上傳用)");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const products = await fetchPilotProducts();
  if (products.length === 0) {
    console.log("沒有 shopee_enabled=true 的商品。\n先在 Supabase 把要試跑的商品標記:");
    console.log("  update products set shopee_enabled = true where id in (...);");
    return;
  }

  const headers = ["SKU", "商品名稱", "品牌", "官網國際運送價NT", "蝦皮建議售價NT", "建議庫存", "圖片URL", "蝦皮item_id(已上架才有)"];
  const rows = [toCsvRow(headers)];

  for (const p of products) {
    const shopeePrice = calcShopeePrice(p);
    rows.push(toCsvRow([
      p.id,
      p.name || "",
      p.brand_id || "",
      p.price_thb_shipping ?? "",
      shopeePrice,
      1,
      p.cover_image || "",
      p.shopee_item_id || "",
    ]));
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(OUT_DIR, `shopee_products_${stamp}.csv`);
  fs.writeFileSync(outPath, "\uFEFF" + rows.join("\n"), "utf-8"); // BOM 讓 Excel 開啟中文不亂碼

  console.log(`✅ 已產出 ${products.length} 筆商品 → ${outPath}`);
  console.log("\n下一步: 打開蝦皮賣家中心 → 商品管理 → 批次上傳/更新,下載蝦皮範本,");
  console.log("把這份 CSV 的「蝦皮建議售價」等欄位貼進蝦皮範本對應欄位再上傳。");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
