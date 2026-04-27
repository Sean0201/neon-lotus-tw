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

  /** 名稱標準化 → 與 matcher 用的 baseName 一致 */
  function baseKeys(name) {
    if (!name) return [];
    let s = String(name).toLowerCase();
    s = s.replace(/[\u2018\u2019\u02bc'`"]/g, '');
    s = s.replace(/^\s*23\s*/, '');
    if (s.includes('/')) s = s.split('/')[0];
    s = s.replace(/\([^)]*\)/g, ' ');
    const tokens = s.split(/[^a-z0-9]+/i).filter(Boolean);
    const ROMAN_OR_NUM = /^(i{1,3}|iv|v|vi{0,3}|ix|x|0?\d{1,2})$/;
    const trimmed = tokens.slice();
    while (trimmed.length > 1 && ROMAN_OR_NUM.test(trimmed[trimmed.length - 1])) trimmed.pop();
    const stem = (t) => t.replace(/(ed|es|s|d)$/, '');
    const stemmed = trimmed.map(stem);
    const out = new Set();
    out.add(tokens.join(''));
    out.add(trimmed.join(''));
    out.add(stemmed.join(''));
    return Array.from(out).filter(Boolean);
  }

  function merge(data) {
    if (!data || !Array.isArray(data.brands) || !Array.isArray(data.products)) return data;
    const ov = getOverlay();
    const newBrands   = ov.brands || [];
    const newProducts = ov.products || [];
    // 注意: by_id 已棄用 — Supabase product ID 會漂移 (重新發布時會洗 ID),
    //       本機 data.js 寫的 ID 對應到線上時可能是別的商品, 會把 size_chart
    //       配錯位 (e.g. 衣服顯示褲子尺寸). 改成只用 by_name (live data 名稱比較穩定)
    const byNameNested = ov.by_name || null;
    function getByName(brandId, kind /* 'size_charts'|'image_overlay' */) {
      if (byNameNested && byNameNested[brandId] && byNameNested[brandId][kind])
        return byNameNested[brandId][kind];
      return null;
    }

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

    // 3) 為「既有商品」依「商品名稱」(by_name) 補上 size_chart 與圖片
    let patchedSize = 0, patchedImg = 0;
    for (const p of data.products) {
      // -- size_chart by name --
      if (!p.size_chart) {
        const sizeMapByName = getByName(p.brand_id, 'size_charts');
        if (sizeMapByName) {
          for (const b of baseKeys(p.name)) {
            if (sizeMapByName[b]) {
              p.size_chart = sizeMapByName[b];
              patchedSize++;
              break;
            }
          }
        }
      }

      // -- image overlay by name --
      const imageMapByName = getByName(p.brand_id, 'image_overlay');
      if (imageMapByName) {
        let ovG = null;
        for (const b of baseKeys(p.name)) {
          if (imageMapByName[b]) { ovG = imageMapByName[b]; break; }
        }
        if (ovG && ovG.length) {
          if (!p.images) p.images = { cover: '', gallery: [] };
          const cur = p.images.gallery || [];
          if (ovG.length > cur.length) {
            const seen = new Set(cur.map(g => g.url));
            const extra = ovG.filter(g => !seen.has(g.url));
            p.images.gallery = cur.concat(extra);
            patchedImg++;
          }
        }
      }
    }

    console.log(
      `[overlay] merged: +${addedBrands} brands, +${addedProducts} products | ` +
      `size_chart: ${patchedSize} by name | image: ${patchedImg} by name`
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
