/**
 * supabase-client.js — NEON LOTUS TW
 * ─────────────────────────────────────────────────────────────────
 * PERFORMANCE-OPTIMISED architecture:
 *
 *   Initial load  → brands + products + banners + settings  (~9 requests)
 *   Brand page    → gallery + sizes for that brand only     (on demand)
 *
 * Gallery (37 000+ rows) and sizes (16 000+ rows) are NOT fetched
 * upfront. They are lazy-loaded per brand when the user navigates
 * into a brand page, then cached in memory so repeat visits are instant.
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

// ── Constants ─────────────────────────────────────────────────
// V8: products SELECT 加入 is_promo + promo_note (migration 014)。
//     V7 cache 沒帶這兩欄,前台會把 promo 商品當正常品折扣,推 V8 強制 invalidate。
// V7: 清除 products 表中所有 stale price_thb_shipping / price_thb_carryback 舊 THB 值
//     (commit e2e55aa 之後這兩欄變成 NT$ override,但 DB 還有 3702 筆舊值在裡面,
//     V6 cache 推上去後讓這些舊值第一次以 override 身份生效,造成全站價格跑掉)。
//     已透過 SQL 把全部 override 設回 NULL,推 V7 讓所有用戶立即拿到正確 fresh data。
// V6: tag/category 已標準化為 5 個值 (Top/Outerwear/Bottom/Set/Accessories)。
// V14: 新增 brand_promos 表 (migration 015 — 品牌活動促銷 / 階梯折)。
//      V13 cache 沒有 brand_promos 欄位,推 V14 讓所有訪客一次抓到新資料。
const CACHE_KEY     = 'NEON_LOTUS_TW_V14';
const CACHE_TS_KEY  = 'NEON_LOTUS_TW_V14_TS';
const CACHE_TTL     = 60 * 60 * 1000;  // 60 minutes — 減少 egress,同訪客 1 小時內不重抓
const PAGE_SIZE     = 1000;             // Supabase max rows per request

// ── In-memory cache for per-brand gallery + sizes ─────────────
const _brandDetailCache = {};           // { brandId: true } — already fetched

/**
 * Paginated fetch — retrieves ALL rows from a table, 1000 at a time.
 *
 * ⚠️ 分頁穩定性:
 * 只用 ORDER BY sort_order 之類「大量 ties」的欄位分頁時,Postgres 的 tie-break
 * 不保證 request 之間穩定 → 頁與頁之間會有 row 重複/漏抓。caller 若需要 stable
 * pagination,請透過 opts.tieBreak 傳入唯一 column (通常 'id')。
 * 不預設加 'id' 是因為某些表 (e.g. site_settings) 沒有 id column。
 */
