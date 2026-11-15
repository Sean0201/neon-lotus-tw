#!/usr/bin/env node
/**
 * build-pages.mjs — Cloudflare(Workers)建置
 * ─────────────────────────────────────────────────────────────────
 * 1. 重建快照(scripts/dump-snapshot.js → data/)
 * 2. 只把「網站需要公開的檔案」複製到 dist/(白名單)
 *    → 文件、腳本、後端程式、試算表、.env 等都不會被發佈
 * 3. 寫出 dist/_headers(快取與安全標頭,對應原本 vercel.json 的 headers)
 * 4. 檢查 index.html / admin.html 引用的本機檔案都在 dist/ 裡
 *
 * Cloudflare Workers Builds 設定:
 *   Build command:   npm run build:cf
 *   Deploy command:  npx wrangler deploy(預設)
 *   建置變數:NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY(快照用)
 *
 * 本機:node scripts/build-pages.mjs --skip-snapshot   (沿用現有 data/,不連資料庫)
 * ─────────────────────────────────────────────────────────────────
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const skipSnapshot = process.argv.includes('--skip-snapshot');

// ── 白名單 ───────────────────────────────────────────────────────
// 根目錄:頁面、前端 JS / CSS、logo、SEO 檔
const ROOT_FILE = /^(?:[a-z0-9-]+\.(?:html|js|css)|logo\.PNG|robots\.txt|sitemap\.xml|llms\.txt)$/;
// 整個資料夾(底下的 .md 說明檔除外)
const DIRS = ['data', 'assets'];
// 個別檔案
const FILES = ['scripts/mask-generator.js', 'scripts/outfit-builder.js'];

// ── 1. 快照 ──────────────────────────────────────────────────────
if (!skipSnapshot) {
  console.log('▶ 重建快照');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'dump-snapshot.js')], { stdio: 'inherit', cwd: ROOT });
}

// ── 2. 複製 ──────────────────────────────────────────────────────
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
let count = 0, bytes = 0;
const copy = (rel) => {
  const src = path.join(ROOT, rel), dst = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  count++; bytes += fs.statSync(src).size;
};
const walk = (rel) => {
  for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.name.startsWith('.') || /\.md$/i.test(e.name)) continue;
    if (e.isDirectory()) walk(r); else copy(r);
  }
};
for (const f of fs.readdirSync(ROOT)) if (ROOT_FILE.test(f) && fs.statSync(path.join(ROOT, f)).isFile()) copy(f);
for (const d of DIRS) if (fs.existsSync(path.join(ROOT, d))) walk(d);
for (const f of FILES) copy(f);

// ── 3. _headers(Cloudflare 靜態檔案標頭)──────────────────────────
fs.writeFileSync(path.join(DIST, '_headers'), `/supabase-client.js
  Cache-Control: public, max-age=0, must-revalidate

/data/*
  Cache-Control: public, max-age=60, stale-while-revalidate=86400
  Content-Type: application/json; charset=utf-8

/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
`);

// ── 4. 檢查引用 ──────────────────────────────────────────────────
const missing = [];
for (const page of ['index.html', 'admin.html']) {
  const html = fs.readFileSync(path.join(DIST, page), 'utf-8');
  for (const m of html.matchAll(/(?:src|href)="([^"#?]+)(?:[?#][^"]*)?"/g)) {
    const ref = m[1];
    if (/^(?:[a-z]+:|\/\/|\$\{)/i.test(ref) || ref.startsWith('/policy/') || ref === '/') continue;
    if (!fs.existsSync(path.join(DIST, ref.replace(/^\//, '')))) missing.push(`${page} → ${ref}`);
  }
}
console.log(`✔ dist/:${count} 個檔案,${(bytes / 1048576).toFixed(1)} MB`);
if (missing.length) {
  console.error('✖ 頁面引用了 dist/ 裡沒有的檔案:\n  ' + missing.join('\n  '));
  process.exit(1);
}
