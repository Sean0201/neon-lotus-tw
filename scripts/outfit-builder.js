/**
 * outfit-builder.js — Outfit Composition Engine
 * Manages layered try-on: top → bottom → bag → hat
 * Each layer uses the previous result as the new base image
 */

(function () {
  'use strict';

  /* ── Category mapping from product data ──────────────────── */
  const CATEGORY_MAP = {
    // Tops
    'TOPS': 'top', 'TEES': 'top', 'LONGSLEEVES': 'top', 'TANKS': 'top',
    'SHIRTS': 'top', 'POLOS': 'top', 'HOODIES': 'top', 'SWEATERS': 'top',
    'SWEATSHIRTS': 'top', 'KNITWEAR': 'top', 'JACKETS': 'top', 'OUTERWEAR': 'top',
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
    top:    { tw: '上衣',  en: 'Top',   icon: '👕' },
    bottom: { tw: '褲子',  en: 'Bottom', icon: '👖' },
    bag:    { tw: '背包',  en: 'Bag',    icon: '🎒' },
    hat:    { tw: '帽子',  en: 'Hat',    icon: '🧢' }
  };

  const LAYER_ORDER = ['top', 'bottom', 'bag', 'hat'];

  const outfit = { top: null, bottom: null, bag: null, hat: null };
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

  async function executeTryOn(onProgress, onComplete, onError) {
    if (isProcessing) return;
    if (!selfieBase64) { onError('請先上傳照片'); return; }
    const layers = getSelectedLayers();
    if (layers.length === 0) { onError('請至少選擇一件商品'); return; }
    isProcessing = true;
    let currentBase64 = selfieBase64;
    let currentType = selfieType;
    const results = [];
    for (let i = 0; i < layers.length; i++) {
      const cat = layers[i];
      const item = outfit[cat];
      const label = CATEGORY_LABELS[cat];
      const lang = window.__currentLang || 'tw';
      const stepLabel = lang === 'en'
        ? label.en + ' (' + (i + 1) + '/' + layers.length + ')'
        : label.tw + ' (' + (i + 1) + '/' + layers.length + ')';
      onProgress(i, layers.length, stepLabel, cat);
      try {
        const res = await fetch('/api/tryon', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            selfieBase64: currentBase64,
            selfieType: currentType,
            clothingUrl: item.imageUrl,
            productName: item.product.name || 'item',
            category: cat
          })
        });
        if (!res.ok) {
          if (res.status === 429) throw new Error('目前排隊人數較多，請稍後再試！');
          if (res.status === 504) throw new Error('AI 處理時間較長，請稍後再試一次！⏳');
          if (res.status >= 500) throw new Error('系統暫時忙碌，請稍候再試！');
          throw new Error('API 錯誤 (' + res.status + ')');
        }
        const data = await res.json();
        if (data.success && data.image) {
          currentBase64 = data.image;
          currentType = data.mimeType || 'image/png';
          results.push({ category: cat, image: data.image, mimeType: data.mimeType || 'image/png', product: item.product });
        } else {
          const details = data.details || '';
          if (details.includes('429') || details.includes('quota')) throw new Error('排隊人數較多，請稍後再試！');
          throw new Error('AI 無法處理此組合，請換張照片再試！');
        }
      } catch (err) {
        isProcessing = false;
        onError(err.message || '發生錯誤，請重試');
        return;
      }
    }
    isProcessing = false;
    onComplete(results, selfieSrc);
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
