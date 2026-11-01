#!/usr/bin/env node
/**
 * 統一圖片處理入口 — 舊商品、新商品都用這支
 *
 *   npm run images                      # 處理 output/ 底下所有「還沒有圖片」的商品
 *   npm run images -- <資料夾名稱>       # 只處理一個，例：npm run images -- outerity-flannel-sweet-baby
 *   npm run images -- --force           # 全部重跑（覆蓋已下載的圖片）
 *
 * 每個商品資料夾裡的 process-images.mjs 負責下載＋浮水印，成品放在該資料夾的 images/。
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'output');
const args = process.argv.slice(2);
const force = args.includes('--force');
const only = args.filter(a => !a.startsWith('--'));

const hasImages = dir => {
  const img = path.join(dir, 'images');
  return fs.existsSync(img) && fs.readdirSync(img).some(f => /\.(jpe?g|png|webp)$/i.test(f));
};

const folders = (only.length ? only : fs.readdirSync(OUT))
  .filter(n => fs.existsSync(path.join(OUT, n)) && fs.statSync(path.join(OUT, n)).isDirectory());
if (only.length && !folders.length) { console.error(`❌ output/ 裡找不到：${only.join(', ')}`); process.exit(1); }

const result = { done: [], skipped: [], noScript: [], failed: [] };
for (const name of folders) {
  const dir = path.join(OUT, name);
  const script = path.join(dir, 'process-images.mjs');
  if (!fs.existsSync(script)) { result.noScript.push(name); continue; }
  if (!force && !only.length && hasImages(dir)) { result.skipped.push(name); continue; }
  console.log(`\n▶ ${name}`);
  const r = spawnSync(process.execPath, [script], { cwd: dir, stdio: 'inherit' });
  (r.status === 0 && hasImages(dir) ? result.done : result.failed).push(name);
}

console.log('\n════════ 結果 ════════');
if (result.done.length)     console.log(`✅ 完成：${result.done.join(', ')}`);
if (result.skipped.length)  console.log(`⏭  已有圖片，略過（要重跑加 --force）：${result.skipped.join(', ')}`);
if (result.noScript.length) console.log(`—  沒有圖片腳本（圖片已在 images/）：${result.noScript.join(', ')}`);
if (result.failed.length)   console.log(`❌ 失敗：${result.failed.join(', ')}`);
console.log('圖片位置：output/<商品資料夾>/images/');
