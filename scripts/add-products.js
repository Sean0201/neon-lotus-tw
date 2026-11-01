#!/usr/bin/env node
/**
 * add-products.js
 * ─────────────────────────────────────────────────────────────────
 * 把「指定的幾件商品」新增到 Supabase(不像 scrape-to-supabase.js 會整個品牌刪掉重寫)。
 *
 * 使用:
 *   node scripts/add-products.js <manifest.json>            # dry-run (預設,不寫入)
 *   node scripts/add-products.js <manifest.json> --apply    # 真的寫進 Supabase
 *
 * manifest 格式:
 *   {
 *     "brands":   [ { id, name, style, color_hex, location, website, logo_url, cover_url,
 *                     description_zh, description_en, sort_order } ],
 *     "products": [ { "product": { id, brand_id, name, tag, category, price_vnd, cover_image, ... },
 *                     "sizes":   [ { label, available } ],
 *                     "gallery": [ { url, type, sort_order } ] } ]
 *   }
 *
 * 安全設計:
 *   • 預設 dry-run,只印出「會做什麼」
 *   • 只新增:品牌 / 商品 id 已存在就跳過,絕不覆蓋、絕不刪除
 *   • 商品的 brand_id 必須已存在(或同一份 manifest 裡會新增)
 *
 * env 需求 (從 .env 讀取):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 * ─────────────────────────────────────────────────────────────────
 */

import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ 缺少環境變數 NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY');
  console.error('   請確認 .env 有這兩個值,並用:  export $(cat .env | xargs) && node scripts/add-products.js ...');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const apply = args.includes('--apply');
if (!file) {
  console.error('用法: node scripts/add-products.js <manifest.json> [--apply]');
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(file, 'utf-8'));
const brands = manifest.brands || [];
const items = manifest.products || [];

console.log('═══════════════════════════════════════════════════════════════');
console.log(`  Add products → Supabase   |   ${file}`);
console.log(`  Mode: ${apply ? '🔥 APPLY (會寫入 DB)' : '🔍 DRY-RUN (不寫入)'}`);
console.log('═══════════════════════════════════════════════════════════════\n');

// ── 檢查既有資料 ────────────────────────────────────────────────
const brandIds = [...new Set([...brands.map(b => b.id), ...items.map(i => i.product.brand_id)])];
const { data: exBrands, error: e1 } = await supabase.from('brands').select('id').in('id', brandIds);
if (e1) { console.error('❌ 查詢品牌失敗:', e1.message); process.exit(1); }
const haveBrand = new Set((exBrands || []).map(b => b.id));

const productIds = items.map(i => i.product.id);
const { data: exProducts, error: e2 } = await supabase.from('products').select('id').in('id', productIds);
if (e2) { console.error('❌ 查詢商品失敗:', e2.message); process.exit(1); }
const haveProduct = new Set((exProducts || []).map(p => p.id));

const newBrands = brands.filter(b => !haveBrand.has(b.id));
const newItems = items.filter(i => !haveProduct.has(i.product.id));
const willHaveBrand = new Set([...haveBrand, ...newBrands.map(b => b.id)]);
const orphan = newItems.filter(i => !willHaveBrand.has(i.product.brand_id));
if (orphan.length) {
  console.error('❌ 這些商品的品牌不存在,也不在 manifest 的 brands 裡:');
  orphan.forEach(i => console.error('   ', i.product.id, '→', i.product.brand_id));
  process.exit(1);
}

// ── 預覽 ────────────────────────────────────────────────────────
console.log('品牌:');
for (const b of brands) console.log(`  ${haveBrand.has(b.id) ? '⏭  已存在,跳過' : '➕ 新增'}  ${b.id}  ${b.name}`);
if (!brands.length) console.log('  (無)');
console.log('\n商品:');
for (const it of items) {
  const p = it.product;
  const tag = haveProduct.has(p.id) ? '⏭  已存在,跳過' : '➕ 新增';
  const sizes = it.sizes.map(s => s.available === false ? `${s.label}✗` : s.label).join('/');
  console.log(`  ${tag}  ${p.id}`);
  console.log(`       ${p.name}  |  ${p.tag}  |  ${Number(p.price_vnd || 0).toLocaleString()} VND  |  尺寸 ${sizes || '-'}  |  ${it.gallery.length} 張圖`);
}
console.log(`\n合計:新增品牌 ${newBrands.length}、新增商品 ${newItems.length}(跳過 ${items.length - newItems.length})`);

if (!apply) {
  console.log('\n🔍 DRY-RUN 結束,沒有寫入。確認無誤後加 --apply。');
  process.exit(0);
}

// ── 寫入 ────────────────────────────────────────────────────────
const now = new Date().toISOString();
if (newBrands.length) {
  const rows = newBrands.map(b => ({ is_active: true, created_at: now, updated_at: now, ...b }));
  const { error } = await supabase.from('brands').insert(rows);
  if (error) { console.error('❌ 新增品牌失敗:', error.message); process.exit(1); }
  console.log(`✅ 新增品牌 ${rows.length}`);
}
if (newItems.length) {
  const rows = newItems.map(i => ({ created_at: now, updated_at: now, ...i.product }));
  const { error } = await supabase.from('products').insert(rows);
  if (error) { console.error('❌ 新增商品失敗:', error.message); process.exit(1); }
  console.log(`✅ 新增商品 ${rows.length}`);

  const sizeRows = newItems.flatMap(i => i.sizes.map((s, k) => ({
    product_id: i.product.id, label: s.label, available: s.available !== false, sort_order: k,
  })));
  if (sizeRows.length) {
    const { error: es } = await supabase.from('product_sizes').insert(sizeRows);
    if (es) console.error('⚠️  尺寸寫入失敗:', es.message);
    else console.log(`✅ 尺寸 ${sizeRows.length} 筆`);
  }
  const galRows = newItems.flatMap(i => i.gallery.map((g, k) => ({
    product_id: i.product.id, url: g.url, type: g.type || (k === 0 ? 'source' : 'detail'), sort_order: g.sort_order ?? k,
  })));
  if (galRows.length) {
    const { error: eg } = await supabase.from('product_gallery').insert(galRows);
    if (eg) console.error('⚠️  圖片寫入失敗:', eg.message);
    else console.log(`✅ 圖片 ${galRows.length} 筆`);
  }
}
console.log('\n完成。記得到後台按「🚀 重建快照 + 發佈」,前台的尺寸和細節照才會更新。');
