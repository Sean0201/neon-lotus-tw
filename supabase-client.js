/**
 * supabase-client.js — NEON LOTUS TW
 * ─────────────────────────────────────────────────────────────────
 * Replaces build-time data.js with real-time Supabase JS SDK calls.
 * Fetches brands, products, product_sizes, product_gallery, banners,
 * and site_settings from Supabase and assembles window globals
 * that main.js consumes.
 * ─────────────────────────────────────────────────────────────────
 */

'use strict';

const SUPABASE_URL  = 'https://epemuyojkprepknuzuzc.supabase.co';
const SUPABASE_ANON = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVwZW11eW9qa3ByZXBrbnV6dXpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4MDMwMTAsImV4cCI6MjA5MTM3OTAxMH0',
  'nTv7W1_ndzzAQGNgVzSKSkruvsnEgt6N7PbnRK31l0M'
].join('.');

const _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

// ── Cache config ──────────────────────────────────────────────
const CACHE_KEY     = 'NEON_LOTUS_TW_DATA';
const CACHE_TS_KEY  = 'NEON_LOTUS_TW_DATA_TS';
const CACHE_TTL     = 5 * 60 * 1000;   // 5 minutes

/**
 * Main entry point — fetches all data from Supabase (or localStorage cache)
 * and sets window.BRANDS_DATA, window.BANNERS_DATA, window.SITE_SETTINGS.
 */
async function loadSupabaseData() {
  // ── Try localStorage cache first ──────────────────────────
  try {
    const cached   = localStorage.getItem(CACHE_KEY);
    const cachedTs = localStorage.getItem(CACHE_TS_KEY);
    if (cached && cachedTs && (Date.now() - Number(cachedTs)) < CACHE_TTL) {
      const data = JSON.parse(cached);
      if (data && data.brands && data.products) {
        console.log('[supabase-client] Using cached data (' +
          data.brands.length + ' brands, ' + data.products.length + ' products)');
        window.BRANDS_DATA    = data;
        window.BANNERS_DATA   = data.banners   || [];
        window.SITE_SETTINGS  = data.settings   || {};
        return;
      }
    }
  } catch (e) {
    console.warn('[supabase-client] Cache read failed:', e);
  }

  // ── Fetch fresh from Supabase in parallel ──────────────────
  console.log('[supabase-client] Fetching fresh data from Supabase…');

  const [brandsRes, productsRes, sizesRes, galleryRes, bannersRes, settingsRes] = await Promise.all([
    _supabase.from('brands').select('*'),
    _supabase.from('products').select('*').eq('is_active', true).order('sort_order'),
    _supabase.from('product_sizes').select('*').order('sort_order'),
    _supabase.from('product_gallery').select('*').order('sort_order'),
    _supabase.from('banners').select('*').eq('is_active', true).order('sort_order'),
    _supabase.from('site_settings').select('*'),
  ]);

  // Check for errors (banners & settings are non-critical)
  if (brandsRes.error)   throw new Error('brands: '   + brandsRes.error.message);
  if (productsRes.error) throw new Error('products: '  + productsRes.error.message);
  if (sizesRes.error)    throw new Error('sizes: '     + sizesRes.error.message);
  if (galleryRes.error)  throw new Error('gallery: '   + galleryRes.error.message);

  const brands   = brandsRes.data   || [];
  const products = productsRes.data || [];
  const sizes    = sizesRes.data    || [];
  const gallery  = galleryRes.data  || [];
  const banners  = bannersRes.data  || [];
  const settingsRows = settingsRes.data || [];

  // ── Parse site_settings into key-value map ────────────────
  const settings = {};
  for (const row of settingsRows) {
    settings[row.key] = row.value;
  }

  // ── Index sizes & gallery by product_id ────────────────────
  const sizesByProduct   = {};
  for (const s of sizes) {
    if (!sizesByProduct[s.product_id]) sizesByProduct[s.product_id] = [];
    sizesByProduct[s.product_id].push({ label: s.label, available: s.available });
  }

  const galleryByProduct = {};
  for (const g of gallery) {
    if (!galleryByProduct[g.product_id]) galleryByProduct[g.product_id] = [];
    galleryByProduct[g.product_id].push({
      type: g.type,
      url: g.url,
      original_url: g.original_url || g.url,
    });
  }

  // ── Transform to BRANDS_DATA format ────────────────────────
  const brandsData = brands.map(b => ({
    id:          b.id,
    name:        b.name,
    style:       b.style || '',
    color_hex:   b.color_hex || '#0a0a1a',
    logo_url:    b.logo_url || '',
    cover_url:   b.cover_url || '',
    description: {
      en: b.description_en || '',
      th: b.description_th || '',
      zh: b.description_zh || '',
    },
    meta: {
      category: b.category || '',
      website:  b.website  || '',
      founded:  b.founded  || '',
      location: b.location || '',
    },
  }));

  const productsData = products.map(p => {
    const pGallery = galleryByProduct[p.id] || [];
    const coverUrl = p.cover_image || (pGallery[0] ? pGallery[0].url : '');

    return {
      id:       p.id,
      brand_id: p.brand_id,
      name:     p.name,
      tag:      p.tag || p.category || '',
      category: p.category || '',
      season:   p.season || '',
      price: {
        vnd:            p.price_vnd || p.price_vnd_estimated || 0,
        thb_shipping:   p.price_thb_shipping || 0,
        thb_carryback:  p.price_thb_carryback || 0,
      },
      sizes:     sizesByProduct[p.id] || [],
      images: {
        cover:   coverUrl,
        gallery: pGallery,
      },
      sold_out:           p.sold_out || false,
      needs_review:       p.needs_review || false,
      original_cover_url: p.original_cover_url || coverUrl,
    };
  });

  // ── Transform banners ────────────────────────────────────────
  const bannersData = banners.map(bn => ({
    id:        bn.id,
    title_en:  bn.title_en || '',
    title_zh:  bn.title_zh || '',
    subtitle_en: bn.subtitle_en || '',
    subtitle_zh: bn.subtitle_zh || '',
    image_url: bn.image_url || '',
    link_url:  bn.link_url || '',
    sort_order: bn.sort_order || 0,
  }));

  const data = {
    brands:   brandsData,
    products: productsData,
    banners:  bannersData,
    settings: settings,
  };

  // ── Write to localStorage cache ────────────────────────────
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    localStorage.setItem(CACHE_TS_KEY, String(Date.now()));
  } catch (e) {
    console.warn('[supabase-client] Cache write failed:', e);
  }

  console.log('[supabase-client] Loaded ' + brandsData.length + ' brands, ' +
    productsData.length + ' products, ' + bannersData.length + ' banners from Supabase');

  window.BRANDS_DATA   = data;
  window.BANNERS_DATA  = bannersData;
  window.SITE_SETTINGS = settings;
}

// ── Execute immediately — main.js will check window.BRANDS_DATA ──
loadSupabaseData().catch(err => {
  console.error('[supabase-client] Failed to load data:', err);
  // Don't set BRANDS_DATA — let main.js show its own error state
});
