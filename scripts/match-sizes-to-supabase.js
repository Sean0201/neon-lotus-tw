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

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..');
const DATA_FILE    = path.join(ROOT, 'data.js');
const OVERLAY_FILE = path.join(ROOT, 'data-overlay.js');

function parseArgs(argv) {
  const o = { from: '23sptmbr', to: '23september' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from-overlay-brand') o.from = argv[++i];
    else if (a === '--to-supabase-brand') o.to = argv[++i];
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

/** 名稱標準化 → base 字串 (排除顏色 / 變體) */
function baseName(name) {
  if (!name) return '';
  // 拿掉 23' 或 23 開頭的型號前綴
  let s = String(name).toLowerCase();
  // 統一各種 apostrophe / quote
  s = s.replace(/[\u2018\u2019\u02bc'`"]/g, '');
  // 拿掉開頭的 "23"
  s = s.replace(/^\s*23\s*/, '');
  // 切第一個 "/" 取左邊 (去除顏色 / 變體後綴)
  if (s.includes('/')) s = s.split('/')[0];
  // 拿掉所有非字母數字
  s = s.replace(/[^a-z0-9]+/g, '');
  return s;
}

function main() {
  const args = parseArgs(process.argv);
  console.log(`匹配: overlay[${args.from}] → supabase[${args.to}]`);

  const data    = readJsAssign(DATA_FILE, 'BRANDS_DATA');
  const overlay = readJsAssign(OVERLAY_FILE, 'DATA_OVERLAY');

  const supaProducts = data.products.filter(p => p.brand_id === args.to);
  const ovProducts   = (overlay.products || []).filter(p => p.brand_id === args.from);
  const ovChartsById = overlay.size_charts || {};
  console.log(`  Supabase 端: ${supaProducts.length} 件`);
  console.log(`  Overlay 端 : ${ovProducts.length} 件 (${Object.keys(ovChartsById).length} 張尺寸表)`);

  // 1) 建立 base → size_chart map (從 overlay 取)
  const chartByBase = {};
  for (const p of ovProducts) {
    const ch = p.size_chart || ovChartsById[p.id];
    if (!ch) continue;
    const b = baseName(p.name);
    if (!b) continue;
    // 同 base 多個只留第一個 (它們應該都一樣)
    if (!chartByBase[b]) chartByBase[b] = ch;
  }
  console.log(`  Overlay 唯一 base 數 (含尺寸): ${Object.keys(chartByBase).length}`);

  // 2) 依 base 把 size_chart 映射回 Supabase product id
  const newSizeCharts = {};
  let matched = 0, unmatched = 0;
  const unmatchedExamples = [];
  for (const p of supaProducts) {
    const b = baseName(p.name);
    const ch = chartByBase[b];
    if (ch) {
      newSizeCharts[p.id] = ch;
      matched++;
    } else {
      unmatched++;
      if (unmatchedExamples.length < 8) unmatchedExamples.push(p.id + ' | ' + p.name);
    }
  }
  console.log(`  Supabase 商品命中: ${matched} / ${supaProducts.length} (未命中 ${unmatched})`);
  if (unmatchedExamples.length) {
    console.log('  未命中示例:');
    unmatchedExamples.forEach(s => console.log('    -', s));
  }

  // 3) 寫回 overlay: 清空 brands/products, 只留 size_charts
  const newOverlay = {
    brands: [],          // 不再加新品牌
    products: [],        // 不再加新商品
    size_charts: newSizeCharts
  };
  fs.writeFileSync(OVERLAY_FILE,
    '/* eslint-disable */\nwindow.DATA_OVERLAY = ' + JSON.stringify(newOverlay) + ';',
    'utf-8'
  );
  const kb = (Buffer.byteLength(JSON.stringify(newOverlay))/1024).toFixed(0);
  console.log(`  ✔ 寫回 data-overlay.js (${kb} KB, ${matched} 個 size_chart)`);
}

main();
