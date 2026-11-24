#!/usr/bin/env node
/**
 * tryon-compare.mjs — 試衣間模型比較(Gemini vs ChatGPT)
 * ─────────────────────────────────────────────────────────────────
 * 同一張自拍 × 同樣的商品,分別用多個生圖模型產生試穿圖,輸出比較頁。
 *
 * 用法:
 *   node scripts/tryon-compare.mjs <自拍.jpg> <商品id> [<商品id> …]
 *   (每個商品各跑一輪;需要 .env 的 GEMINI_API_KEY、OPENAI_API_KEY、Supabase)
 *
 * 輸出:output/tryon-compare/<時間>/index.html + 各模型圖片
 * 參考圖:衣架去背圖(products.rack_image,若有)+ 商品封面圖
 * ─────────────────────────────────────────────────────────────────
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [selfiePath, ...productIds] = process.argv.slice(2);
if (!selfiePath || !productIds.length) {
  console.error('用法: node scripts/tryon-compare.mjs <自拍.jpg> <商品id> [<商品id> …]');
  process.exit(1);
}
const { GEMINI_API_KEY, OPENAI_API_KEY } = process.env;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

const MODELS = [
  GEMINI_API_KEY && { id: 'gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image(目前使用)', run: gemini('gemini-2.5-flash-image') },
  GEMINI_API_KEY && { id: 'gemini-3.1-flash-image', label: 'Gemini 3.1 Flash Image', run: gemini('gemini-3.1-flash-image') },
  GEMINI_API_KEY && { id: 'gemini-3-pro-image', label: 'Gemini 3 Pro Image', run: gemini('gemini-3-pro-image') },
  OPENAI_API_KEY && { id: 'gpt-image-2', label: 'ChatGPT gpt-image-2', run: openai('gpt-image-2') },
  OPENAI_API_KEY && { id: 'gpt-image-1.5', label: 'ChatGPT gpt-image-1.5', run: openai('gpt-image-1.5') },
].filter(Boolean)
  // ONLY=gpt-image-2,gemini-3-pro-image 只跑指定模型
  .filter((m) => !process.env.ONLY || process.env.ONLY.split(',').includes(m.id));

const CATEGORY = (p) => {
  const c = String(p.category || p.tag || '').toUpperCase();
  if (c === 'SETS' || /set|套/i.test(p.name)) return 'set';
  if (/BOTTOM|PANTS|SHORTS|SKIRT|JEANS/.test(c)) return 'bottom';
  if (/JACKET|OUTER|COAT/.test(c)) return 'outerwear';
  return 'top';
};

function buildPrompt(product, category, refCount) {
  const region = {
    top: 'the upper-body garment (shoulders to waist)',
    bottom: 'the lower-body garment (waist to ankles)',
    outerwear: 'the outer layer worn over the current top',
    set: 'BOTH the upper-body and lower-body garments (this is a matching set)',
  }[category];
  return [
    'Virtual try-on. Image 1 is the customer photo. '
      + (refCount > 1 ? `Images 2-${refCount + 1} are reference photos of ONE product` : 'Image 2 is the product')
      + ` ("${product.name}").`,
    `Dress the customer in this product, replacing ${region}.`,
    '',
    'PRODUCT FIDELITY (most important):',
    '- Reproduce the garment exactly: same colors, prints, graphics, logos, text, stitching, buttons, zippers, pockets',
    '- Keep graphic placement, scale and spelling identical to the reference',
    '- Keep the cut, length, fit and fabric texture of the reference',
    '- Ignore any model, pose, background or other clothing in the product photos',
    '',
    'CUSTOMER (do not change):',
    '- Same face, identity, expression, hair, skin tone, body shape and pose',
    '- Same background, lighting and camera framing; keep all other clothing and accessories',
    '',
    'Make the garment drape naturally on this body with realistic folds and shadows matching the scene lighting.',
    'Output one photorealistic image with the same aspect ratio as image 1. No text or watermark.',
  ].join('\n');
}

async function loadImage(src) {
  if (/^https?:/.test(src)) {
    const r = await fetch(src);
    if (!r.ok) throw new Error(`下載失敗 ${r.status}: ${src}`);
    return { buf: Buffer.from(await r.arrayBuffer()), mime: r.headers.get('content-type') || 'image/jpeg' };
  }
  const ext = path.extname(src).toLowerCase();
  return { buf: fs.readFileSync(src), mime: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg' };
}

function gemini(model) {
  return async (prompt, images) => {
    const parts = [{ text: prompt }, ...images.map((i) => ({ inlineData: { mimeType: i.mime, data: i.buf.toString('base64') } }))];
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
    const img = (j.candidates || []).flatMap((c) => c.content?.parts || []).find((p) => p.inlineData);
    if (!img) throw new Error('沒有產生圖片: ' + JSON.stringify(j).slice(0, 200));
    return { buf: Buffer.from(img.inlineData.data, 'base64'), ext: 'png' };
  };
}

function openai(model) {
  return async (prompt, images) => {
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt);
    form.append('size', 'auto');
    form.append('quality', process.env.OPENAI_QUALITY || 'high');
    images.forEach((i, n) => {
      const ext = i.mime.includes('png') ? 'png' : i.mime.includes('webp') ? 'webp' : 'jpg';
      form.append('image[]', new Blob([i.buf], { type: i.mime }), `ref${n}.${ext}`);
    });
    const r = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST', headers: { authorization: `Bearer ${OPENAI_API_KEY}` }, body: form,
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
    return { buf: Buffer.from(j.data[0].b64_json, 'base64'), ext: 'png' };
  };
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.join(ROOT, 'output', 'tryon-compare', stamp);
fs.mkdirSync(OUT, { recursive: true });
const selfie = await loadImage(selfiePath);
fs.writeFileSync(path.join(OUT, 'selfie.jpg'), selfie.buf);

const rows = [];
for (const pid of productIds) {
  const { data: p, error } = await sb.from('products')
    .select('id, name, category, tag, cover_image, rack_image').eq('id', pid).maybeSingle();
  if (error || !p) { console.error(`✗ 找不到商品 ${pid}`); continue; }
  const refs = [p.rack_image, p.cover_image].filter(Boolean);
  const refImgs = [];
  for (const u of refs) refImgs.push(await loadImage(u));
  refImgs.forEach((r, n) => fs.writeFileSync(path.join(OUT, `${pid}-ref${n}.${r.mime.includes('png') ? 'png' : r.mime.includes('webp') ? 'webp' : 'jpg'}`), r.buf));
  const category = CATEGORY(p);
  const prompt = buildPrompt(p, category, refImgs.length);
  console.log(`\n▶ ${p.name}(${category},參考圖 ${refImgs.length} 張)`);

  const results = await Promise.all(MODELS.map(async (m) => {
    const t0 = Date.now();
    try {
      const out = await m.run(prompt, [selfie, ...refImgs]);
      const file = `${pid}-${m.id}.${out.ext}`;
      fs.writeFileSync(path.join(OUT, file), out.buf);
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  ✓ ${m.id}  ${sec}s`);
      return { model: m, file, sec };
    } catch (e) {
      console.log(`  ✗ ${m.id}  ${e.message.slice(0, 160)}`);
      return { model: m, error: e.message };
    }
  }));
  rows.push({ p, category, refs: refImgs.length, results });
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const html = `<!doctype html><meta charset="utf-8"><title>試衣間模型比較</title>
<style>body{font:14px system-ui;background:#111;color:#eee;margin:20px}h2{margin:28px 0 8px}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
figure{margin:0;background:#1c1c1c;padding:8px;border-radius:8px}img{width:100%;border-radius:4px}
figcaption{margin-top:6px;color:#bbb}.err{color:#f88}</style>
<h1>試衣間模型比較</h1>
${rows.map((r) => `<h2>${esc(r.p.name)} <small>(${r.category},參考圖 ${r.refs} 張)</small></h2><div class="g">
<figure><img src="selfie.jpg"><figcaption>原始照片</figcaption></figure>
${Array.from({ length: r.refs }, (_, n) => {
  const f = fs.readdirSync(OUT).find((x) => x.startsWith(`${r.p.id}-ref${n}.`));
  return `<figure><img src="${f}"><figcaption>商品參考 ${n + 1}</figcaption></figure>`;
}).join('')}
${r.results.map((x) => x.error
  ? `<figure><figcaption>${esc(x.model.label)}<br><span class="err">${esc(x.error.slice(0, 200))}</span></figcaption></figure>`
  : `<figure><img src="${x.file}"><figcaption>${esc(x.model.label)} · ${x.sec}s</figcaption></figure>`).join('')}
</div>`).join('')}`;
fs.writeFileSync(path.join(OUT, 'index.html'), html);
console.log(`\n完成:${path.relative(ROOT, path.join(OUT, 'index.html'))}`);
