/**
 * outfit-builder.js â Outfit Composition Engine
 * Manages layered try-on: top â bottom â bag â hat
 * Each layer uses the previous result as the new base image
 */

(function () {
  'use strict';

  /* ââ Category mapping from product data ââââââââââââââââââââ */
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
    // Other â fallback to top for clothing-like items
    'SETS': 'top', 'DRESSES': 'top'
  };

  /* ââ UI labels per category ââââââââââââââââââââââââââââââââ */
  const CATEGORY_LABELS = {
    top:    { tw: 'ä¸è¡£',  en: 'Top',   icon: 'ð' },
    bottom: { tw: 'è¤²å­',  en: 'Bottom', icon: 'ð' },
    bag:    { tw: 'èå',  en: 'Bag',    icon: 'ð' },
    hat:    { tw: 'å¸½å­',  en: 'Hat',    icon: 'ð§¢' }
  };

  /* ââ Processing order (determines try-on sequence) âââââââââ */
  const LAYER_ORDER = ['top', 'bottom', 'bag', 'hat'];

  /* ââ Outfit state ââââââââââââââââââââââââââââââââââââââââââ */
  const outfit = {
    top: null,    // { product, imageUrl }
    bottom: null,
    bag: null,
    hat: null
  };

  let selfieBase64 = null;
  let selfieType = 'image/jpeg';
  let selfieSrc = null;
  let isProcessing = false;

  /* ââ Public API ââââââââââââââââââââââââââââââââââââââââââââ */

  /** Resolve product category string to our 4 types */
  function resolveCategory(product) {
    const cat = (product.category || '').toUpperCase().trim();
    return CATEGORY_MAP[cat] || null;
  }

  /** Set selfie data */
  function setSelfie(base64, type, src) {
    selfieBase64 = base64;
    selfieType = type || 'image/jpeg';
    selfieSrc = src;
  }

  /** Add or replace item in outfit */
  function setItem(category, product) {
    if (!CATEGORY_LABELS[category]) return false;
    const imageUrl = window._getProductImageSrc ? window._getProductImageSrc(product) : null;
    outfit[category] = { product, imageUrl };
    renderOutfitPanel();
    return true;
  }

  /** Remove item from outfit */
  function removeItem(category) {
    outfit[category] = null;
    renderOutfitPanel();
  }

  /** Get current outfit state */
  function getOutfit() {
    return { ...outfit };
  }

  /** Get how many items are selected */
  function getItemCount() {
    return LAYER_ORDER.filter(k => outfit[k] !== null).length;
  }

  /** Get ordered list of selected layers */
  function getSelectedLayers() {
    return LAYER_ORDER.filter(k => outfit[k] !== null);
  }

  /** Clear entire outfit */
  function clearOutfit() {
    LAYER_ORDER.forEach(k => outfit[k] = null);
    renderOutfitPanel();
  }

  /* ââ Render outfit panel (sidebar showing selected items) ââ */
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
          + '<button class="outfit-slot-remove" data-remove-cat="' + cat + '" title="ç§»é¤">â</button>'
          + '</div>';
      } else {
        html += '<div class="outfit-slot outfit-slot-empty" data-cat="' + cat + '">'
          + '<span class="outfit-slot-placeholder">' + label.icon + ' ' + catLabel + '</span>'
          + '</div>';
      }
    });

    panel.innerHTML = html;

    // Attach remove handlers
    panel.querySelectorAll('[data-remove-cat]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        removeItem(btn.dataset.removeCat);
      });
    });

    // Update try-on button state
    const tryBtn = document.getElementById('outfit-tryon-btn');
    if (tryBtn) {
      const count = getItemCount();
      tryBtn.disabled = count === 0;
      const btnLabel = lang === 'en'
        ? 'Try On Outfit (' + count + ')'
        : 'éå§è©¦ç©¿ (' + count + ' ä»¶)';
      tryBtn.textContent = count > 0 ? 'â¨ ' + btnLabel : (lang === 'en' ? 'Select items first' : 'è«åé¸æåå');
    }
  }

  /* ââ Layered try-on execution ââââââââââââââââââââââââââââââ */
  async function executeTryOn(onProgress, onComplete, onError) {
    if (isProcessing) return;
    if (!selfieBase64) { onError('è«åä¸å³ç§ç'); return; }

    const layers = getSelectedLayers();
    if (layers.length === 0) { onError('è«è³å°é¸æä¸ä»¶åå'); return; }

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
          if (res.status === 429) throw new Error('ç®åæéäººæ¸è¼å¤ï¼è«ç¨å¾åè©¦ï¼');
          if (res.status >= 500) throw new Error('ç³»çµ±æ«æå¿ç¢ï¼è«ç¨ååè©¦ï¼');
          throw new Error('API é¯èª¤ (' + res.status + ')');
        }

        const data = await res.json();

        if (data.success && data.image) {
          currentBase64 = data.image;
          currentType = data.mimeType || 'image/png';
          results.push({
            category: cat,
            image: data.image,
            mimeType: data.mimeType || 'image/png',
            product: item.product
          });
        } else {
          const details = data.details || '';
          if (details.includes('429') || details.includes('quota')) {
            throw new Error('æé$ººæ¸è¼å¤ï¼è«ç¨å¾åè©¦ï¼');
          }
          throw new Error('AI ç¡æ³èçæ­¤çµåï¼è«æå¼µç§çåè©¦ï¼');
        }
      } catch (err) {
        isProcessing = false;
        onError(err.message || 'ç¼çé¯èª¤ï¼è«éè©¦');
        return;
      }
    }

    isProcessing = false;
    onComplete(results, selfieSrc);
  }

  /* ââ Filter products by category âââââââââââââââââââââââââââ */
  function filterProductsByCategory(products, targetCat) {
    return products.filter(function(p) {
      return resolveCategory(p) === targetCat;
    });
  }

  /** Check if a product belongs to any supported try-on category */
  function isTryOnCategory(product) {
    return resolveCategory(product) !== null;
  }

  /* ââ Expose globally âââââââââââââââââââââââââââââââââââââââ */
  window.OutfitBuilder = {
    resolveCategory: resolveCategory,
    setSelfie: setSelfie,
    setItem: setItem,
    removeItem: removeItem,
    getOutfit: getOutfit,
    getItemCount: getItemCount,
    getSelectedLayers: getSelectedLayers,
    clearOutfit: clearOutfit,
    renderOutfitPanel: renderOutfitPanel,
    executeTryOn: executeTryOn,
    filterProductsByCategory: filterProductsByCategory,
    isTryOnCategory: isTryOnCategory,
    CATEGORY_LABELS: CATEGORY_LABELS,
    LAYER_ORDER: LAYER_ORDER
  };
})();

