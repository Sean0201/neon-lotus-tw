/**
 * /api/tryon.js — AI 試衣間
 * ─────────────────────────────────────────────────────────────────
 * 一次生成整套穿搭(不再逐層重畫,臉與構圖不會越畫越走樣)。
 *
 * Pipeline:
 *   1. 內容審查(Gemini Flash 視覺)— 擋裸露 / 未成年 / 暴力等
 *   2. 依 product_id 從資料庫取商品資料與參考圖(衣架去背圖 + 封面圖),
 *      不接受前端傳任意網址(避免被當成下載代理)
 *   3. 主力 OpenAI gpt-image-2(中等畫質);失敗(含安全審查拒絕)→ 備援 Gemini 3.1 Flash Image
 *      2026-11 實測(scripts/tryon-compare.mjs):gpt-image-2 最忠於 logo / 圖案且保留臉與構圖
 *
 * Request: { selfieBase64, selfieType, items: [{ product_id, slot }] }
 *   slot = top | bottom | outerwear | bag | hat(前端試衣格位)
 * Response: { success, image, mimeType, model }
 *
 * 環境變數:OPENAI_API_KEY、GEMINI_API_KEY(至少一個)、Supabase service role
 *   TRYON_OPENAI_MODEL(預設 gpt-image-2)、TRYON_OPENAI_QUALITY(預設 medium)
 *   TRYON_GEMINI_MODEL(預設 gemini-3.1-flash-image)
 * ─────────────────────────────────────────────────────────────────
 */
import { Buffer } from 'node:buffer';

export const config = { runtime: 'edge', maxDuration: 300 };

const MAX_ITEMS = 5;
const MAX_REFS_PER_ITEM = 2;

/* ── 商品類別 → 要換的部位 ───────────────────────────────── */
function regionOf(product, slot) {
  const cat = String(product.category || product.tag || '').toUpperCase();
  if (cat === 'SETS' || /\bset\b|套組|套裝/i.test(product.name || '')) return 'set';
  if (cat === 'DRESSES') return 'dress';
  return slot;
}

const REGION_TEXT = {
  top:       'upper-body garment — replace the current top (shoulders to waist)',
  outerwear: 'outer layer — worn OVER the current top, open or closed as styled in the reference',
  bottom:    'lower-body garment — replace the current pants/shorts/skirt (waist down)',
  set:       'matching set — replace BOTH the current top AND the current bottoms with the two pieces of this set',
  dress:     'dress — replace both the current top and bottoms',
  bag:       'bag — ADD it, carried naturally (shoulder, crossbody or hand, whichever suits the style)',
  hat:       'hat/cap — ADD it on the head, matching head angle and size',
};

function buildPrompt(items) {
  let n = 2;
  const lines = items.map((it, i) => {
    const from = n, to = n + it.refs.length - 1;
    n = to + 1;
    const imgs = from === to ? `image ${from}` : `images ${from}-${to}`;
    return `${i + 1}. "${it.product.name}" (${imgs}): ${REGION_TEXT[it.region] || REGION_TEXT.top}`;
  });
  return [
    'Virtual fitting room. Image 1 is the customer photo.',
    'Dress the customer in the following product(s). Each product may have several reference photos:',
    ...lines,
    '',
    'PRODUCT FIDELITY (most important):',
    '- Reproduce each item exactly: same colors, prints, graphics, logos, text, stitching, buttons, zippers, pockets',
    '- Keep graphic placement, scale and spelling identical to the reference',
    '- Keep the cut, length, fit and fabric texture of the reference',
    '- Ignore any model, pose, background or other clothing shown in the product photos',
    '',
    'CUSTOMER (do not change):',
    '- Same face, identity, expression, hair, skin tone, body shape and pose',
    '- Same background, lighting and camera framing; do not crop or zoom',
    '- Keep every piece of clothing and accessory that is not being replaced',
    '',
    'Make the garments drape naturally on this body with realistic folds and shadows matching the scene lighting.',
    'Output one photorealistic image with the same aspect ratio as image 1. No text or watermark.',
  ].join('\n');
}

/* ── 從資料庫取商品與參考圖 ───────────────────────────────── */
async function loadProducts(items) {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase not configured');
  const ids = items.map((it) => String(it.product_id));
  const qs = new URLSearchParams({
    select: 'id,name,category,tag,cover_image,rack_image',
    id: `in.(${ids.map((i) => `"${i.replace(/["\\]/g, '')}"`).join(',')})`,
  });
  const res = await fetch(`${url}/rest/v1/products?${qs}`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error('products lookup failed: ' + res.status);
  const rows = await res.json();
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  return items.map((it) => {
    const product = byId.get(String(it.product_id));
    if (!product) throw Object.assign(new Error('找不到商品,請重新整理後再試'), { status: 400 });
    return { product, slot: it.slot, region: regionOf(product, it.slot) };
  });
}

