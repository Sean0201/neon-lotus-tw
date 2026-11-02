#!/usr/bin/env node
/**
 * upload-rack-images.js
 * ─────────────────────────────────────────────────────────────────
 * 把 output/rack/<product_id>.webp 去背圖上傳到 Supabase Storage,
 * 並寫進 products.rack_image(首頁衣架用,需要 migration 020)。
 *
 * 使用:
 *   node scripts/upload-rack-images.js                 # dry-run:列出會上傳哪些
 *   node scripts/upload-rack-images.js --apply         # 上傳 + 寫入資料庫
 *   node scripts/upload-rack-images.js --apply id1 id2 # 只處理指定商品
 *
 * 規則:
 *   • 檔名 = 商品 id(scripts/rack-cutout.py 的輸出就是這個格式)
 *   • 找不到對應商品的檔案會跳過
 *   • 已經有 rack_image 的商品會覆蓋成新圖(重做去背時直接重跑即可)
 *
 * env 需求 (從 .env 讀取):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 * ─────────────────────────────────────────────────────────────────
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'output', 'rack');
const BUCKET = 'product-images';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ 缺少環境變數,請用:  export $(cat .env | xargs) && node scripts/upload-rack-images.js');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const only = new Set(args.filter(a => !a.startsWith('--')));

const files = fs.readdirSync(DIR).filter(f => f.endsWith('.webp'))
  .filter(f => !only.size || only.has(f.slice(0, -5))).sort();
if (!files.length) { console.log('output/rack/ 裡沒有要處理的 .webp'); process.exit(0); }

// migration 020 檢查
const probe = await sb.from('products').select('id, rack_image').limit(1);
if (probe.error) {
  console.error('❌ 讀不到 products.rack_image:', probe.error.message);
  console.error('   請先在 Supabase SQL Editor 執行 db/migrations/020_rack_image.sql');
  process.exit(1);
}

const ids = files.map(f => f.slice(0, -5));
const { data: rows, error } = await sb.from('products').select('id, name, rack_image').in('id', ids);
if (error) { console.error('❌ 查詢商品失敗:', error.message); process.exit(1); }
const byId = new Map(rows.map(r => [r.id, r]));

console.log(`${apply ? '🔥 APPLY' : '🔍 DRY-RUN'}  共 ${files.length} 張\n`);
let done = 0, skipped = 0;
for (const f of files) {
  const id = f.slice(0, -5);
  const row = byId.get(id);
  if (!row) { console.log(`⏭  ${id}  找不到商品,跳過`); skipped++; continue; }
  const buf = fs.readFileSync(path.join(DIR, f));
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8);
  const key = `rack/${id}-${hash}.webp`;   // 內容變了檔名就變,避免 CDN 快取舊圖
  const note = row.rack_image ? '(覆蓋舊圖)' : '';
  if (!apply) { console.log(`➕ ${id}  ${Math.round(buf.length / 1024)}KB ${note}`); done++; continue; }

  const up = await sb.storage.from(BUCKET).upload(key, buf, { contentType: 'image/webp', upsert: true });
  if (up.error) { console.error(`✗ ${id}  上傳失敗:`, up.error.message); continue; }
  const url = sb.storage.from(BUCKET).getPublicUrl(key).data.publicUrl;
  const r = await sb.from('products').update({ rack_image: url }).eq('id', id);
  if (r.error) { console.error(`✗ ${id}  寫入失敗:`, r.error.message); continue; }
  console.log(`✓ ${id} ${note}`);
  done++;
}
console.log(`\n${apply ? '完成' : '預覽'}:${done} 張${skipped ? `,跳過 ${skipped}` : ''}`);
if (!apply) console.log('確認無誤後加 --apply。');
