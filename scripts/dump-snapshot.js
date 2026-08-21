/**
 * dump-snapshot.js
 * ────────────────────────────────────────────────────────────────
 * Build-time snapshot generator for NEON LOTUS TW.
 *
 * Purpose: eliminate Supabase Cached Egress overage by serving all
 * catalog data as static JSON files through Vercel Edge CDN.
 *
 * Run automatically on every Vercel deploy (via vercel.json buildCommand).
 * Also runnable locally: `node scripts/dump-snapshot.js`.
 *
 * Output:
 *   ./data/products.json         Phase 1 core (brands + products + banners
 *                                + featured + settings + brand_promos)
 *   ./data/gallery/{brandId}.json Phase 2 per-brand (gallery + sizes)
 *   ./data/manifest.json         Metadata: build timestamp, counts
 *
 * The JSON shapes intentionally MIRROR what supabase-client.js currently
 * builds in loadSupabaseData() / loadBrandDetail(), so the front-end
 * change is just: swap the Supabase fetch call for a fetch('/data/...').
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// ── Env ────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[dump-snapshot] Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const PAGE_SIZE = 1000;
const OUT_DIR = path.resolve('./data');
const GALLERY_DIR = path.join(OUT_DIR, 'gallery');

// ── Paginated fetch (matches supabase-client.js fetchAll) ─────
async function fetchAll(table, opts = {}) {
  const all = [];
  let from = 0;
  while (true) {
    let q = supabase.from(table).select(opts.select || '*');
    if (opts.filter)   q = opts.filter(q);
    if (opts.order)    q = q.order(opts.order);
    if (opts.tieBreak) q = q.order(opts.tieBreak);
    q = q.range(from, from + PAGE_SIZE - 1);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = data || [];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

// ── Ensure output directories exist ────────────────────────────
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ── Wipe stale gallery files so removed brands don't linger ───
function clearGalleryDir() {
  if (!fs.existsSync(GALLERY_DIR)) return;
  for (const f of fs.readdirSync(GALLERY_DIR)) {
    if (f.endsWith('.json')) fs.unlinkSync(path.join(GALLERY_DIR, f));
  }
}

// ── Write JSON pretty-printed only in dev, minified in build ──
function writeJson(file, data) {
  const isProd = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
  const content = isProd ? JSON.stringify(data) : JSON.stringify(data, null, 2);
  fs.writeFileSync(file, content, 'utf-8');
  const kb = (Buffer.byteLength(content) / 1024).toFixed(1);
  console.log(`  → ${path.relative(process.cwd(), file)}  ${kb} KB`);
}

// ═══════════════════════════════════════════════════════════════
// PHASE 1 — core payload (brands + products + banners + featured
//           + settings + brand_promos)
// ═══════════════════════════════════════════════════════════════
async function dumpCore() {
  console.log('[dump-snapshot] Phase 1: core payload');

  const [brands, products, banners, featured, settingsRows, brandPromos] = await Promise.all([
    fetchAll('brands', { tieBreak: 'id' }),
    fetchAll('products', {
      select: 'id, brand_id, name, tag, category, season, ' +
              'price_vnd, price_vnd_estimated, price_thb_shipping, price_thb_carryback, price_note, ' +
              'cover_image, original_cover_url, sold_out, needs_review, sort_order, is_active, ' +
              'is_promo, promo_note',
      filter: q => q.eq('is_active', true),
      order: 'sort_order',
      tieBreak: 'id',
    }),
    fetchAll('banners', {
      filter: q => q.eq('is_active', true),
      order: 'sort_order',
      tieBreak: 'id',
    }),
    fetchAll('featured_products', {
      select: 'id, product_id, brand_id, is_active, sort_order',
      filter: q => q.eq('is_active', true),
      order: 'sort_order',
      tieBreak: 'id',
    }).catch(err => {
      console.warn('  featured_products not available:', err?.message || err);
      return [];
    }),
    fetchAll('site_settings'),
    fetchAll('brand_promos', {
      select: 'brand_id, label, tier_rules, excludes_other_promos, counts_toward_member, starts_at, ends_at, is_active',
      filter: q => q.eq('is_active', true),
      tieBreak: 'brand_id',
    }).catch(err => {
      console.warn('  brand_promos not available:', err?.message || err);
      return [];
    }),
  ]);

  // Parse settings KV
  const settings = {};
  for (const row of settingsRows) settings[row.key] = row.value;

  // Transform brands — MUST match supabase-client.js loadSupabaseData()
  const brandsData = brands.map(b => ({
    id:         b.id,
    name:       b.name,
    style:      b.style || '',
    color_hex:  b.color_hex || '#0a0a1a',
    logo_url:   b.logo_url || '',
    cover_url:  b.cover_url || '',
    description: {
      zh: b.description_zh || '',
      en: b.description_en || '',
    },
    meta: {
      category: b.category || '',
      website:  b.website  || '',
      founded:  b.founded  || '',
      location: b.location || '',
    },
  }));

  // Transform products — gallery/sizes left empty (loaded via Phase 2)
  const productsData = products.map(p => ({
    id:       p.id,
    brand_id: p.brand_id,
    name:     p.name,
    tag:      p.tag || p.category || '',
    category: p.category || '',
    season:   p.season || '',
    price: {
      vnd:           p.price_vnd || p.price_vnd_estimated || 0,
      thb_shipping:  p.price_thb_shipping || 0,
      thb_carryback: p.price_thb_carryback || 0,
      note:          p.price_note || '',
    },
    sizes: [],
    images: {
      cover:   p.cover_image || '',
      gallery: [],
    },
    sold_out:           p.sold_out || false,
    needs_review:       p.needs_review || false,
    original_cover_url: p.original_cover_url || p.cover_image || '',
    is_promo:           p.is_promo || false,
    promo_note:         p.promo_note || '',
  }));

  const bannersData = banners.map(bn => ({
    id:        bn.id,
    title:     bn.title || '',
    subtitle:  bn.subtitle || '',
    image_url: bn.image_url || '',
    mobile_image_url: bn.mobile_image_url || '',
    brand_id:  bn.brand_id || '',
    link_url:  bn.link_url || '',
    sort_order: bn.sort_order || 0,
  }));

  const featuredData = (featured || []).map(f => ({
    id:         f.id,
    product_id: f.product_id,
    brand_id:   f.brand_id,
    is_active:  f.is_active,
    sort_order: f.sort_order || 0,
  }));

  const core = {
    brands:       brandsData,
    products:     productsData,
    banners:      bannersData,
    featured:     featuredData,
    settings:     settings,
    brand_promos: brandPromos || [],
  };

  writeJson(path.join(OUT_DIR, 'products.json'), core);
  console.log(`  ${brandsData.length} brands, ${productsData.length} products, ` +
              `${bannersData.length} banners, ${featuredData.length} featured, ` +
              `${(brandPromos || []).length} brand_promos`);

  return { productsById: new Map(products.map(p => [p.id, p])), brandIds: brandsData.map(b => b.id) };
}

// ═══════════════════════════════════════════════════════════════
// PHASE 2 — per-brand gallery + sizes
// Fetch ALL gallery + sizes once, bucket by brand, write one file each.
// ═══════════════════════════════════════════════════════════════
async function dumpBrandDetail(productsById, brandIds) {
  console.log('[dump-snapshot] Phase 2: per-brand gallery + sizes');

  // productId → brandId lookup
  const brandOf = new Map();
  for (const [pid, p] of productsById) brandOf.set(pid, p.brand_id);

  // Fetch all gallery
  console.log('  fetching all product_gallery…');
  const allGallery = await fetchAll('product_gallery', {
    select: 'product_id, type, url, original_url, sort_order',
    order: 'product_id',
    tieBreak: 'sort_order',
  });
  console.log(`    ${allGallery.length} gallery rows`);

  // Fetch all sizes
  console.log('  fetching all product_sizes…');
  const allSizes = await fetchAll('product_sizes', {
    select: 'product_id, label, available, sort_order',
    order: 'product_id',
    tieBreak: 'sort_order',
  });
  console.log(`    ${allSizes.length} size rows`);

  // Bucket by brand
  const galleryByBrand = new Map();  // brandId → { productId → [galleryRow] }
  const sizesByBrand   = new Map();  // brandId → { productId → [sizeRow] }
  for (const bid of brandIds) {
    galleryByBrand.set(bid, {});
    sizesByBrand.set(bid, {});
  }

  for (const g of allGallery) {
    const bid = brandOf.get(g.product_id);
    if (!bid) continue;  // product may be inactive / deleted
    const bucket = galleryByBrand.get(bid);
    if (!bucket) continue;
    (bucket[g.product_id] ||= []).push({
      type: g.type || 'image',
      url: g.url || '',
      original_url: g.original_url || '',
    });
  }

  for (const s of allSizes) {
    const bid = brandOf.get(s.product_id);
    if (!bid) continue;
    const bucket = sizesByBrand.get(bid);
    if (!bucket) continue;
    (bucket[s.product_id] ||= []).push({
      label: s.label,
      available: s.available,
    });
  }

  // Write one file per brand
  ensureDir(GALLERY_DIR);
  clearGalleryDir();
  for (const bid of brandIds) {
    const payload = {
      gallery: galleryByBrand.get(bid) || {},
      sizes:   sizesByBrand.get(bid)   || {},
    };
    // Skip writing empty files unless there's at least one product with data
    const hasData = Object.keys(payload.gallery).length > 0 || Object.keys(payload.sizes).length > 0;
    if (!hasData) continue;
    writeJson(path.join(GALLERY_DIR, `${bid}.json`), payload);
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════
async function main() {
  const t0 = Date.now();
  ensureDir(OUT_DIR);
  ensureDir(GALLERY_DIR);

  const { productsById, brandIds } = await dumpCore();
  await dumpBrandDetail(productsById, brandIds);

  const manifest = {
    generated_at: new Date().toISOString(),
    generator: 'dump-snapshot.js',
    counts: {
      brands: brandIds.length,
      products: productsById.size,
    },
    duration_ms: Date.now() - t0,
  };
  writeJson(path.join(OUT_DIR, 'manifest.json'), manifest);

  console.log(`[dump-snapshot] Done in ${manifest.duration_ms}ms`);
}

main().catch(err => {
  console.error('[dump-snapshot] Fatal:', err);
  process.exit(1);
});
