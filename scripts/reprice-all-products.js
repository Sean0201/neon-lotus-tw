/**
 * reprice-all-products.js
 * ─────────────────────────────────────────────────────────────────
 * 全站既有商品 重新計價 (v5 公式) — Sean 2026-06-30
 *
 *   背景: v5 倍率 (-0.1) + 匯率 (800→790) 上線時,只套用到新進貨。
 *         既有 DB 商品仍是舊倍率/匯率算出的售價。
 *         此腳本掃描所有商品,用 main.js 的 v5 公式重算:
 *           - price_thb_carryback (親自帶回 NT$)
 *           - price_thb_shipping  (國際運送 NT$)
 *
 *   保護:
 *     • is_promo = true 的商品 ── 跳過 (廠商指定特價,不可動)
 *     • --dry-run 預設先預覽
 *     • 沒指定 --apply 時等同 dry-run (再加一層保險)
 *
 *   使用:
 *     node scripts/reprice-all-products.js                # 預覽 (dry-run)
 *     node scripts/reprice-all-products.js --dry-run      # 同上
 *     node scripts/reprice-all-products.js --apply        # 真寫入
 *     node scripts/reprice-all-products.js --apply --limit=50
 *
 *   公式同步來源: main.js §0-§2 (RATE, TIERS, SHIP_NTD, marginalAdjVnd, psychPrice, calcPrice)
 * ────────────────────────────────────────────────────────────────
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ═══════════════════════════════════════════════════════════════
   § PRICING ENGINE — keep in sync with main.js §0-§2 (v5)
   ═══════════════════════════════════════════════════════════════ */

const RATE = 1 / 790; // 1 TWD = 790 VND (v5)

const SHIP_NTD = {
  Top: 130,
  Outerwear: 150,
  Bottom: 150,
  Set: 200,
  Accessories: 100,
  _default: 100,
};

// v5 marginal multipliers (-0.1 from v4)
const TIERS = [
  { max: 300_000, mult: 1.65 },
  { max: 500_000, mult: 1.55 },
  { max: 1_300_000, mult: 1.4 },
  { max: 2_000_000, mult: 1.3 },
  { max: Infinity, mult: 1.25 },
];

function marginalAdjVnd(vnd) {
  if (!vnd || vnd <= 0) return 0;
  let total = 0;
  let prev = 0;
  for (const { max, mult } of TIERS) {
    if (vnd <= max) {
      total += (vnd - prev) * mult;
      return total;
    }
    total += (max - prev) * mult;
    prev = max;
  }
  return total;
}

function psychPrice(n) {
  if (n == null) return n;
  const r = Math.round(n / 10) * 10;
  const tail = ((r % 100) + 100) % 100;
  if (tail === 0) return r - 10;
  if (tail <= 50) return r - tail + 50;
  return r - tail + 90;
}

// Map tag/category to SHIP_NTD bucket
function resolveShipBucket(tag, category) {
  // Prefer `tag` (the new field), fall back to `category`
  const key = (tag || category || "").trim();
  if (!key) return "_default";

  // Direct match (Top, Outerwear, Bottom, Set, Accessories)
  if (SHIP_NTD[key] != null) return key;

  // Loose mapping from category labels → SHIP buckets
  const upper = key.toUpperCase();
  if (["TOP", "TOPS", "TEE", "TEES", "SHIRT", "SHIRTS", "POLO", "POLOS",
       "TANK", "TANKS", "SWEATER", "SWEATERS", "JERSEY", "JERSEYS",
       "LONGSLEEVE", "LONGSLEEVES"].includes(upper)) return "Top";
  if (["OUTERWEAR", "JACKET", "JACKETS", "HOODIE", "HOODIES",
       "COAT", "COATS", "PARKA"].includes(upper)) return "Outerwear";
  if (["BOTTOM", "BOTTOMS", "PANT", "PANTS", "JEAN", "JEANS",
       "SHORT", "SHORTS", "SKIRT", "SKIRTS", "DRESS", "DRESSES"].includes(upper)) return "Bottom";
  if (["SET", "SETS"].includes(upper)) return "Set";
  if (["ACCESSORY", "ACCESSORIES", "BAG", "BAGS", "CAP", "CAPS",
       "FOOTWEAR", "SHOE", "SHOES", "UNDERWEAR"].includes(upper)) return "Accessories";

  return "_default";
}