async function fetchImage(src) {
  const res = await fetch(src, { headers: { accept: 'image/webp,image/png,image/jpeg,*/*' } });
  if (!res.ok) throw new Error(`image ${res.status}`);
  const type = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
  if (!/^image\/(jpeg|png|webp)$/.test(type)) throw new Error('unsupported image type ' + type);
  return { buf: Buffer.from(await res.arrayBuffer()), type };
}

/* ── 生成:OpenAI ───────────────────────────────────────── */
async function generateOpenAI(prompt, images) {
  const form = new FormData();
  form.append('model', process.env.TRYON_OPENAI_MODEL || 'gpt-image-2');
  form.append('prompt', prompt);
  form.append('size', 'auto');
  form.append('quality', process.env.TRYON_OPENAI_QUALITY || 'medium');
  form.append('output_format', 'jpeg');      // PNG 約 2.5MB,JPEG 小很多,手機載入快
  form.append('output_compression', '88');
  images.forEach((img, i) => {
    const ext = img.type === 'image/png' ? 'png' : img.type === 'image/webp' ? 'webp' : 'jpg';
    form.append('image[]', new Blob([img.buf], { type: img.type }), `ref${i}.${ext}`);
  });
  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.data?.[0]?.b64_json) {
    throw new Error('openai: ' + (data.error?.message || `HTTP ${res.status}`));
  }
  return { image: data.data[0].b64_json, mimeType: 'image/jpeg' };
}

/* ── 生成:Gemini ───────────────────────────────────────── */
async function generateGemini(prompt, images) {
  const model = process.env.TRYON_GEMINI_MODEL || 'gemini-3.1-flash-image';
  const parts = [{ text: prompt }, ...images.map((img) => ({
    inlineData: { mimeType: img.type, data: img.b64 || img.buf.toString('base64') },
  }))];
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || `HTTP ${res.status}`;
    throw new Error((msg.includes('location is not supported') ? 'region: ' : 'gemini: ') + msg);
  }
  const img = (data.candidates || []).flatMap((c) => c.content?.parts || []).find((p) => p.inlineData);
  if (!img) throw new Error('gemini: no image (' + (data.candidates?.[0]?.finishReason || 'unknown') + ')');
  return { image: img.inlineData.data, mimeType: img.inlineData.mimeType || 'image/png' };
}

/* ── Phase 1: Content moderation ──────────────────────────────────── */
/**
 * Pre-check selfie image with Gemini Flash (text+vision).
 * Returns { safe: boolean, reason: string, message: string }
 * Cost: ~258 input tokens + ~50 output tokens ≈ negligible per call.
 */
async function moderateImage(imageBase64, mimeType, GEMINI_KEY) {
  const moderationPrompt = [
    'You are a strict content safety classifier for a fashion virtual try-on service.',
    '',
    'Analyze the image and return ONLY a JSON object (no markdown, no explanation):',
    '{"safe": true|false, "category": "...", "reason": "..."}',
    '',
    'BLOCK (set safe=false) if image contains ANY of the following:',
    '- Nudity, partial nudity, lingerie/underwear-only, or sexually suggestive content',
    '- Pornographic, fetish, or explicit sexual content',
    '- Minors (anyone appearing under 18 years old)',
    '- Violence, gore, blood, weapons, or threatening content',
    '- Illegal content (drugs, illegal goods)',
    '- Hate symbols, extremist content',
    '- No human person visible (e.g. blank, abstract, animal-only, screenshot of unrelated content)',
    '',
    'ALLOW (set safe=true) if:',
    '- A clearly clothed adult is visible',
    '- Normal everyday photo, selfie, full-body or half-body shot',
    '',
    'Categories to use when blocking: "nudity" | "minor" | "violence" | "illegal" | "hate" | "no_person"',
    'Return JSON only. No code fences, no extra text.'
  ].join('\n');

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 15000); // 15s for moderation

  try {
    const res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GEMINI_KEY,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { text: moderationPrompt },
              { inlineData: { mimeType: mimeType || 'image/jpeg', data: imageBase64 } }
            ]
          }],
          generationConfig: {
            temperature: 0.0,
            responseMimeType: 'application/json'
          }
        })
      }
    );
    clearTimeout(tid);

    if (!res.ok) {
      // If moderation API itself fails, fail-open with a warning log (don't block legitimate users on API hiccups)
      console.warn('[moderate] API returned status ' + res.status + ' — failing open');
      return { safe: true, category: 'unknown', reason: 'moderation_unavailable' };
    }

    const data = await res.json();
    const textOut = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let parsed;
    try {
      parsed = JSON.parse(textOut);
    } catch (e) {
      // Try to extract JSON from possibly-wrapped output
      const m = textOut.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch (_) {}
      }
    }
    if (!parsed || typeof parsed.safe !== 'boolean') {
      console.warn('[moderate] could not parse output: ' + textOut.substring(0, 200));
      return { safe: true, category: 'unknown', reason: 'parse_error' };
    }
    return {
      safe: parsed.safe,
      category: parsed.category || (parsed.safe ? 'safe' : 'blocked'),
      reason: parsed.reason || ''
    };
  } catch (err) {
    clearTimeout(tid);
    console.warn('[moderate] error: ' + (err.message || err));
    // Fail-open on transient errors so legitimate users aren't blocked
    return { safe: true, category: 'unknown', reason: 'moderation_error' };
  }
}