async function fetchAll(table, opts = {}) {
  const allRows = [];
  let from = 0;
  while (true) {
    let query = _supabase.from(table).select(opts.select || '*');
    if (opts.filter)   query = opts.filter(query);
    if (opts.order)    query = query.order(opts.order);
    if (opts.tieBreak) query = query.order(opts.tieBreak);  // stable pagination
    query = query.range(from, from + PAGE_SIZE - 1);
    const { data, error } = await query;
    if (error) throw new Error(table + ': ' + error.message);
    const rows = data || [];
    allRows.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return allRows;
}

/* ═══════════════════════════════════════════════════════════════
   PHASE 1 — Initial page load (fast)
   Fetches: brands, products, banners, site_settings
   Skips:   product_gallery, product_sizes  (lazy per brand)
   ═══════════════════════════════════════════════════════════════ */

async function loadSupabaseData() {
  // ── Try localStorage cache ──────────────────────────────────
  try {
    const cached   = localStorage.getItem(CACHE_KEY);
    const cachedTs = localStorage.getItem(CACHE_TS_KEY);
    if (cached && cachedTs && (Date.now() - Number(cachedTs)) < CACHE_TTL) {
      const data = JSON.parse(cached);
      if (data && data.brands && data.products) {
        console.log('[supabase-client] Using cached data (' +
          data.brands.length + ' brands, ' + data.products.length + ' products)');
        window.BRANDS_DATA   = data;
        window.BANNERS_DATA  = data.banners  || [];
        window.FEATURED_DATA = data.featured || [];
        window.SITE_SETTINGS = data.settings || {};
        window.BRAND_PROMOS  = data.brand_promos || [];
        // featured_products 是小表 (通常 <20 筆) 而且 admin 改完要立刻反映,
        // 所以即使 brands/products 走 5 分鐘快取,featured 還是每次拉新版。
        _refreshFeaturedFromServer();
        // brand_promos 也是小表 + 需要立刻反映 activate/deactivate,同樣每次拉新版
        _refreshBrandPromosFromServer();
        return;
      }
    }
  } catch (e) {
    console.warn('[supabase-client] Cache read failed:', e);
  }

  // ── Fetch core data (NO gallery, NO sizes) ──────────────────
  const t0 = performance.now();
  console.log('[supabase-client] Fetching core data from Supabase…');

  const [brands, products, banners, featured, settingsRows, brandPromos] = await Promise.all([
    fetchAll('brands', { tieBreak: 'id' }),
    fetchAll('products', {
      // 明確列出前台用得到的欄位 — 跳過 description_zh / description_en 因為前台從沒讀過
      // (商品描述只有 admin 編輯頁用,不需要載到瀏覽器)。少抓兩個大欄位 = 大幅減少 egress。
      select: 'id, brand_id, name, tag, category, season, ' +
              'price_vnd, price_vnd_estimated, price_thb_shipping, price_thb_carryback, price_note, ' +
              'cover_image, original_cover_url, sold_out, needs_review, sort_order, is_active, ' +
              'is_promo, promo_note',
      filter: q => q.eq('is_active', true),
      order: 'sort_order',
      tieBreak: 'id',   // sort_order 大量 ties → 一定要 stable tie-breaker
    }),
    fetchAll('banners', {
      filter: q => q.eq('is_active', true),
      order: 'sort_order',
      tieBreak: 'id',
    }),
    // featured_products may not exist yet on first deploy — swallow errors
    fetchAll('featured_products', {
      select: 'id, product_id, brand_id, is_active, sort_order',
      filter: q => q.eq('is_active', true),
      order: 'sort_order',
      tieBreak: 'id',
    }).catch(err => {
      console.warn('[supabase-client] featured_products not available:', err?.message || err);
      return [];
    }),
    fetchAll('site_settings'),   // 純 KV 表,無 id column,不用 tie-breaker
    // brand_promos 可能還沒 migration → swallow errors 讓舊環境不炸
    fetchAll('brand_promos', {
      select: 'brand_id, label, tier_rules, excludes_other_promos, counts_toward_member, starts_at, ends_at, is_active',
      filter: q => q.eq('is_active', true),
      tieBreak: 'brand_id',
    }).catch(err => {
      console.warn('[supabase-client] brand_promos not available:', err?.message || err);
      return [];
    }),
  ]);

  // ── Parse settings ──────────────────────────────────────────
  const settings = {};
  for (const row of settingsRows) settings[row.key] = row.value;

  // ── Transform brands ────────────────────────────────────────
  const brandsData = brands.map(b => ({
    id:          b.id,
    name:        b.name,
    style:       b.style || '',
    color_hex:   b.color_hex || '#0a0a1a',
    logo_url:    b.logo_url || '',
    cover_url:   b.cover_url || '',
    // 此站 (TW) 只用中文 + 英文;泰文留給另一個站
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

  // ── Transform products (gallery & sizes empty for now) ──────
  const productsData = products.map(p => ({
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
      note:           p.price_note || '',
    },
    sizes:   [],          // lazy — filled by loadBrandDetail()
    images: {
      cover:   p.cover_image || '',
      gallery: [],        // lazy — filled by loadBrandDetail()
    },
    sold_out:           p.sold_out || false,
    needs_review:       p.needs_review || false,
    original_cover_url: p.original_cover_url || p.cover_image || '',
    // Phase 2.2 migration 014 — 品牌方特價旗標 + 備註 (main.js + cart.js 都會讀)
    is_promo:           p.is_promo || false,
    promo_note:         p.promo_note || '',
    // 商品描述刻意不放進記憶體/快取 — 前台沒在用 (只 admin 編輯頁讀)
  }));

  // ── Transform banners ───────────────────────────────────────
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

  // ── Transform featured products ─────────────────────────────
  const featuredData = (featured || []).map(f => ({
    id:         f.id,
    product_id: f.product_id,
    brand_id:   f.brand_id,
    is_active:  f.is_active,
    sort_order: f.sort_order || 0,
  }));

  const data = {
    brands:       brandsData,
    products:     productsData,
    banners:      bannersData,
    featured:     featuredData,
    settings:     settings,
    brand_promos: brandPromos || [],
  };

  // ── Cache (tiered fallback — 6000+ 商品時會超過 localStorage 5MB) ──
  // 嘗試順序:完整 → 剝品牌 description → 連 banner/featured/settings 都剝 → 放棄
  // 任何一層成功就停下來,失敗的資料下一頁只是少 cache 不影響功能。
  const tiers = [
    () => data,
    () => ({
      ...data,
      brands: data.brands.map(b => ({ ...b, description: { zh: '', en: '' } })),
    }),
    () => ({
      brands: data.brands.map(b => ({ ...b, description: { zh: '', en: '' }, meta: {} })),
      products: data.products,
      banners: [],
      featured: [],
      settings: {},
    }),
  ];
  let cached = false;
  for (let i = 0; i < tiers.length; i++) {
    try {
      const slim = tiers[i]();
      localStorage.setItem(CACHE_KEY, JSON.stringify(slim));
      localStorage.setItem(CACHE_TS_KEY, String(Date.now()));
      if (i > 0) console.log(`[supabase-client] Cache written at trim level ${i}`);
      cached = true;
      break;
    } catch (_) {
      try { localStorage.removeItem(CACHE_KEY); } catch (_) {}
    }
  }
  if (!cached) {
    console.warn('[supabase-client] Cache write skipped — payload still too large after trim');
  }

  const ms = Math.round(performance.now() - t0);
  console.log(`[supabase-client] Core load done in ${ms}ms — ` +
    `${brandsData.length} brands, ${productsData.length} products`);

  window.BRANDS_DATA   = data;
  window.BANNERS_DATA  = bannersData;
  window.FEATURED_DATA = featuredData;
  window.SITE_SETTINGS = settings;
  window.BRAND_PROMOS  = brandPromos || [];
}

/**
 * 每次載入都跑一次 (跟 _refreshFeaturedFromServer 一樣的目的):
 * brand_promos 是小表,activate/deactivate 要立刻反映到訪客。
 * 走 cache 路徑會漏 flip switch,所以背景重抓一次覆寫 window.BRAND_PROMOS。
 */
async function _refreshBrandPromosFromServer() {
  try {
    const rows = await fetchAll('brand_promos', {
      select: 'brand_id, label, tier_rules, excludes_other_promos, counts_toward_member, starts_at, ends_at, is_active',
      filter: q => q.eq('is_active', true),
      tieBreak: 'brand_id',
    });
    window.BRAND_PROMOS = rows || [];
  } catch (err) {
    console.warn('[supabase-client] refresh brand_promos failed:', err?.message || err);
  }
}

/* ═══════════════════════════════════════════════════════════════
   PHASE 2 — Lazy brand detail (gallery + sizes)
   Called by main.js when user enters a brand page.
   Fetches only the gallery & sizes for that brand's products,
   then patches window.BRANDS_DATA.products in place.
   ═══════════════════════════════════════════════════════════════ */

/**
 * Load gallery + sizes for a specific brand.
 * Resolves immediately if already loaded.
 * @param {string} brandId
 * @returns {Promise<void>}
 */
async function loadBrandDetail(brandId) {
  if (_brandDetailCache[brandId]) return;  // already loaded

  const data = window.BRANDS_DATA;
  if (!data) return;

  // Collect product IDs for this brand
  const productIds = data.products
    .filter(p => p.brand_id === brandId)
    .map(p => p.id);

  if (!productIds.length) return;

  const t0 = performance.now();
  console.log(`[supabase-client] Loading detail for brand "${brandId}" (${productIds.length} products)…`);

  // Fetch gallery + sizes in parallel, using .in() filter on product_id
  // Supabase .in() has a URL length limit, so batch if needed
  const BATCH = 200;  // safe batch size for .in() filter
  const galleryAll = [];
  const sizesAll   = [];

  const batches = [];
  for (let i = 0; i < productIds.length; i += BATCH) {
    const chunk = productIds.slice(i, i + BATCH);
    batches.push(
      fetchAll('product_gallery', {
        filter: q => q.in('product_id', chunk),
        order: 'sort_order',
        tieBreak: 'id',
      }),
      fetchAll('product_sizes', {
        filter: q => q.in('product_id', chunk),
        order: 'sort_order',
        tieBreak: 'id',
      }),
    );
  }

  const results = await Promise.all(batches);

  // Interleaved: [gallery0, sizes0, gallery1, sizes1, ...]
  for (let i = 0; i < results.length; i += 2) {
    galleryAll.push(...results[i]);
    sizesAll.push(...results[i + 1]);
  }

  // ── lsoul URL 修補: 過期 /cache/<hash>/ thumbnail 路徑要剝掉才能載 ──
  const fixLsoul = (url) => {
    if (typeof url !== 'string' || !url.includes('lsoul.com/media/catalog/product/cache/')) return url;
    return url.replace(/\/cache\/[a-f0-9]+\//, '/');
  };

  // ── Index by product_id ─────────────────────────────────────
  const galleryByProduct = {};
  for (const g of galleryAll) {
    if (!galleryByProduct[g.product_id]) galleryByProduct[g.product_id] = [];
    galleryByProduct[g.product_id].push({
      type: g.type,
      url: brandId === 'lsoul' ? fixLsoul(g.url) : g.url,
      original_url: brandId === 'lsoul' ? fixLsoul(g.original_url || g.url) : (g.original_url || g.url),
    });
  }

  const sizesByProduct = {};
  for (const s of sizesAll) {
    if (!sizesByProduct[s.product_id]) sizesByProduct[s.product_id] = [];
    sizesByProduct[s.product_id].push({ label: s.label, available: s.available });
  }

  // ── Patch products in place ──────────────────────────────────
  for (const p of data.products) {
    if (p.brand_id !== brandId) continue;
    const g = galleryByProduct[p.id] || [];
    p.images.gallery = g;
    if (!p.images.cover && g.length) p.images.cover = g[0].url;
    p.sizes = sizesByProduct[p.id] || [];
  }

  _brandDetailCache[brandId] = true;

  const ms = Math.round(performance.now() - t0);
  console.log(`[supabase-client] Brand "${brandId}" detail loaded in ${ms}ms — ` +
    `${galleryAll.length} gallery images, ${sizesAll.length} sizes`);
}

/* ═══════════════════════════════════════════════════════════════
   Featured products — always-fresh refresh
   (brands/products 走 5 分鐘 cache,但 featured 永遠拉新版)
   ═══════════════════════════════════════════════════════════════ */
async function _refreshFeaturedFromServer() {
  try {
    const rows = await fetchAll('featured_products', {
      select: 'id, product_id, brand_id, is_active, sort_order',
      filter: q => q.eq('is_active', true),
      order: 'sort_order',
      tieBreak: 'id',
    });
    const next = (rows || []).map(f => ({
      id:         f.id,
      product_id: f.product_id,
      brand_id:   f.brand_id,
      is_active:  f.is_active,
      sort_order: f.sort_order || 0,
    }));
    const prevJson = JSON.stringify(window.FEATURED_DATA || []);
    window.FEATURED_DATA = next;

    // 同步把 cache payload 裡的 featured 也更新,
    // 這樣下次重整(就算 cache 還沒過期)也能看到最新 featured。
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (cached) {
        cached.featured = next;
        localStorage.setItem(CACHE_KEY, JSON.stringify(cached));
      }
    } catch (_) {}

    // 如果 main.js 已經 render 過了,FEATURED_DATA 變了就重 render 一次
    if (prevJson !== JSON.stringify(next) && typeof window.renderFeatured === 'function') {
      window.renderFeatured();
    }
  } catch (err) {
    console.warn('[supabase-client] featured refresh failed:', err?.message || err);
  }
}

// Expose loadBrandDetail globally for main.js
window.loadBrandDetail = loadBrandDetail;

// ── Execute initial load ──────────────────────────────────────
loadSupabaseData().catch(err => {
  console.error('[supabase-client] Failed to load data:', err);
});
