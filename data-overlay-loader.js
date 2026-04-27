/* ═══════════════════════════════════════════════════════════════
 * data-overlay-loader.js
 * --------------------------------------------------------------------
 * 把 data-overlay.js 提供的 (window.DATA_OVERLAY) 在 supabase-client.js
 * 設定 window.BRANDS_DATA 之前 / 當下 merge 進去:
 *
 *   - overlay.brands[]     : 不在 Supabase 的新品牌 → 直接 push
 *   - overlay.products[]   : 不在 Supabase 的新商品 → 直接 push
 *   - overlay.size_charts  : { product_id: size_chart_obj }
 *                            針對「已存在」的商品補上 size_chart 欄位
 *
 * 必須在 supabase-client.js 之前 <script> 載入，這樣 Object.defineProperty
 * 才能攔截到 supabase-client 寫入 window.BRANDS_DATA 的那一刻。
 * --------------------------------------------------------------------
 */
(function () {
  'use strict';

  function getOverlay() {
    return window.DATA_OVERLAY || { brands: [], products: [], size_charts: {} };
  }

  function merge(data) {
    if (!data || !Array.isArray(data.brands) || !Array.isArray(data.products)) return data;
    const ov = getOverlay();
    const newBrands   = ov.brands || [];
    const newProducts = ov.products || [];
    const sizeMap     = ov.size_charts || {};
    const imageMap    = ov.image_overlay || {};   // { product_id: [{type,url,original_url}, ...] }

    // 1) 新品牌 (僅當 Supabase 沒有此 id 時加入)
    const brandIds = new Set(data.brands.map(b => b.id));
    let addedBrands = 0;
    for (const b of newBrands) {
      if (!brandIds.has(b.id)) {
        data.brands.push(b);
        brandIds.add(b.id);
        addedBrands++;
      }
    }

    // 2) 新商品 (僅當 Supabase 沒有此 id 時加入)
    const productIds = new Set(data.products.map(p => p.id));
    let addedProducts = 0;
    for (const p of newProducts) {
      if (!productIds.has(p.id)) {
        data.products.push(p);
        productIds.add(p.id);
        addedProducts++;
      }
    }

    // 3) 為「既有商品」補上 size_chart 與 多餘的圖片
    let patchedSize = 0, patchedImg = 0;
    for (const p of data.products) {
      if (sizeMap[p.id] && !p.size_chart) {
        p.size_chart = sizeMap[p.id];
        patchedSize++;
      }
      // 圖片補強: 若 overlay 提供的 gallery 數量 > 既有, 則覆蓋
      const ovGallery = imageMap[p.id];
      if (ovGallery && ovGallery.length) {
        if (!p.images) p.images = { cover: '', gallery: [] };
        const cur = p.images.gallery || [];
        if (ovGallery.length > cur.length) {
          // 合併: 既有 cover 保留為第一張, 後面附 overlay 中既有沒有的 url
          const seen = new Set(cur.map(g => g.url));
          const extra = ovGallery.filter(g => !seen.has(g.url));
          p.images.gallery = cur.concat(extra);
          patchedImg++;
        }
      }
    }

    console.log(
      `[overlay] merged: +${addedBrands} brands, +${addedProducts} products, ` +
      `${patchedSize} size_chart patches, ${patchedImg} image patches ` +
      `(overlay: ${Object.keys(sizeMap).length} charts / ${Object.keys(imageMap).length} galleries)`
    );
    return data;
  }

  // ── 攔截 window.BRANDS_DATA 賦值 ────────────────────────────
  // supabase-client.js 內會做 `window.BRANDS_DATA = data;`
  // 我們在那之前先把這個 property 改成 setter, merge 完再存起來
  let _real = null;
  try {
    Object.defineProperty(window, 'BRANDS_DATA', {
      configurable: true,
      get() { return _real; },
      set(v) {
        if (v && !v.__overlay_applied) {
          try { merge(v); } catch (e) { console.error('[overlay] merge failed', e); }
          v.__overlay_applied = true;
        }
        _real = v;
      },
    });
  } catch (e) {
    console.error('[overlay] Object.defineProperty failed', e);
  }

  // 有一個邊角情況: 如果 supabase-client 已經在我們之前執行 (script 順序錯誤),
  //                window.BRANDS_DATA 可能已經被設了。手動再 merge 一次。
  if (_real && !_real.__overlay_applied) {
    try { merge(_real); _real.__overlay_applied = true; }
    catch (e) { console.error('[overlay] retroactive merge failed', e); }
  }

  // 暴露 API 方便 debug
  window.DataOverlay = { merge, getOverlay };
})();
