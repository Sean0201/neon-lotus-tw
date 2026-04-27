#!/usr/bin/env node
/**
 * match-sizes-to-supabase.js
 * --------------------------------------------------------------------
 * 把 scrape 來的 (e.g. 23sptmbr) 商品的 size_chart 透過「商品名稱」
 * 匹配到 Supabase 既有商品 (e.g. 23september) 上，輸出純 size_charts
 * 的 overlay (不動既有商品的 name / images / price)。
 *
 * 用法 (預設 23sptmbr → 23september):
 *   node scripts/match-sizes-to-supabase.js
 *
 * 自訂:
 *   node scripts/match-sizes-to-supabase.js \
 *        --from-overlay-brand 23sptmbr \
 *        --to-supabase-brand 23september
 *
 * 對應規則:
 *   - 名稱小寫、去除 [' " ʼ ’ ()] 與多餘空白
 *   - 拆 "/" 取 base name (不含顏色變體)
 *   - 同 base 的多個 scrape 商品中, 任一有 size_chart 即套用至對方
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
const SCRAPE_DIR   = path.join(__dirname, 'data');   // 原始 scrape 結果存放處

function parseArgs(argv) {
  const o = {
    from: '23sptmbr', to: '23september',
    source: path.join(SCRAPE_DIR, 'sptmbr_scrape.json')
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from-overlay-brand') o.from = argv[++i];
    else if (a === '--to-supabase-brand') o.to = argv[++i];
    else if (a === '--source')           o.source = argv[++i];
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
  s = s.replace(/[\u2018\u2019\u02bc'`"]/g, '');     // 各種 apostrophe
  s = s.replace(/^\s*23\s*/, '');                     // 23' 前綴
  if (s.includes('/')) s = s.split('/')[0];           // 切顏色 / 變體
  s = s.replace(/\([^)]*\)/g, ' ');                   // 拿掉括號內容 e.g. (Raw Denim)

  const tokens = s.split(/[^a-z0-9]+/i).filter(Boolean);
  const ROMAN_OR_NUM = /^(i{1,3}|iv|v|vi{0,3}|ix|x|0?\d{1,2})$/;

  // 寬鬆變形: 拿掉結尾的「羅馬數字 / 數字編號」
  const trimmed = tokens.slice();
  while (trimmed.length > 1 && ROMAN_OR_NUM.test(trimmed[trimmed.length - 1])) trimmed.pop();

  // 單複數 / 過去分詞 簡單 stem (去結尾 d / ed / s)
  const stem = (t) => t.replace(/(ed|es|s|d)$/, '');
  const stemmed = trimmed.map(stem);

  // 產生候選 base (從嚴格到寬鬆), 排重後回傳
  const out = new Set();
  out.add(tokens.join(''));        // strict: 全部 tokens
  out.add(trimmed.join(''));        // no trailing version number
  out.add(stemmed.join(''));        // stemmed
  return Array.from(out).filter(Boolean);
}

function baseName(name) {           // 為了向後相容仍輸出主 base
  return baseKeys(name)[0] || '';
}

/** 防禦性: 重新翻譯一張 size_chart, 確保所有 headers/keys 都是中文 */
function ensureTranslatedChart(sc) {
  if (!sc || !Array.isArray(sc.headers)) return sc;
  const newHeaders = sc.headers.map(h => translate(h) || h);
  const headerMap = {};
  sc.headers.forEach((h, i) => headerMap[h] = newHeaders[i]);
  const out = { ...sc, headers: newHeaders, rows: (sc.rows || []).map(r => {
    const newValues = {};
    for (const [k, v] of Object.entries(r.values || {})) {
      const nk = headerMap[k] || translate(k) || k;
      newValues[nk] = v;
    }
    return { ...r, values: newValues };
  }) };
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  console.log(`匹配: overlay[${args.from}] → supabase[${args.to}]`);

  const data    = readJsAssign(DATA_FILE, 'BRANDS_DATA');
  // 來源優先序: --source JSON (原始 scrape 結果) → 既有 overlay.products
  let ovProducts = [];
  let ovChartsById = {};
  if (fs.existsSync(args.source)) {
    const raw = JSON.parse(fs.readFileSync(args.source, 'utf-8'));
    ovProducts = raw.products || [];
    console.log(`  來源: ${path.relative(ROOT, args.source)}`);
  } else {
    const overlay = readJsAssign(OVERLAY_FILE, 'DATA_OVERLAY');
    ovProducts = (overlay.products || []).filter(p => p.brand_id === args.from);
    ovChartsById = overlay.size_charts || {};
    console.log('  來源: data-overlay.js (no raw scrape file found)');
  }

  const supaProducts = data.products.filter(p => p.brand_id === args.to);
  console.log(`  Supabase 端: ${supaProducts.length} 件`);
  console.log(`  Source 端  : ${ovProducts.length} 件 (${ovProducts.filter(p => p.size_chart).length} 張尺寸表)`);

  // 1) 建立 base → size_chart map (從 overlay 取, 每個商品產生多個 base 變體)
  //    每張 chart 都先強制再翻譯一次, 防止 raw 資料殘留越南文 header
  const chartByBase = {};
  const galleryByBase = {};   // base → 全套 gallery (用來 overlay 圖片)
  for (const p of ovProducts) {
    const ch = p.size_chart || ovChartsById[p.id];
    if (ch) {
      const fixed = ensureTranslatedChart(ch);
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
  console.log(`  Overlay 唯一 base 數 (含尺寸): ${Object.keys(chartByBase).length}`);
  console.log(`  Overlay 唯一 base 數 (含 gallery): ${Object.keys(galleryByBase).length}`);

  // 2) 依 base 把 size_chart 映射回 Supabase product id
  //    並且如果 scrape 端有更多圖, 一起加進 image_overlay
  const newSizeCharts = {};
  const newImageOverlay = {};   // { product_id: [extra gallery items] }
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
      newSizeCharts[p.id] = ch;
      matched++;
    } else {
      unmatched++;
      if (unmatchedExamples.length < 12) unmatchedExamples.push(p.id + ' | ' + p.name);
    }
    // 補圖 (僅當 scrape 端比 supabase 端多)
    const supN = ((p.images || {}).gallery || []).length;
    if (gal && gal.length > supN) {
      newImageOverlay[p.id] = gal;
      imgPatched++;
    }
  }
  console.log(`  Supabase 商品命中: ${matched} / ${supaProducts.length} (未命中 ${unmatched})`);
  console.log(`  圖片補強     : ${imgPatched} 件 (scrape 比 supabase 多圖)`);
  if (unmatchedExamples.length) {
    console.log('  未命中示例:');
    unmatchedExamples.forEach(s => console.log('    -', s));
  }

  // 3) 寫回 overlay: 清空 brands/products, 只留 size_charts + image_overlay
  const newOverlay = {
    brands: [],          // 不再加新品牌
    products: [],        // 不再加新商品
    size_charts: newSizeCharts,
    image_overlay: newImageOverlay
  };
  fs.writeFileSync(OVERLAY_FILE,
    '/* eslint-disable */\nwindow.DATA_OVERLAY = ' + JSON.stringify(newOverlay) + ';',
    'utf-8'
  );
  const kb = (Buffer.byteLength(JSON.stringify(newOverlay))/1024).toFixed(0);
  console.log(`  ✔ 寫回 data-overlay.js (${kb} KB, ${matched} 個 size_chart)`);
}

main();
