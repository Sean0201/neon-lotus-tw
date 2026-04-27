#!/usr/bin/env node
/**
 * match-sizes-to-supabase.js
 * --------------------------------------------------------------------
 * 多品牌版: 把 scrape 來的 size_chart / images 透過「商品名稱」 patch 到
 * Supabase 既有商品上，輸出 multi-brand overlay。
 *
 * 設定: 一個品牌一筆對應, 預設讀 scripts/match-config.json
 *   { "pairs": [
 *       { "source": "scripts/data/sptmbr_scrape.json", "target_brand_id": "23september" },
 *       { "source": "scripts/data/aastu_scrape.json",  "target_brand_id": "aastu" }
 *   ]}
 *
 * 用法:
 *   node scripts/match-sizes-to-supabase.js
 *   node scripts/match-sizes-to-supabase.js --config <file>
 *
 * 輸出 (data-overlay.js → window.DATA_OVERLAY):
 *   {
 *     brands: [], products: [],            // 不再 push 新品牌/商品
 *     size_charts: { <product_id>: chart },              // by id (legacy)
 *     image_overlay: { <product_id>: gallery },          // by id
 *     by_name: {                                          // 按品牌分桶
 *       <brand_id>: {
 *         size_charts: { <name_base>: chart },
 *         image_overlay: { <name_base>: gallery }
 *       }, ...
 *     }
 *   }
 *
 * 為什麼 by_name 也按品牌分桶: 商品名稱 "tee" / "shirt" 在不同品牌會撞名。
 * --------------------------------------------------------------------
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { translate } from './translate-vn-sizes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..');
const DATA_FILE    = path.join(ROOT, 'data.js');
const OVERLAY_FILE = path.join(ROOT, 'data-overlay.js');
const CONFIG_FILE  = path.join(__dirname, 'match-config.json');

const DEFAULT_CONFIG = {
  pairs: [
    { source: 'scripts/data/sptmbr_scrape.json', target_brand_id: '23september' },
    { source: 'scripts/data/aastu_scrape.json',  target_brand_id: 'aastu' },
  ]
};

function parseArgs(argv) {
  const o = { config: CONFIG_FILE };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--config') o.config = argv[++i];
  }
  return o;
}

function readJsAssign(file, varName) {
  const raw = fs.readFileSync(file, 'utf-8');
  const re = new RegExp('window\\.' + varName + '\\s*=\\s*([\\s\\S]+?);?\\s*$');
  const m = raw.match(re);
  if (!m) throw new Error(`Cannot parse ${file}: ${varName} assignment not found`);
  return JSON.parse(m[1]);
}

/** 名稱標準化 → 主 base + 多個寬鬆 base (依序嘗試匹配) */
function baseKeys(name) {
  if (!name) return [];
  let s = String(name).toLowerCase();
  s = s.replace(/[\u2018\u2019\u02bc'`"]/g, '');
  s = s.replace(/^\s*23\s*/, '');                     // 23' 前綴 (僅針對 23sptmbr)
  if (s.includes('/')) s = s.split('/')[0];
  s = s.replace(/\([^)]*\)/g, ' ');
  // aastu 用 "//" 分顏色
  if (s.includes('//')) s = s.split('//')[0];
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

/** 防禦性: 重新翻譯一張 size_chart, 確保所有 headers/keys 都是中文 */
function ensureTranslatedChart(sc) {
  if (!sc || !Array.isArray(sc.headers)) return sc;
  const newHeaders = sc.headers.map(h => translate(h) || h);
  const headerMap = {};
  sc.headers.forEach((h, i) => headerMap[h] = newHeaders[i]);
  return {
    ...sc,
    headers: newHeaders,
    rows: (sc.rows || []).map(r => {
      const newValues = {};
      for (const [k, v] of Object.entries(r.values || {})) {
        const nk = headerMap[k] || translate(k) || k;
        newValues[nk] = v;
      }
      return { ...r, values: newValues };
    })
  };
}

function processPair(supaProducts, scrapeProducts, brandId) {
  // 1) 從 scrape 端建立 base → chart / gallery
  const chartByBase = {};
  const galleryByBase = {};
  for (const p of scrapeProducts) {
    if (p.size_chart) {
      const fixed = ensureTranslatedChart(p.size_chart);
      for (const b of baseKeys(p.name)) {
        if (!chartByBase[b]) chartByBase[b] = fixed;
      }
    }
    const g = (p.images && p.images.gallery) || [];
    if (g.length) {
      for (const b of baseKeys(p.name)) {
        if (!galleryByBase[b] || galleryByBase[b].length < g.length) galleryByBase[b] = g;
      }
    }
  }

  // 2) 對 Supabase 端商品 patch
  const sizeChartsById = {};
  const imageOverlayById = {};
  let matched = 0, unmatched = 0, imgPatched = 0;
  const unmatchedExamples = [];
  for (const p of supaProducts) {
    let ch = null, gal = null;
    for (const b of baseKeys(p.name)) {
      if (!ch && chartByBase[b]) ch = chartByBase[b];
      if (!gal && galleryByBase[b]) gal = galleryByBase[b];
      if (ch && gal) break;
    }
    if (ch) {
      sizeChartsById[p.id] = ch;
      matched++;
    } else {
      unmatched++;
      if (unmatchedExamples.length < 8) unmatchedExamples.push(p.id + ' | ' + p.name);
    }
    const supN = ((p.images || {}).gallery || []).length;
    if (gal && gal.length > supN) {
      imageOverlayById[p.id] = gal;
      imgPatched++;
    }
  }

  return {
    sizeChartsById, imageOverlayById,
    by_name: {
      size_charts: chartByBase,
      image_overlay: galleryByBase
    },
    stats: { matched, unmatched, imgPatched, total: supaProducts.length, unmatchedExamples }
  };
}

function loadConfig(file) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
    console.log('✔ 建立預設 match-config.json');
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function main() {
  const args = parseArgs(process.argv);
  const cfg = loadConfig(args.config);
  const data = readJsAssign(DATA_FILE, 'BRANDS_DATA');

  // 整體 overlay 結構
  const overlay = {
    brands: [], products: [],
    size_charts: {},          // 平鋪: by product_id (legacy)
    image_overlay: {},        // 平鋪: by product_id (legacy)
    by_name: {}               // nested: { brand_id: { size_charts, image_overlay } }
  };

  for (const pair of cfg.pairs) {
    const sourceFile = path.isAbsolute(pair.source) ? pair.source : path.join(ROOT, pair.source);
    if (!fs.existsSync(sourceFile)) {
      console.warn(`⚠ skip: source 不存在 ${sourceFile}`);
      continue;
    }
    const raw = JSON.parse(fs.readFileSync(sourceFile, 'utf-8'));
    const scrapeProducts = raw.products || [];
    const supaProducts = data.products.filter(p => p.brand_id === pair.target_brand_id);

    console.log(`\n━━ ${pair.target_brand_id}`);
    console.log(`  source: ${path.relative(ROOT, sourceFile)} (${scrapeProducts.length} 件, ${scrapeProducts.filter(p => p.size_chart).length} 張表)`);
    console.log(`  Supabase: ${supaProducts.length} 件`);

    const result = processPair(supaProducts, scrapeProducts, pair.target_brand_id);
    Object.assign(overlay.size_charts, result.sizeChartsById);
    Object.assign(overlay.image_overlay, result.imageOverlayById);
    overlay.by_name[pair.target_brand_id] = result.by_name;

    const s = result.stats;
    console.log(`  匹配: ${s.matched}/${s.total} (未命中 ${s.unmatched}) | 圖片補強: ${s.imgPatched}`);
    console.log(`  by-name: ${Object.keys(result.by_name.size_charts).length} 張表 / ${Object.keys(result.by_name.image_overlay).length} 套圖`);
    if (s.unmatchedExamples.length) {
      console.log('  未命中示例:');
      s.unmatchedExamples.forEach(x => console.log('    -', x));
    }
  }

  fs.writeFileSync(OVERLAY_FILE,
    '/* eslint-disable */\nwindow.DATA_OVERLAY = ' + JSON.stringify(overlay) + ';',
    'utf-8'
  );
  const kb = (Buffer.byteLength(JSON.stringify(overlay))/1024).toFixed(0);
  console.log(`\n✔ 寫回 data-overlay.js (${kb} KB)`);
  console.log(`  總 size_charts (by id): ${Object.keys(overlay.size_charts).length}`);
  console.log(`  總 image_overlay (by id): ${Object.keys(overlay.image_overlay).length}`);
  console.log(`  品牌數 (by_name buckets): ${Object.keys(overlay.by_name).length}`);
}

main();
