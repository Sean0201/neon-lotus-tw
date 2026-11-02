/* ═══════════════════════════════════════════════════════════════
 * rack.js — 首頁「本週精選」衣架展示
 * --------------------------------------------------------------------
 * main.js 的 renderFeatured() 選好商品後呼叫 NLRack.render(picks)。
 *   picks: [{ brand, product }]  (brand = main.js BRANDS 裡的物件)
 *
 * 圖片:
 *   products.rack_image (去背 WebP/PNG,migration 020) 有值 → 去背衣服掛在衣架上
 *   沒有值 → 用原本商品照當吊牌卡片掛著,不會壞版
 * 同款不同色:同品牌、品名去掉「 - 顏色」後相同的商品,自動成為色點
 * 加入購物車:直接呼叫 cart.js 的 CartSystem.addToCart(),走原本的結帳流程
 * ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const $ = (s, root = document) => root.querySelector(s);
  const pad = (n) => String(n).padStart(2, '0');
  const nt = (n) => 'NT$' + Number(n || 0).toLocaleString('en-US');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isEn = () => typeof currentLang !== 'undefined' && currentLang === 'en';
  const t = (tw, en) => (isEn() ? en : tw);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const noHover = matchMedia('(hover: none)');

  const TICKER = [
    ['本週精選', "This week's picks"],
    ['越南台灣直送 7–14 天到貨', 'Vietnam → Taiwan in 7–14 days'],
    ['國際配送 · 親自帶回 兩種方式', 'International shipping · Carry-back'],
    ['30+ 越南街頭品牌', '30+ Vietnamese street labels'],
    ['找不到的 來獵物雷達找我', "Can't find it? Try Target Radar"],
  ];

  /* 真正的彈簧曲線:阻尼比 0.42,取樣成 CSS linear();不支援就維持 cubic-bezier */
  (function setSpring() {
    if (!window.CSS || !CSS.supports('transition-timing-function', 'linear(0, 1)')) return;
    const z = 0.42, w = 4.6 / z, wd = w * Math.sqrt(1 - z * z), pts = [];
    for (let i = 0; i <= 50; i++) {
      const x = i / 50;
      const y = 1 - Math.exp(-z * w * x) * (Math.cos(wd * x) + (z * w / wd) * Math.sin(wd * x));
      pts.push(i === 50 ? 1 : +y.toFixed(4));
    }
    document.documentElement.style.setProperty('--rk-spring', `linear(${pts.join(', ')})`);
  })();

  /* ── 商品資料整理 ─────────────────────────────────── */
  // "ÁO THUN CLASSIC BOXY TEE - BLACK"、"AA DOLLAR BOY RINGER TEE // WHITE" → 品名 + 顏色
  // 也處理 "HADES ETE CLUB TEE - BLACK - BLACK"(顏色重複)、"RADBITLE TOP (GREY) - GREY"(括號顏色)
  function splitName(name) {
    const parts = String(name || '').split(/\s+(?:-|–|—|\/\/|\|)\s+/).map((x) => x.trim()).filter(Boolean);
    let base = parts[0] || '';
    const colors = parts.slice(1);
    const paren = base.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (paren) { base = paren[1]; colors.unshift(paren[2]); }
    const seen = new Set();
    const color = colors.filter((c) => { const k = c.toLowerCase(); return seen.has(k) ? false : seen.add(k); }).join(' / ');
    return { base: base.trim(), color };
  }
  // 尺寸標籤去掉顏色:"BLACK / M" → "M"、"1 / GREY" → "1"(購物車仍存原始標籤)
  function sizeText(label, color) {
    const drop = new Set(String(color || '').toLowerCase().split(/\s*\/\s*/).filter(Boolean));
    const kept = String(label).split(/\s*\/\s*/).filter((x) => !drop.has(x.toLowerCase()));
    return kept.length ? kept.join(' / ') : String(label);
  }

  const COLOR_HEX = [
    [/blue\s*grey|blue\s*gray/i, '#7d8ea3'], [/black\s*grey/i, '#3a3942'], [/white\s*grey/i, '#cfcdd4'],
    [/navy/i, '#26324f'], [/black|đen/i, '#1d1c24'], [/white|trắng/i, '#eeedf2'],
    [/grey|gray|xám|ghi/i, '#8d8b94'], [/cream|kem|ivory/i, '#ece2cc'], [/beige|be\b/i, '#d9c9a8'],
    [/khaki/i, '#b5a27a'], [/brown|nâu|coffee/i, '#6e4f3a'], [/blue|xanh dương|denim/i, '#4a6fa5'],
    [/green|xanh lá|olive/i, '#4f7a55'], [/red|đỏ/i, '#b3263a'], [/pink|hồng/i, '#e58fb0'],
    [/purple|tím/i, '#8b5cf6'], [/yellow|vàng/i, '#e2c044'], [/orange|cam/i, '#e07a3a'],
    [/rose/i, '#e8a3b6'], [/gold/i, '#c9a44c'], [/silver/i, '#c0c0c8'],
  ];
  const colorHex = (label) => (COLOR_HEX.find(([re]) => re.test(label)) || [])[1] || null;

  const photoUrl = (p) => (p.images?.gallery?.[0]?.original_url) || p.images?.gallery?.[0]?.url || p.original_cover_url || p.images?.cover || '';

  function siblingsOf(brand, product) {
    const { base } = splitName(product.name);
    const key = base.toLowerCase();
    const list = (brand.products || []).filter((q) => splitName(q.name).base.toLowerCase() === key && photoUrl(q));
    return list.length ? list : [product];
  }

  /* ── 去背圖 / 描述:額外查詢,欄位不存在或失敗都不影響畫面 ── */
  const rackImg = {};      // product_id → url
  const descCache = {};    // product_id → string
  const sb = () => {
    try { return window.AuthSystem?._getClient?.() || null; } catch (_) { return null; }
  };
  async function fetchRackImages(ids) {
    const client = sb();
    if (!client || !ids.length) return false;
    try {
      const { data, error } = await client.from('products').select('id, rack_image').in('id', ids);
      if (error) throw error;
      let changed = false;
      for (const r of data || []) {
        if (r.rack_image && rackImg[r.id] !== r.rack_image) { rackImg[r.id] = r.rack_image; changed = true; }
      }
      return changed;
    } catch (err) {
      console.warn('[rack] rack_image 讀取失敗(可能尚未跑 migration 020),改用商品照:', err?.message || err);
      return false;
    }
  }
  async function fetchDesc(id) {
    if (id in descCache) return descCache[id];
    const client = sb();
    if (!client) return '';
    try {
      const { data, error } = await client.from('products').select('description_zh').eq('id', id).maybeSingle();
      if (error) throw error;
      descCache[id] = (data?.description_zh || '').trim();
    } catch (_) {
      descCache[id] = '';
    }
    return descCache[id];
  }

  /* ── 衣架配合每件衣服:藏在衣服裡、兩端收在肩膀內側 ─────────────
   * 1. 量每列不透明範圍(最左 ~ 最右),最寬的一列 = maxSpan
   * 2. 肩線 = 第一個寬度 ≥ 55% maxSpan 的列 → 帽子(較窄)會被略過,帽 T / 外套掛在肩膀
   * 3. 衣架橫桿寬 = 肩寬 × 0.8,兩端落在肩線下方一點(含肩膀下垂量)
   * 4. 掛勾長度可變:帽子越高,掛勾越長,從帽子後面延伸到衣桿
   * 所有尺寸以衣服顯示寬度 W 為單位,寫進 hangGeo[url]。
   * 圖片不允許跨網域讀取時沒有 hangGeo,改用預設衣架。 */
  const hangGeo = {};         // url → { ct, hw, neckY, endY } | null
  const drapeSrc = {};        // url → 肩膀下垂後的 blob URL
  const hangJobs = {};        // url → Promise

  /* 自然垂吊:平拍照的袖子是水平攤開的,掛起來時肩膀會順著衣架往下垂。
   * 每一直條往下壓 d(x) = (離中線距離 - 領口半寬) × 斜率,
   * 頂端整段下移 d、底部(下襬)不動 → 肩膀和袖子下垂,下襬維持水平。 */
  const DRAPE_NECK = 0.09;    // 領口半寬(佔圖寬比例),這段不下垂
  const DRAPE_SLOPE = 0.3;    // 下垂斜率
  function drape(im) {
    const w = im.naturalWidth, h = im.naturalHeight;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const cx = w / 2, neck = w * DRAPE_NECK, step = 2;
    for (let x = 0; x < w; x += step) {
      const sw = Math.min(step, w - x);
      const d = Math.max(0, Math.abs(x + sw / 2 - cx) - neck) * DRAPE_SLOPE;
      ctx.drawImage(im, x, 0, sw, h, x, d, sw, h - d);
    }
    fillHoles(ctx, w, h);
    return new Promise((r) => c.toBlob((b) => r(b ? URL.createObjectURL(b) : null), 'image/webp', 0.9));
  }

  /* 從模特兒照取出的衣服,原本脖子的位置會是被衣服包住的透明洞,衣架會從洞裡露出來。
   * 從四邊往內找「連到外面」的透明區域;剩下被包住的透明像素補成深色內裡。 */
  function fillHoles(ctx, w, h) {
    const img = ctx.getImageData(0, 0, w, h), px = img.data;
    const clear = (i) => px[i * 4 + 3] < 128;
    const out = new Uint8Array(w * h), stack = [];
    const push = (i) => { if (!out[i] && clear(i)) { out[i] = 1; stack.push(i); } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (stack.length) {
      const i = stack.pop(), x = i % w;
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (i >= w) push(i - w);
      if (i < w * (h - 1)) push(i + w);
    }
    let filled = 0;
    for (let i = 0; i < w * h; i++) {
      if (!out[i] && clear(i)) {
        px[i * 4] = 22; px[i * 4 + 1] = 20; px[i * 4 + 2] = 26; px[i * 4 + 3] = 255;
        filled++;
      }
    }
    if (filled) ctx.putImageData(img, 0, 0);
  }

  const HOOK_H = 0.09;        // 掛勾彎鉤 + 最短頸部(W)
  const ARM_SLOPE = 0.36;     // 衣架斜度(兩端比頸部低 = 半寬 × 斜率)
  function measure(im) {
    const w = 120, h = Math.max(1, Math.round(im.naturalHeight * w / im.naturalWidth));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(im, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const span = new Array(h).fill(0), mid = new Array(h).fill(0.5), fill = new Array(h).fill(0);
    const colTop = new Array(w).fill(-1);       // 每一直條最上面的不透明像素
    let top = -1, maxSpan = 0;
    for (let y = 0; y < h; y++) {
      let x0 = -1, x1 = -1;
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 40) {
          fill[y]++;
          if (x0 < 0) x0 = x;
          x1 = x;
          if (colTop[x] < 0) colTop[x] = y;
        }
      }
      if (x0 >= 0) { span[y] = (x1 - x0 + 1) / w; mid[y] = (x0 + x1 + 1) / 2 / w; if (top < 0) top = y; }
      if (span[y] > maxSpan) maxSpan = span[y];
    }
    if (top < 0) return null;
    // 肩線:左右範圍夠寬,而且中間實際有布料(兩條分很開的細帶不算)
    let sh = top;
    while (sh < h - 1 && (span[sh] < maxSpan * 0.55 || fill[sh] / w < span[sh] * 0.6)) sh++;
    const probe = Math.min(h - 1, sh + Math.round(w * 0.03));
    const shoulder = Math.max(span[sh], span[probe]);
    // 以下都換成 W 單位(圖片寬 = W),座標以衣服頂端為 0
    const half = Math.max(0.15, Math.min(0.4, shoulder * 0.8 / 2));   // 橫桿半寬
    // 衣架中心對齊肩線中心(模特兒照取出的衣服常常左右不對稱),最多偏 8%
    const cx = Math.max(0.42, Math.min(0.58, mid[probe]));
    // 沿著衣架臂逐點檢查:每一點的橫桿都要在布料上緣(含肩膀下垂)下方 inset
    // → 帽子會被略過(帽子比肩膀高),肩膀較低的那一側會把衣架整體往下壓
    const inset = 0.035;
    let neckRel = sh / w + inset;
    for (let x = Math.round((cx - half) * w); x <= Math.round((cx + half) * w); x++) {
      if (x < 0 || x >= w || colTop[x] < 0) continue;
      const fx = (x + 0.5) / w;
      const droop = Math.max(0, Math.abs(fx - 0.5) - DRAPE_NECK) * DRAPE_SLOPE;
      const edge = colTop[x] / w + droop;
      // 帽子比肩線高的部分不算(衣架在帽子後面),只看肩線附近的布料
      if (edge < sh / w - 0.02) continue;
      // 領口中間不算(V 領、綁脖的開口很深),只看兩側肩膀那段衣架臂
      if (Math.abs(fx - cx) < half * 0.4) continue;
      neckRel = Math.max(neckRel, edge + inset - Math.abs(fx - cx) * ARM_SLOPE);
    }
    // 太長的衣服(套裝、洋裝)縮小顯示,高度最多約 1.35 倍衣寬;以下換成縮放後的 W 單位
    const cs = Math.min(1, 1.35 / (h / w));
    let hw = half * cs, ccx = 0.5 + (cx - 0.5) * cs, neck = neckRel * cs;
    // 綁脖 / 細肩帶:肩線上方只有很長的細帶 → 帶子頂端直接勾在掛勾上,橫桿縮小藏在帶子後面
    if ((sh - top) / w > 0.22) {
      neck = (top / w + 0.03) * cs;
      hw = 0.05;
    }
    const armDrop = hw * ARM_SLOPE;
    // 至少往下放 0.12W:衣桿下方到領口 / 帽子之間露出一段掛勾
    const ct = Math.max(0.12, HOOK_H - neck);
    const neckY = ct + neck;
    return { ct, hw, neckY, endY: neckY + armDrop, topY: top / w * cs, cx: ccx, cs };
  }

  function analyzeHang(url) {
    if (!hangJobs[url]) {
      hangJobs[url] = new Promise((resolve) => {
        const im = new Image();
        im.crossOrigin = 'anonymous';
        im.onload = async () => {
          try {
            hangGeo[url] = measure(im);
            drapeSrc[url] = await drape(im);
          } catch (_) {
            hangGeo[url] = null;   // 圖片不允許跨網域讀取 → 維持原圖與預設衣架
          }
          resolve();
        };
        im.onerror = () => { hangGeo[url] = null; resolve(); };
        im.src = url;
      });
    }
    return hangJobs[url];
  }

  // 依 hangGeo 畫衣架(座標:x 0~100 = 衣服寬度,y 以同樣比例往下)
  function fittedHangerSVG(g) {
    const id = 'rkch' + (uid++);
    const k = 100;
    const c = (g.cx ?? 0.5) * k;
    const nY = g.neckY * k, eY = g.endY * k, xl = c - g.hw * k, xr = c + g.hw * k;
    const H = eY + 3;
    return `<svg class="rk-hanger is-fit" viewBox="0 0 100 ${H.toFixed(2)}" style="height:calc(var(--rk-w) * ${(H / 100).toFixed(4)})" aria-hidden="true">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fafaff"/><stop offset=".45" stop-color="#8b8a96"/>
        <stop offset=".6" stop-color="#ffffff"/><stop offset="1" stop-color="#55545f"/></linearGradient></defs>
      <path d="M50 ${nY.toFixed(2)} V9 C50 6.75 53.6 6.1 53.6 3.4 C53.6 1.1 51.8 0.2 50 0.2 C48 0.2 46.6 1.5 46.85 3.15" fill="none" stroke="url(#${id})" stroke-width="1.1" stroke-linecap="round"/>
      <path d="M50 ${(nY - 2).toFixed(2)} L${c.toFixed(2)} ${nY.toFixed(2)} L${xr.toFixed(2)} ${eY.toFixed(2)} Q${(xr + 1.6).toFixed(2)} ${(eY + 1.1).toFixed(2)} ${(xr - 0.6).toFixed(2)} ${(eY + 1.5).toFixed(2)} L${(xl + 0.6).toFixed(2)} ${(eY + 1.5).toFixed(2)} Q${(xl - 1.6).toFixed(2)} ${(eY + 1.1).toFixed(2)} ${xl.toFixed(2)} ${eY.toFixed(2)} L${c.toFixed(2)} ${nY.toFixed(2)}" fill="none" stroke="url(#${id})" stroke-width="1.3" stroke-linejoin="round"/>
    </svg>`;
  }

  // 單品檢視沒有衣桿:衣服往下放 lift,讓掛勾的頸部和彎鉤完整露出來
  const VIEWER_LIFT = 0;
  const lifted = (g, lift) => (lift ? { ...g, ct: g.ct + lift, neckY: g.neckY + lift, endY: g.endY + lift } : g);

  function applyHang(root) {
    root.querySelectorAll('.rk-garment.is-cut[data-hang]').forEach((el) => {
      const url = el.dataset.hang;
      const lift = +el.dataset.lift || 0;
      const set = () => {
        const g = hangGeo[url] && lifted(hangGeo[url], lift);
        if (g) {
          const old = el.querySelector('.rk-hanger');
          if (old && !old.classList.contains('is-fit')) old.outerHTML = fittedHangerSVG(g);
          const cl = el.querySelector('.rk-cloth');
          cl.style.setProperty('--rk-ct', g.ct.toFixed(4));
          cl.style.setProperty('--rk-cs', g.cs.toFixed(4));
        }
        const img = el.querySelector('.rk-cloth img');
        if (drapeSrc[url] && img && img.getAttribute('src') !== drapeSrc[url]) img.src = drapeSrc[url];
      };
      if (url in hangGeo) set();
      else analyzeHang(url).then(set);
    });
  }

  /* ── 本機預覽模式(只在 localhost 生效,正式網站不受影響)───────
   * http://localhost:5173/?rack-preview
   * 讀 output/rack/preview.json:{ featured: [[brand_id, product_id], ...], images: { product_id: url } }
   * 不用改資料庫就能看精選清單 + 去背圖的效果。 */
  const PREVIEW = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) &&
    new URLSearchParams(location.search).has('rack-preview');
  let previewList = null;
  if (PREVIEW) {
    fetch('/output/rack/preview.json', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        previewList = d.featured || [];
        Object.assign(rackImg, d.images || {});
        console.info('[rack] 本機預覽模式:', previewList.length, '件');
        if (typeof window.renderFeatured === 'function') window.renderFeatured();
      })
      .catch((err) => console.warn('[rack] 讀不到 output/rack/preview.json', err));
  }
  function previewPicks() {
    if (!previewList || typeof BRANDS === 'undefined') return null;
    return previewList.map(([bid, pid]) => {
      const brand = BRANDS.find((b) => b.id === bid);
      const product = brand && (brand.products || []).find((p) => p.id === pid);
      return product ? { brand, product } : null;
    }).filter(Boolean);
  }

  /* ── SVG / HTML 片段 ─────────────────────────────── */
  let uid = 0;
  function hangerSVG() {
    const id = 'rkch' + (uid++);
    return `<svg class="rk-hanger" viewBox="0 -3 124 62" aria-hidden="true">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fafaff"/><stop offset=".45" stop-color="#8b8a96"/>
        <stop offset=".6" stop-color="#ffffff"/><stop offset="1" stop-color="#55545f"/></linearGradient></defs>
      <path d="M62 29 V19 C62 14 70 12.5 70 6.5 C70 1.5 66 -1 62 -1 C57.5 -1 54.5 2 55 6" fill="none" stroke="url(#${id})" stroke-width="2.6" stroke-linecap="round"/>
      <rect x="59.5" y="26" width="5" height="6" rx="1.5" fill="url(#${id})"/>
      <path d="M62 30 L116 52.5 Q121.5 55.5 115.5 56.5 L8.5 56.5 Q2.5 55.5 8 52.5 Z" fill="none" stroke="url(#${id})" stroke-width="3" stroke-linejoin="round"/>
    </svg>`;
  }
  function garmentHTML(p, eager, lift = 0) {
    const cut = rackImg[p.id];
    const src = cut || photoUrl(p);
    const load = eager ? 'eager' : 'lazy';
    const shown = (cut && drapeSrc[cut]) || src;
    if (cut) {
      // 去背衣服:衣架依衣服量身畫在布料後方,只露出掛勾
      const g = hangGeo[cut] && lifted(hangGeo[cut], lift);
      return `<div class="rk-garment is-cut" data-hang="${esc(cut)}"${lift ? ` data-lift="${lift}"` : ''}>${g ? fittedHangerSVG(g) : hangerSVG()}` +
        `<div class="rk-cloth"${g ? ` style="--rk-ct:${g.ct.toFixed(4)};--rk-cs:${g.cs.toFixed(4)}"` : ''}>` +
        `<img src="${esc(shown)}" alt="" draggable="false" loading="${load}" decoding="async" referrerpolicy="no-referrer"></div></div>`;
    }
    return `<div class="rk-garment">${hangerSVG()}<div class="rk-cloth is-photo">` +
      `<img src="${esc(shown)}" alt="" draggable="false" loading="${load}" decoding="async" referrerpolicy="no-referrer"></div></div>`;
  }

  /* ── 狀態 ─────────────────────────────────────────── */
  let picks = [];      // [{ brand, product }]
  let on = -1;
  let els = null;      // DOM refs

  function ensureDom() {
    if (els) return els;
    const section = document.getElementById('rack-section');
    if (!section) return null;
    els = {
      section,
      rail: $('#rk-rail', section),
      caption: $('#rk-caption', section),
      count: $('#rk-count', section),
      track: $('#rk-track', section),
    };
    bindRail();
    buildViewer();
    return els;
  }

  function setOn(i) {
    if (!els || i === on) return;
    on = i;
    [...els.rail.children].forEach((el, k) => el.classList.toggle('on', k === i));
    if (i < 0) {
      els.caption.innerHTML = `<div class="hint">${noHover.matches ? t('點一下衣架 · 再點查看', 'Tap a hanger · tap again to view') : t('滑過衣架 · 點擊查看', 'Hover the rack · click to view')}</div>`;
    } else {
      const { product: p } = picks[i];
      const price = p.price?.twd_shipping || p.price?.twd_carryback;
      els.caption.innerHTML = `<div class="nm">${esc(splitName(p.name).base)}</div>` +
        `<div class="sub">${pad(i + 1)} / ${pad(picks.length)}${price ? ' · ' + nt(price) : ''}</div>`;
    }
  }

  function renderRail() {
    els.rail.innerHTML = picks.map(({ brand, product: p }, i) =>
      `<div class="rk-item" role="button" tabindex="0" data-i="${i}" aria-label="${pad(i + 1)} ${esc(brand.name)} ${esc(p.name)}">${garmentHTML(p, i < 6)}</div>`).join('');
    applyHang(els.rail);
    // 件數少時每件多佔一點寬度,衣架不會全擠在中間
    const n = picks.length;
    els.section.style.setProperty('--rk-slotf', n <= 6 ? 0.34 : n <= 10 ? 0.26 : 0.2);
    els.count.textContent = pad(n);
    const tick = TICKER.map(([tw, en]) => `<span>${esc(t(tw, en))}</span><span class="s">✦</span>`).join('');
    els.track.innerHTML = tick + tick;
    const prev = on; on = -2; setOn(prev < picks.length ? prev : -1);
  }

  function bindRail() {
    const rail = els.rail;
    rail.addEventListener('mouseover', (e) => {
      if (noHover.matches) return;
      const it = e.target.closest('.rk-item');
      if (it) setOn(+it.dataset.i);
    });
    rail.addEventListener('mouseleave', () => { if (!noHover.matches) setOn(-1); });
    rail.addEventListener('click', (e) => {
      const it = e.target.closest('.rk-item');
      if (!it) return;
      const i = +it.dataset.i;
      // 觸控裝置:第一下翻正,第二下才打開
      if (noHover.matches && on !== i) { setOn(i); return; }
      openViewer(i);
    });
    rail.addEventListener('focusin', (e) => { const it = e.target.closest('.rk-item'); if (it) setOn(+it.dataset.i); });
    rail.addEventListener('keydown', (e) => {
      const it = e.target.closest('.rk-item');
      if (it && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openViewer(+it.dataset.i); }
    });
    document.addEventListener('click', (e) => {
      if (noHover.matches && !e.target.closest('.rk-item, .rk-viewer')) setOn(-1);
    });
  }

  /* ── 單品檢視 ─────────────────────────────────────── */
  let viewer, vStage, vThumbs, vInfo, toast;
  let view = 0;          // 0 = 衣架視圖;1.. = 商品照第幾張(背面 / 細節 / 穿搭)
  let cur = -1;          // picks index
  let curProduct = null; // 目前顯示的商品(可能是色點切過去的同款)
  let size = null, ship = 'shipping', lastFocus = null;

  function buildViewer() {
    viewer = document.createElement('div');
    viewer.className = 'rk-viewer';
    viewer.setAttribute('role', 'dialog');
    viewer.setAttribute('aria-modal', 'true');
    viewer.setAttribute('aria-label', '單品檢視');
    viewer.innerHTML = `
      <button class="rk-close" type="button">ESC ✕</button>
      <div class="rk-vbox">
        <button class="rk-arrow prev" type="button" aria-label="上一件"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 2 4 8l6 6"/></svg></button>
        <div class="rk-vcol">
          <div class="rk-vstage"></div>
          <div class="rk-thumbs" role="tablist" aria-label="商品照片"></div>
        </div>
        <div class="rk-info"></div>
        <button class="rk-arrow next" type="button" aria-label="下一件"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2l6 6-6 6"/></svg></button>
      </div>`;
    document.body.appendChild(viewer);
    toast = document.createElement('div');
    toast.className = 'rk-toast';
    toast.setAttribute('role', 'status');
    document.body.appendChild(toast);
    vStage = $('.rk-vstage', viewer);
    vThumbs = $('.rk-thumbs', viewer);
    vInfo = $('.rk-info', viewer);

    $('.rk-close', viewer).addEventListener('click', closeViewer);
    $('.rk-arrow.prev', viewer).addEventListener('click', () => step(-1));
    $('.rk-arrow.next', viewer).addEventListener('click', () => step(1));
    viewer.addEventListener('click', onViewerClick);
    document.addEventListener('keydown', (e) => {
      if (cur < 0) return;
      if (e.key === 'Escape') closeViewer();
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
    });
    let tx = null, ty = null;
    viewer.addEventListener('touchstart', (e) => { tx = e.touches[0].clientX; ty = e.touches[0].clientY; }, { passive: true });
    viewer.addEventListener('touchend', (e) => {
      if (tx === null) return;
      const dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
      tx = ty = null;
    });
  }

  function infoHTML(brand, p) {
    const { base, color } = splitName(p.name);
    const sibs = siblingsOf(brand, p);
    const priceS = p.price?.twd_shipping, priceC = p.price?.twd_carryback;
    if (ship === 'shipping' && !priceS && priceC) ship = 'carryback';
    if (ship === 'carryback' && !priceC && priceS) ship = 'shipping';
    const sizes = Array.isArray(p.sizes) ? p.sizes : [];
    const sizesLoaded = sizes.length > 0 || p._rkSizesLoaded;
    if (size && !sizes.some((s) => s.label === size && s.available !== false)) size = null;

    const shipBtn = (key, label, price) => price
      ? `<button type="button" class="rk-ship${ship === key ? ' on' : ''}" data-ship="${key}"><small>${label}</small><b>${nt(price)}</b></button>` : '';
    const sizeBlock = sizes.length
      ? `<div class="rk-sizes">${sizes.map((s) =>
          `<button type="button" class="rk-size${s.label === size ? ' on' : ''}" data-s="${esc(s.label)}"${s.available === false ? ' disabled' : ''}>${esc(sizeText(s.label, color))}</button>`).join('')}</div>`
      : `<div class="rk-note">${sizesLoaded ? t('單一尺寸 / 詳見尺寸表', 'One size · see size chart') : t('尺寸載入中…', 'Loading sizes…')}</div>`;

    return `
      <div class="no">${pad(cur + 1)} / ${pad(picks.length)}</div>
      <div class="brandline">${esc(brand.name || brand.id)}</div>
      <h3>${esc(base)}</h3>
      ${color || p.tag ? `<div class="zh">${esc([color, p.tag].filter(Boolean).join(' · '))}</div>` : ''}
      ${p.is_promo ? `<span class="promo">${t('品牌特價', 'Brand promo')}${p.promo_note ? ' · ' + esc(p.promo_note) : ''}</span>` : ''}
      <div class="desc">${esc(descCache[p.id] || '')}</div>
      <div class="rk-lbl"><span>${t('配送方式', 'Delivery')}</span></div>
      <div class="rk-ships">${shipBtn('shipping', t('國際配送', 'Shipping'), priceS)}${shipBtn('carryback', t('親自帶回', 'Carry-back'), priceC)}</div>
      ${sibs.length > 1 ? `<div class="rk-lbl"><span>${t('配色', 'Color')} · ${esc(color || '—')}</span></div>
        <div class="rk-dots">${sibs.map((q) => {
          const c = splitName(q.name).color;
          // 認得的顏色用色票;認不得(如 ROSE GLOW、PETITE BOW)就用商品小圖
          const hex = colorHex(c);
          const bg = hex ? `background:${hex}` : `background:#2a2833 center / cover no-repeat url('${esc(photoUrl(q))}')`;
          return `<button type="button" class="rk-dot${q.id === p.id ? ' on' : ''}" data-pid="${esc(q.id)}" style="${bg}" aria-label="${esc(c || q.name)}" title="${esc(c)}"></button>`;
        }).join('')}</div>` : ''}
      <div class="rk-lbl"><span>${t('尺寸', 'Size')}</span><button type="button" data-act="sizechart">${t('尺寸表', 'Size chart')} →</button></div>
      ${sizeBlock}
      ${p.tag === 'SETS' ? `<div class="rk-note">${t('套組上下身為同一尺寸;需要不同尺寸請在購物車備註告知。', 'Top and bottom come in the same size — leave a note in your cart for mixed sizes.')}</div>` : ''}
      <button type="button" class="rk-add" data-act="add"${p.sold_out ? ' disabled' : ''}>${p.sold_out ? t('已售完', 'Sold out') : t('加入購物車', 'Add to cart')}</button>
      <button type="button" class="rk-brandlink" data-act="brand">${t('看 ' + esc(brand.name) + ' 全部商品', 'All ' + esc(brand.name) + ' items')} →</button>`;
  }

  /* 商品照(背面 / 細節 / 穿搭);去背圖本身也是第一張時跳過重複 */
  const galleryOf = (p) => {
    const seen = new Set();
    return (p.images?.gallery || []).map((g) => g.original_url || g.url).filter((u) => u && !seen.has(u) && seen.add(u)).slice(0, 12);
  };

  function renderThumbs() {
    const p = curProduct;
    const photos = galleryOf(p);
    if (!photos.length) { vThumbs.innerHTML = ''; return; }
    const hangSrc = rackImg[p.id] || photoUrl(p);
    vThumbs.innerHTML =
      `<button type="button" class="rk-thumb is-hanger${view === 0 ? ' on' : ''}" data-view="0" role="tab" aria-selected="${view === 0}" aria-label="${t('衣架', 'On the rack')}">` +
        `<img src="${esc(hangSrc)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"></button>` +
      photos.map((u, k) =>
        `<button type="button" class="rk-thumb${view === k + 1 ? ' on' : ''}" data-view="${k + 1}" role="tab" aria-selected="${view === k + 1}" aria-label="${t('照片', 'Photo')} ${k + 1}">` +
          `<img src="${esc(u)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"></button>`).join('');
  }

  // 左邊大圖:衣架視圖,或第 view 張商品照
  function renderStage(dir) {
    const p = curProduct;
    const photos = galleryOf(p);
    if (view > photos.length) view = 0;
    if (view === 0) {
      vStage.innerHTML = garmentHTML(p, true, VIEWER_LIFT);
      applyHang(vStage);
    } else {
      vStage.innerHTML = `<div class="rk-garment rk-photo"><img src="${esc(photos[view - 1])}" alt="${esc(splitName(p.name).base)} ${view}" decoding="async" referrerpolicy="no-referrer"></div>`;
    }
    vThumbs.querySelectorAll('.rk-thumb').forEach((b) => {
      const on = +b.dataset.view === view;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on);
    });
    // 新衣服從 ±80deg 用彈簧轉進來,方向跟著切換方向
    if (dir && !reduced.matches) {
      const g = vStage.querySelector('.rk-garment');
      g.style.transition = 'none';
      g.style.transform = `rotateY(${dir > 0 ? 80 : -80}deg)`;
      void g.offsetWidth;
      g.style.transition = '';
      g.style.transform = 'rotateY(0deg)';
    }
  }

  function renderViewer(dir) {
    const { brand } = picks[cur];
    const p = curProduct;
    view = 0;
    renderThumbs();
    renderStage(dir);
    vInfo.innerHTML = infoHTML(brand, p);

    // 背景補資料:尺寸(loadBrandDetail)+ 描述
    const want = p;
    if (!p._rkSizesLoaded && typeof window.loadBrandDetail === 'function') {
      window.loadBrandDetail(brand.id).catch(() => {}).finally(() => {
        want._rkSizesLoaded = true;
        if (curProduct === want) { vInfo.innerHTML = infoHTML(brand, want); renderThumbs(); }
      });
    }
    if (!(p.id in descCache)) {
      fetchDesc(p.id).then(() => { if (curProduct === want) vInfo.innerHTML = infoHTML(brand, want); });
    }
  }

  function showProduct(i, product, dir) {
    cur = i;
    curProduct = product || picks[i].product;
    renderViewer(dir);
  }
  function openViewer(i) {
    lastFocus = document.activeElement;
    size = null;
    showProduct(i, null, 1);
    viewer.classList.add('open');
    document.body.style.overflow = 'hidden';
    $('.rk-close', viewer).focus({ preventScroll: true });
  }
  function closeViewer() {
    viewer.classList.remove('open');
    document.body.style.overflow = '';
    cur = -1; curProduct = null;
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
  }
  const step = (d) => { size = null; showProduct((cur + d + picks.length) % picks.length, null, d); };

  function onViewerClick(e) {
    if (e.target === viewer || e.target.classList.contains('rk-vbox')) return closeViewer();
    const { brand } = picks[cur] || {};
    const th = e.target.closest('.rk-thumb');
    if (th) {
      const v = +th.dataset.view;
      if (v !== view) { const d = v > view ? 1 : -1; view = v; renderStage(d); }
      return;
    }
    const dot = e.target.closest('.rk-dot');
    if (dot) {
      const q = (brand.products || []).find((x) => String(x.id) === dot.dataset.pid);
      if (q && q !== curProduct) showProduct(cur, q, 1);
      return;
    }
    const sz = e.target.closest('.rk-size');
    if (sz && !sz.disabled) {
      size = sz.dataset.s;
      vInfo.querySelectorAll('.rk-size').forEach((b) => b.classList.toggle('on', b === sz));
      return;
    }
    const sh = e.target.closest('.rk-ship');
    if (sh) {
      ship = sh.dataset.ship;
      vInfo.querySelectorAll('.rk-ship').forEach((b) => b.classList.toggle('on', b === sh));
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'add') addToCart();
    else if (act === 'sizechart' && typeof window.showSizeChart === 'function') window.showSizeChart(curProduct.id);
    else if (act === 'brand' && typeof window.showPage === 'function') { closeViewer(); window.showPage('brand', brand.id); }
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), 2000);
  }

  function addToCart() {
    const p = curProduct;
    if (!p || p.sold_out) return;
    const sizes = Array.isArray(p.sizes) ? p.sizes : [];
    if (sizes.length && !size) { showToast(t('請先選擇尺寸', 'Please pick a size')); return; }
    if (!window.CartSystem?.addToCart) { showToast(t('購物車暫時無法使用', 'Cart unavailable')); return; }
    window.CartSystem.addToCart(p, size, ship);

    // 同步頁首購物車數字(與 cart.js updateCartIcon 相同邏輯)
    const count = window.CartSystem.getCartCount();
    document.querySelectorAll('.neon-cart-icon-wrapper').forEach((icon) => {
      let badge = icon.querySelector('.neon-cart-badge');
      if (!badge) { badge = document.createElement('span'); badge.className = 'neon-cart-badge'; icon.appendChild(badge); }
      badge.textContent = count;
      badge.classList.remove('rk-bump'); void badge.offsetWidth; badge.classList.add('rk-bump');
    });
    const { base, color } = splitName(p.name);
    const sz = size ? sizeText(size, color) : '';
    showToast(t(`已加入購物車:${base}${sz ? `(${sz})` : ''}`, `Added: ${base}${sz ? ` (${sz})` : ''}`));
  }

  /* ── 對外 API ─────────────────────────────────────── */
  async function render(nextPicks) {
    if (!ensureDom()) return;
    // 同款不同色只掛一件(第一個出現的顏色);其他顏色在單品檢視用色點切換
    const seen = new Set();
    picks = (previewPicks() || nextPicks || []).filter(({ brand, product }) => {
      if (!photoUrl(product)) return false;
      const key = brand.id + '|' + splitName(product.name).base.toLowerCase();
      return seen.has(key) ? false : seen.add(key);
    });
    els.section.hidden = picks.length === 0;
    if (!picks.length) return;
    renderRail();

    // 抓這批商品 + 同款不同色的去背圖,有新資料就重畫
    const ids = new Set();
    picks.forEach(({ brand, product }) => siblingsOf(brand, product).forEach((q) => ids.add(q.id)));
    if (await fetchRackImages([...ids])) renderRail();
  }

  window.NLRack = {
    render,
    close: () => cur >= 0 && closeViewer(),
    // 預覽用:不經資料庫,直接指定某商品的去背圖(上傳前在本機看效果)
    previewRackImage(productId, url) { rackImg[productId] = url; if (els && picks.length) renderRail(); },
    _hang: hangGeo,
  };
})();
