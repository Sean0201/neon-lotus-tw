/**
 * shopee-import-orders-csv.js
 * ─────────────────────────────────────────────────────────────────
 * 蝦皮 Open Platform API 目前僅開放商城賣家申請,非商城賣家無法用 API
 * 自動拉訂單。改用 CSV 半自動化:
 *
 *   1. 蝦皮賣家中心 → 訂單管理 → 匯出訂單報表 (CSV),下載到本機
 *   2. 跑這支腳本讀那份 CSV,寫進 Supabase orders/order_items (channel='shopee')
 *   3. admin.html 的「成本利潤表」匯出會自動把這些訂單併進月報表
 *
 * 用 channel_order_sn (蝦皮訂單編號) 防止重複匯入,同一份 CSV 重跑不會出錯。
 *
 * ⚠️ 蝦皮匯出的 CSV 欄位名稱可能因帳號/地區而略有不同。這支腳本用「別名清單」
 *    (見下方 FIELD_ALIASES) 嘗試自動對應,對不到必要欄位時會印出這份 CSV 實際
 *    的欄位名稱並中止,把印出的欄位名稱回報給 Sean 調整對照表即可。
 *
 * 使用:
 *   node scripts/shopee-import-orders-csv.js --file=~/Downloads/order.csv          # 預覽
 *   node scripts/shopee-import-orders-csv.js --file=~/Downloads/order.csv --apply  # 寫入
 * ────────────────────────────────────────────────────────────────
 */

import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import os from "os";
import path from "path";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── 欄位別名對照 (依實際蝦皮匯出 CSV 調整) ───────────────────────
const FIELD_ALIASES = {
  order_sn: ["訂單編號", "訂單號", "order sn", "order_sn"],
  status: ["訂單狀態", "狀態", "order status"],
  buyer: ["買家帳號", "買家用戶名", "買家", "username", "buyer username"],
  product_name: ["商品名稱", "商品名", "product name"],
  variation: ["商品選項", "規格", "商品規格", "variation"],
  qty: ["數量", "購買數量", "quantity"],
  unit_price: ["商品成交價", "商品成交單價", "成交價", "單價", "商品原價"],
  sku: ["商品貨號", "賣家商品貨號", "貨號", "sku", "seller sku"],
  create_time: ["訂單成立時間", "下單時間", "建立時間", "create time"],
};

function normalizeHeader(h) {
  return String(h || "").replace(/\uFEFF/g, "").trim().toLowerCase();
}

function buildHeaderMap(headers) {
  const norm = headers.map(normalizeHeader);
  const map = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const idx = norm.findIndex((h) => aliases.some((a) => normalizeHeader(a) === h));
    if (idx !== -1) map[field] = idx;
  }
  return map;
}

