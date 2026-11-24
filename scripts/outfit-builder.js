/**
 * outfit-builder.js — Outfit Composition Engine
 * 管理試穿格位(上衣 / 褲子 / 外套 / 包包 / 帽子),整套一次送到 /api/tryon 生成
 */

(function () {
  'use strict';

  /* ── Category mapping from product data ──────────────────── */
  const CATEGORY_MAP = {
    // Tops
    'TOPS': 'top', 'TEES': 'top', 'LONGSLEEVES': 'top', 'TANKS': 'top',
    'SHIRTS': 'top', 'POLOS': 'top', 'HOODIES': 'top', 'SWEATERS': 'top',
    'SWEATSHIRTS': 'top', 'KNITWEAR': 'top',
    // Outerwear (separate layer — applied OVER top)
    'JACKETS': 'outerwear', 'OUTERWEAR': 'outerwear', 'COATS': 'outerwear', 'COAT': 'outerwear',
    // Bottoms
    'BOTTOMS': 'bottom', 'PANTS': 'bottom', 'SHORTS': 'bottom', 'SKIRTS': 'bottom',
    // Bags
    'BAGS': 'bag',
    // Hats
    'CAPS': 'hat', 'HATS': 'hat',
    // Other
    'SETS': 'top', 'DRESSES': 'top'
  };

  /* ── UI labels per category ────────────────────────── */
  const CATEGORY_LABELS = {
    top:       { tw: '上衣',  en: 'Top',       icon: '👕' },
    bottom:    { tw: '褲子',  en: 'Bottom',    icon: '👖' },
    outerwear: { tw: '外套',  en: 'Outerwear', icon: '🧥' },
    bag:       { tw: '背包',  en: 'Bag',       icon: '🎒' },
    hat:       { tw: '帽子',  en: 'Hat',       icon: '🧢' }
  };

  /* Layer order: top first (silhouette baseline), then bottom, then outerwear OVER top,
     then bag (over outerwear if present), then hat (independent region). */
  const LAYER_ORDER = ['top', 'bottom', 'outerwear', 'bag', 'hat'];

  const outfit = { top: null, bottom: null, outerwear: null, bag: null, hat: null };
  let selfieBase64 = null;
  let selfieType = 'image/jpeg';
  let selfieSrc = null;
  let isProcessing = false;

  function resolveCategory(product) {
    const cat = (product.category || '').toUpperCase().trim();
    return CATEGORY_MAP[cat] || null;
  }

  function setSelfie(base64, type, src) {
    selfieBase64 = base64;
    selfieType = type || 'image/jpeg';
    selfieSrc = src;
  }

  function setItem(category, product) {
    if (!CATEGORY_LABELS[category]) return false;
    const imageUrl = window._getProductImageSrc ? window._getProductImageSrc(product) : null;
    outfit[category] = { product, imageUrl };
    renderOutfitPanel();
    return true;
  }

  function removeItem(category) {
    outfit[category] = null;
    renderOutfitPanel();
  }

  function getOutfit() { return { ...outfit }; }
  function getItemCount() { return LAYER_ORDER.filter(k => outfit[k] !== null).length; }
  function getSelectedLayers() { return LAYER_ORDER.filter(k => outfit[k] !== null); }
  function clearOutfit() { LAYER_ORDER.forEach(k => outfit[k] = null); renderOutfitPanel(); }

  function renderOutfitPanel() {
    const panel = document.getElementById('outfit-panel');
    if (!panel) return;
    const lang = window.__currentLang || 'tw';
    let html = '';
    LAYER_ORDER.forEach(cat => {
      const label = CATEGORY_LABELS[cat];
      const item = outfit[cat];
      const catLabel = lang === 'en' ? label.en : label.tw;
      if (item) {
        html += '<div class="outfit-slot outfit-slot-filled" data-cat="' + cat + '">'
          + '<img src="' + (item.imageUrl || '') + '" alt="' + (item.product.name || '') + '" />'
          + '<div class="outfit-slot-info">'
          + '<span class="outfit-slot-cat">' + label.icon + ' ' + catLabel + '</span>'
          + '<span class="outfit-slot-name">' + (item.product.name || '').substring(0, 25) + '</span>'
          + '</div>'
          + '<button class="outfit-slot-remove" data-remove-cat="' + cat + '" title="移除">✕</button>'
          + '</div>';
      } else {
        html += '<div class="outfit-slot outfit-slot-empty" data-cat="' + cat + '">'
          + '<span class="outfit-slot-placeholder">' + label.icon + ' ' + catLabel + '</span>'
          + '</div>';
      }
    });
    panel.innerHTML = html;
    panel.querySelectorAll('[data-remove-cat]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        removeItem(btn.dataset.removeCat);
      });
    });
    const tryBtn = document.getElementById('outfit-tryon-btn');
    if (tryBtn) {
      const count = getItemCount();
      tryBtn.disabled = count === 0;
      if (count > 0) {
        const btnLabel = lang === 'en'
          ? 'Selected ' + count + ' — Start Try On'
          : '已選擇完成 進行試穿 (' + count + ' 件)';
        tryBtn.textContent = '✨ ' + btnLabel;
      } else {
        tryBtn.textContent = lang === 'en' ? 'Select items first' : '請先選擇商品';
      }
    }
  }

  /* ── 試穿:整套一次生成(後端依 product_id 取去背圖/封面圖,OpenAI → Gemini 備援) ── */
  async function executeTryOn(onProgress, onComplete, onError) {
    if (isProcessing) return;
    if (!selfieBase64) { onError('請先上傳照片'); return; }
    const layers = getSelectedLayers();
    if (layers.length === 0) { onError('請至少選擇一件商品'); return; }
    isProcessing = true;

    const lang = window.__currentLang || 'tw';
    const names = layers.map(function (cat) { return lang === 'en' ? CATEGORY_LABELS[cat].en : CATEGORY_LABELS[cat].tw; });
    const label = (lang === 'en' ? 'Dressing you in ' : 'AI 正在幫你換上 ') + names.join(' + ')
      + (lang === 'en' ? ' (about 30s)' : '(約 30 秒)');

    /* 單一請求沒有實際進度,用時間推估讓進度條緩慢前進(最多到 95%) */
    const t0 = Date.now();
    onProgress(0, 1, label);
    const ticker = setInterval(function () {
      const f = Math.min(0.95, (Date.now() - t0) / 40000);
      onProgress(f - 0.5, 1, label);
    }, 1000);

    const body = JSON.stringify({
      selfieBase64: selfieBase64,
      selfieType: selfieType,
      items: layers.map(function (cat) { return { product_id: outfit[cat].product.id, slot: cat }; })
    });

    try {
      let res, data = {};
      for (let attempt = 1; attempt <= 2; attempt++) {
        res = await fetch('/api/tryon', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body });
        data = await res.json().catch(function () { return {}; });
        if (res.ok) break;
        console.warn('[tryon] attempt ' + attempt + ' status=' + res.status, data.details || data.error || '');
        /* 只有暫時性錯誤才重試(後端已經自動換過備援模型) */
        if (attempt === 1 && (res.status === 429 || res.status === 503 || res.status === 504)) {
          await new Promise(function (r) { setTimeout(r, 3000); });
          continue;
        }
        break;
      }
      if (!res.ok || !data.success || !data.image) {
        if (data.error === 'content_blocked') throw new Error(data.message || '上傳的照片不符規範，請更換照片再試。');
        if (data.message) throw new Error(data.message);
        if (res.status === 429) throw new Error('目前排隊人數較多，請稍後再試！');
        throw new Error(data.error || ('系統忙碌 (' + res.status + ')'));
      }
      const results = layers.map(function (cat) {
        return { category: cat, image: data.image, mimeType: data.mimeType || 'image/png', product: outfit[cat].product };
      });
      onComplete(results, selfieSrc);
    } catch (err) {
      onError(err.message || '發生錯誤，請重試');
    } finally {
      clearInterval(ticker);
      isProcessing = false;
    }
  }

  function filterProductsByCategory(products, targetCat) {
    return products.filter(function(p) { return resolveCategory(p) === targetCat; });
  }

  function isTryOnCategory(product) { return resolveCategory(product) !== null; }

  window.OutfitBuilder = {
    resolveCategory, setSelfie, setItem, removeItem, getOutfit,
    getItemCount, getSelectedLayers, clearOutfit, renderOutfitPanel,
    executeTryOn, filterProductsByCategory, isTryOnCategory,
    CATEGORY_LABELS, LAYER_ORDER
  };
})();