function calcPrice(vnd, tag, category) {
  const bucket = resolveShipBucket(tag, category);
  const ship_ntd = SHIP_NTD[bucket];
  const base_ntd = marginalAdjVnd(vnd) * RATE;
  const twd_carryback = Math.round(base_ntd / 10) * 10;
  const twd_shipping = psychPrice(base_ntd + ship_ntd);
  return { twd_shipping, twd_carryback, bucket };
}

/* ═══════════════════════════════════════════════════════════════
   § BATCH FETCH (paginated)
   ═══════════════════════════════════════════════════════════════ */

async function fetchAllProducts() {
  let all = [];
  let page = 0;
  const PAGE_SIZE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("products")
      .select("id, name, price_vnd, tag, category, is_promo, price_thb_carryback, price_thb_shipping, brand_id")
      .order("brand_id")
      .order("id")
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (error) {
      console.error("❌ Fetch error:", error);
      process.exit(1);
    }
    all = all.concat(data);
    if (data.length < PAGE_SIZE) break;
    page++;
  }
  return all;
}

/* ═══════════════════════════════════════════════════════════════
   § MAIN
   ═══════════════════════════════════════════════════════════════ */

function parseArgs(argv) {
  const opts = { apply: false, dryRun: true, limit: null };
  for (const a of argv.slice(2)) {
    if (a === "--apply") { opts.apply = true; opts.dryRun = false; }
    else if (a === "--dry-run") { opts.dryRun = true; opts.apply = false; }
    else if (a.startsWith("--limit=")) opts.limit = parseInt(a.slice(8), 10) || null;
  }
  return opts;
}

function fmt(n) {
  if (n == null) return "    -";
  return String(n).padStart(5);
}