// 簡易 CSV parser: 處理逗號分隔 + 雙引號包欄位 (含逗號/換行/跳脫雙引號)
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, "");

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); field = "";
      rows.push(row); row = [];
    } else if (c === "\r") {
      // skip, \n handles the line break
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function mapShopeeStatus(status) {
  const s = String(status || "").trim();
  const map = {
    "待付款": "pending", "未付款": "pending",
    "待出貨": "approved", "備貨中": "approved", "處理中": "approved",
    "運送中": "shipped", "已出貨": "shipped",
    "已完成": "completed", "交易成功": "completed",
    "已取消": "cancelled", "取消": "cancelled",
  };
  return map[s] || "pending";
}

function parseArgs(argv) {
  const opts = { apply: false, file: null };
  for (const a of argv.slice(2)) {
    if (a === "--apply") opts.apply = true;
    else if (a.startsWith("--file=")) opts.file = a.slice(7);
  }
  if (opts.file && opts.file.startsWith("~")) opts.file = path.join(os.homedir(), opts.file.slice(1));
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.file) {
    console.error("用法: node scripts/shopee-import-orders-csv.js --file=<蝦皮訂單CSV路徑> [--apply]");
    process.exit(1);
  }
  if (!fs.existsSync(opts.file)) {
    console.error(`❌ 找不到檔案: ${opts.file}`);
    process.exit(1);
  }

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  NEON LOTUS — 蝦皮訂單 CSV 匯入 (非 API)");
  console.log("  Mode:", opts.apply ? "🔥 APPLY (會寫入 Supabase)" : "🔍 DRY-RUN (只預覽)");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const raw = fs.readFileSync(opts.file, "utf-8");
  const rows = parseCsv(raw);
  if (rows.length < 2) { console.log("CSV 沒有資料列。"); return; }

  const headers = rows[0];
  const headerMap = buildHeaderMap(headers);

  const required = ["order_sn", "product_name", "qty"];
  const missing = required.filter((f) => headerMap[f] === undefined);
  if (missing.length > 0) {
    console.error(`❌ 對不到必要欄位: ${missing.join(", ")}`);
    console.error("\n這份 CSV 實際的欄位名稱是:");
    headers.forEach((h, i) => console.error(`  [${i}] ${h}`));
    console.error("\n請把上面這份欄位清單回報,調整 shopee-import-orders-csv.js 的 FIELD_ALIASES。");
    process.exit(1);
  }

  const get = (row, field) => (headerMap[field] !== undefined ? row[headerMap[field]] : "");

  // 依 order_sn 分組 (蝦皮訂單匯出通常一個品項一列)
  const ordersBySn = new Map();
  for (const row of rows.slice(1)) {
    const sn = (get(row, "order_sn") || "").trim();
    if (!sn) continue;
    if (!ordersBySn.has(sn)) {
      ordersBySn.set(sn, {
        order_sn: sn,
        status: get(row, "status"),
        buyer: get(row, "buyer"),
        create_time: get(row, "create_time"),
        items: [],
      });
    }
    ordersBySn.get(sn).items.push({
      product_name: get(row, "product_name"),
      variation: get(row, "variation"),
      qty: parseInt(get(row, "qty"), 10) || 1,
      unit_price: parseFloat(String(get(row, "unit_price")).replace(/[^0-9.]/g, "")) || 0,
      sku: get(row, "sku"),
    });
  }

  console.log(`CSV 內共 ${ordersBySn.size} 筆訂單 (${rows.length - 1} 個品項列)\n`);

  // 查已匯入過的 order_sn,避免重複
  const allSns = [...ordersBySn.keys()];
  const { data: existing } = await supabase
    .from("orders")
    .select("channel_order_sn")
    .eq("channel", "shopee")
    .in("channel_order_sn", allSns);
  const existingSns = new Set((existing || []).map((r) => r.channel_order_sn));

  const newOrders = [...ordersBySn.values()].filter((o) => !existingSns.has(o.order_sn));
  console.log(`新訂單 (尚未匯入): ${newOrders.length} 筆 (略過 ${ordersBySn.size - newOrders.length} 筆重複)\n`);

  if (newOrders.length === 0) { console.log("沒有新訂單需要匯入。"); return; }

  console.log("┌────────────────────┬──────────────┬──────────┐");
  console.log("│ order_sn            │ 狀態         │ 品項數   │");
  console.log("├────────────────────┼──────────────┼──────────┤");
  for (const o of newOrders.slice(0, 50)) {
    console.log(`│ ${String(o.order_sn).padEnd(20)} │ ${String(o.status || "").padEnd(12)} │ ${String(o.items.length).padStart(8)} │`);
  }
  if (newOrders.length > 50) console.log(`│ ... 還有 ${newOrders.length - 50} 筆 ...`);
  console.log("└────────────────────┴──────────────┴──────────┘\n");

  if (!opts.apply) {
    console.log("🔍 DRY-RUN — 沒有寫入 Supabase。加 --apply 才會真的匯入。");
    return;
  }

  // 用商品 SKU (蝦皮上架時填的貨號 = products.id) 反查商品,補 product_id/brand_id
  const skus = [...new Set(newOrders.flatMap((o) => o.items.map((it) => it.sku).filter(Boolean)))];
  const { data: matchedProducts } = skus.length
    ? await supabase.from("products").select("id, name, brand_id").in("id", skus)
    : { data: [] };
  const productById = Object.fromEntries((matchedProducts || []).map((p) => [p.id, p]));

  let ok = 0, failed = 0;
  for (const o of newOrders) {
    try {
      const subtotal = o.items.reduce((s, it) => s + it.unit_price * it.qty, 0);

      const { data: orderData, error: orderError } = await supabase
        .from("orders")
        .insert([{
          order_number: o.order_sn,
          channel: "shopee",
          channel_order_sn: o.order_sn,
          customer_name: o.buyer || "",
          customer_phone: "",
          customer_email: "",
          customer_address: "",
          shipping_method: "蝦皮物流",
          payment_method: "蝦皮金流",
          status: mapShopeeStatus(o.status),
          subtotal,
          shipping_fee: 0,
          total: subtotal,
          note: "",
          line_notified: false,
        }])
        .select();

      if (orderError) throw orderError;
      const orderId = orderData[0].id;

      const orderItems = o.items.map((it) => {
        const prod = productById[it.sku];
        return {
          order_id: orderId,
          product_id: prod?.id || null,
          product_name: prod?.name || it.product_name || "",
          brand_id: prod?.brand_id || null,
          size: it.variation || "",
          quantity: it.qty,
          unit_price: it.unit_price,
          image_url: "",
          is_promo: false,
          channel_item_id: it.sku || null,
        };
      });

      const { error: itemsError } = await supabase.from("order_items").insert(orderItems);
      if (itemsError) throw itemsError;

      console.log(`  ✅ ${o.order_sn} 匯入完成 (${orderItems.length} 品項)`);
      ok++;
    } catch (e) {
      console.error(`  ❌ ${o.order_sn}:`, e.message);
      failed++;
    }
  }
  console.log(`\n完成: ${ok} 成功, ${failed} 失敗`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
