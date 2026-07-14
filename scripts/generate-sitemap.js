/**
 * generate-sitemap.js
 * ─────────────────────────────────────────────────────────────────
 * 從 Supabase 撈所有 brand 產生 sitemap.xml (含 hreflang 雙語 alternate)。
 *
 * 執行:
 *   npm run sitemap
 *   node scripts/generate-sitemap.js
 *
 * 輸出:
 *   sitemap.xml     — 首頁 + policy + 所有 brand page URL
 *
 * URL 結構 (跟 main.js §4 routing 對齊):
 *   /                                — 首頁
 *   /policy/purchase                 — 購物須知
 *   /policy/shipping                 — 運送政策
 *   /policy/returns                  — 退換貨
 *   /policy/privacy                  — 隱私權
 *   /#brand/{brandId}                — 品牌頁 (SPA hash routing)
 *
 * 註: 產品沒有獨立 URL,產品 SEO 靠 brand page 的 ItemList JSON-LD 帶。
 * ────────────────────────────────────────────────────────────────
 */

import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const SITE = "https://www.neonlotus-tw.com";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function iso(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function urlEntry({ loc, lastmod, changefreq = "weekly", priority = "0.7", hreflang = true }) {
  const alt = hreflang
    ? `
    <xhtml:link rel="alternate" hreflang="zh-TW" href="${loc}" />
    <xhtml:link rel="alternate" hreflang="en" href="${loc}${loc.includes("?") ? "&" : "?"}lang=en" />
    <xhtml:link rel="alternate" hreflang="x-default" href="${loc}" />`
    : "";
  return `  <url>
    <loc>${loc}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>${alt}
  </url>`;
}

async function main() {
  console.log("Fetching brands from Supabase...");
  const { data: brands, error } = await supabase
    .from("brands")
    .select("id, updated_at, created_at")
    .order("sort_order");
  if (error) {
    console.error("❌ Fetch brands error:", error);
    process.exit(1);
  }
  console.log(`  ${brands.length} brands`);

  // Also fetch products' latest update to have brand-level accurate lastmod
  const { data: prodMaxByBrand } = await supabase
    .from("products")
    .select("brand_id, updated_at")
    .order("updated_at", { ascending: false });
  const brandLastmodMap = new Map();
  (prodMaxByBrand || []).forEach((row) => {
    if (!brandLastmodMap.has(row.brand_id) && row.updated_at) {
      brandLastmodMap.set(row.brand_id, row.updated_at);
    }
  });

  const today = iso();
  const entries = [];

  // Home — highest priority, daily update
  entries.push(urlEntry({
    loc: `${SITE}/`,
    lastmod: today,
    changefreq: "daily",
    priority: "1.0",
  }));

  // Policy pages — stable
  ["purchase", "shipping", "returns", "privacy"].forEach((slug) => {
    entries.push(urlEntry({
      loc: `${SITE}/policy/${slug}`,
      lastmod: today,
      changefreq: "monthly",
      priority: "0.5",
    }));
  });

  // Brand pages
  brands.forEach((b) => {
    const lastmod = brandLastmodMap.get(b.id)?.slice(0, 10)
      || b.updated_at?.slice(0, 10)
      || b.created_at?.slice(0, 10)
      || today;
    entries.push(urlEntry({
      loc: `${SITE}/#brand/${b.id}`,
      lastmod,
      changefreq: "weekly",
      priority: "0.8",
    }));
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries.join("\n")}
</urlset>
`;

  fs.writeFileSync("sitemap.xml", xml);
  console.log(`✅ sitemap.xml written — ${entries.length} URLs`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