async function main() {
  const opts = parseArgs(process.argv);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  NEON LOTUS — Reprice All Products (v5 公式)");
  console.log("  Mode:", opts.apply ? "🔥 APPLY (will WRITE to DB)" : "🔍 DRY-RUN (no writes)");
  if (opts.limit) console.log("  Limit:", opts.limit);
  console.log("═══════════════════════════════════════════════════════════════\n");

  console.log("Fetching products from Supabase...");
  const products = await fetchAllProducts();
  console.log(`  Total: ${products.length} products\n`);

  const diffs = [];
  let skippedPromo = 0;
  let skippedNoVnd = 0;
  let unchanged = 0;

  for (const p of products) {
    if (p.is_promo === true) { skippedPromo++; continue; }
    if (!p.price_vnd || p.price_vnd <= 0) { skippedNoVnd++; continue; }

    const { twd_carryback, twd_shipping, bucket } = calcPrice(p.price_vnd, p.tag, p.category);
    const oldCB = p.price_thb_carryback;
    const oldSH = p.price_thb_shipping;

    if (oldCB === twd_carryback && oldSH === twd_shipping) {
      unchanged++;
      continue;
    }

    diffs.push({
      id: p.id,
      name: (p.name || "").slice(0, 32),
      vnd: p.price_vnd,
      bucket,
      oldCB, newCB: twd_carryback, deltaCB: (twd_carryback ?? 0) - (oldCB ?? 0),
      oldSH, newSH: twd_shipping,  deltaSH: (twd_shipping ?? 0)  - (oldSH ?? 0),
    });
  }

  // Sort by largest absolute price change first (shipping)
  diffs.sort((a, b) => Math.abs(b.deltaSH) - Math.abs(a.deltaSH));

  const preview = opts.limit ? diffs.slice(0, opts.limit) : diffs;

  console.log("┌─────────┬──────────────────────────────────┬──────────┬─────────┬──────────────────────────┬──────────────────────────┐");
  console.log("│  ID     │ Name                             │ VND      │ Bucket  │ Carryback (舊→新 Δ)      │ Shipping  (舊→新 Δ)      │");
  console.log("├─────────┼──────────────────────────────────┼──────────┼─────────┼──────────────────────────┼──────────────────────────┤");
  for (const d of preview.slice(0, 80)) {
    const idShort = String(d.id).slice(0, 7).padEnd(7);
    const nm = d.name.padEnd(32);
    const vnd = String(d.vnd).padStart(8);
    const bucket = d.bucket.padEnd(7);
    const cbSign = d.deltaCB > 0 ? "+" : (d.deltaCB < 0 ? "" : " ");
    const shSign = d.deltaSH > 0 ? "+" : (d.deltaSH < 0 ? "" : " ");
    const cbCell = `${fmt(d.oldCB)} → ${fmt(d.newCB)} (${cbSign}${d.deltaCB})`.padEnd(24);
    const shCell = `${fmt(d.oldSH)} → ${fmt(d.newSH)} (${shSign}${d.deltaSH})`.padEnd(24);
    console.log(`│ ${idShort} │ ${nm} │ ${vnd} │ ${bucket} │ ${cbCell} │ ${shCell} │`);
  }
  if (preview.length > 80) {
    console.log(`│ ... ${preview.length - 80} more rows (use --limit=N to cap preview output) ...                                                                          │`);
  }
  console.log("└─────────┴──────────────────────────────────┴──────────┴─────────┴──────────────────────────┴──────────────────────────┘\n");

  // Summary
  const totalDeltaCB = diffs.reduce((s, d) => s + d.deltaCB, 0);
  const totalDeltaSH = diffs.reduce((s, d) => s + d.deltaSH, 0);
  const upCount = diffs.filter(d => d.deltaSH > 0).length;
  const downCount = diffs.filter(d => d.deltaSH < 0).length;

  console.log("─── Summary ────────────────────────────────────────────────────");
  console.log(`  Total products scanned: ${products.length}`);
  console.log(`  Skipped (is_promo):     ${skippedPromo}`);
  console.log(`  Skipped (no VND price): ${skippedNoVnd}`);
  console.log(`  Unchanged:              ${unchanged}`);
  console.log(`  Will update:            ${diffs.length}`);
  console.log(`    ↑ price up:           ${upCount}`);
  console.log(`    ↓ price down:         ${downCount}`);
  console.log(`  Total Δ carryback NT$:  ${totalDeltaCB >= 0 ? "+" : ""}${totalDeltaCB}`);
  console.log(`  Total Δ shipping  NT$:  ${totalDeltaSH >= 0 ? "+" : ""}${totalDeltaSH}`);
  console.log("───────────────────────────────────────────────────────────────\n");

  if (opts.dryRun) {
    console.log("🔍 DRY-RUN — no writes performed.");
    console.log("   Re-run with --apply to write changes to Supabase.");
    return;
  }

  // APPLY mode — confirm + write
  console.log("🔥 APPLY mode — writing to Supabase...");
  let written = 0;
  let failed = 0;

  for (const d of diffs) {
    const { error } = await supabase
      .from("products")
      .update({
        price_thb_carryback: d.newCB,
        price_thb_shipping: d.newSH,
      })
      .eq("id", d.id);
    if (error) {
      console.error(`  ❌ id=${d.id}:`, error.message);
      failed++;
    } else {
      written++;
      if (written % 50 === 0) console.log(`  ... ${written}/${diffs.length} updated`);
    }
  }

  console.log("\n─── Write Summary ──────────────────────────────────────────────");
  console.log(`  ✅ Written:  ${written}`);
  console.log(`  ❌ Failed:   ${failed}`);
  console.log("───────────────────────────────────────────────────────────────");
  console.log("\n💡 Don't forget to run `npm run build` to regenerate data.js for the static site.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