/* User-friendly Chinese rejection message per category */
function rejectionMessage(category) {
  switch (category) {
    case 'nudity':   return '上傳的照片不符規範，請使用穿著正常服裝的個人照片再試。';
    case 'minor':    return '試衣功能僅限成年人使用，請使用成年人的照片。';
    case 'violence': return '上傳的照片含不適當內容，請更換照片再試。';
    case 'illegal':  return '上傳的照片含不適當內容，請更換照片再試。';
    case 'hate':     return '上傳的照片含不適當內容，請更換照片再試。';
    case 'no_person':return '無法在照片中辨識出人物，請使用清晰的個人正面或半身照。';
    default:         return '上傳的照片不符規範，請更換照片再試。';
  }
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasGemini = !!process.env.GEMINI_API_KEY;
  if (!hasOpenAI && !hasGemini) return json(500, { error: 'AI provider not configured' });

  try {
    const { selfieBase64, selfieType, items } = await request.json();
    if (!selfieBase64) return json(400, { error: 'Missing selfie image' });
    if (!Array.isArray(items) || items.length === 0) return json(400, { error: '請至少選擇一件商品' });
    if (items.length > MAX_ITEMS) return json(400, { error: `一次最多試穿 ${MAX_ITEMS} 件` });
    const selfieMime = /^image\/(jpeg|png|webp)$/.test(selfieType) ? selfieType : 'image/jpeg';

    /* 1. 內容審查 */
    if (hasGemini) {
      const verdict = await moderateImage(selfieBase64, selfieMime, process.env.GEMINI_API_KEY);
      if (!verdict.safe) {
        return json(403, {
          error: 'content_blocked', category: verdict.category,
          message: rejectionMessage(verdict.category), details: verdict.reason,
        });
      }
    }

    /* 2. 商品與參考圖(衣架去背圖優先,再加封面圖) */
    const loaded = await loadProducts(items);
    for (const it of loaded) {
      const srcs = [it.product.rack_image, it.product.cover_image].filter(Boolean).slice(0, MAX_REFS_PER_ITEM);
      it.refs = [];
      for (const src of srcs) {
        try { it.refs.push(await fetchImage(src)); } catch (e) { console.warn('[tryon] ref image failed', it.product.id, e.message); }
      }
      if (!it.refs.length) return json(400, { error: '商品圖片無法載入,請試試其他款式' });
    }
    const prompt = buildPrompt(loaded);
    const selfie = { buf: Buffer.from(selfieBase64, 'base64'), b64: selfieBase64, type: selfieMime };
    const images = [selfie, ...loaded.flatMap((it) => it.refs)];

    /* 3. 生成:OpenAI → 失敗改 Gemini */
    const attempts = [];
    if (hasOpenAI) attempts.push(['openai', generateOpenAI]);
    if (hasGemini) attempts.push(['gemini', generateGemini]);
    const errors = [];
    for (const [name, run] of attempts) {
      try {
        const out = await run(prompt, images);
        return json(200, { success: true, image: out.image, mimeType: out.mimeType, model: name });
      } catch (e) {
        console.warn(`[tryon] ${name} failed:`, e.message);
        errors.push(e.message);
      }
    }
    const blocked = errors.some((m) => /safety|moderation|blocked|PROHIBITED|SAFETY/i.test(m));
    return json(blocked ? 422 : 502, {
      error: blocked ? 'generation_blocked' : 'generation_failed',
      message: blocked ? '這套穿搭 AI 無法生成,請換一件商品或換張照片再試。' : 'AI 生成失敗,請稍後再試一次。',
      details: errors.join(' | ').slice(0, 500),
    });
  } catch (err) {
    return json(err.status || 500, { error: err.message || 'Unknown server error' });
  }
}

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
