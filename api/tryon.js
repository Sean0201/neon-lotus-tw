/**
 * /api/tryon.js — Vercel Edge Function
 * Proxies virtual try-on requests to Google Gemini 2.5 Flash Image
 * Supports: tops, bottoms, bags, hats — with layered outfit composition
 *
 * Pipeline:
 *   1. Content moderation pre-check (Gemini Flash vision) — blocks porn/illegal/minor
 *   2. Structured try-on prompt (face/body/background preservation locked)
 *   3. Gemini 2.5 Flash Image generates final image
 */

export const config = { runtime: 'edge', maxDuration: 300, regions: ['iad1'] };

/* ── Phase 2: Structured prompt builder ───────────────────────────── */
function getPrompt(category, productName) {
  const pname = productName || 'this item';

  /* Shared rules — user's template:
     "Keep the original person unchanged. Preserve face, identity, body shape, and pose.
      Do not modify skin, face, or background. Only replace the clothing in the specified region.
      The clothing must fit naturally to the body. Keep lighting and perspective consistent." */
  const PRESERVE_RULES = [
    'PRESERVATION (LOCKED — DO NOT MODIFY):',
    '- Face: identity, facial features, expression, makeup',
    '- Hair: hairstyle, color, length, parting',
    '- Skin: tone, texture, marks, tattoos',
    '- Body: shape, proportions, height, weight, posture',
    '- Pose: arms, legs, head angle, gesture',
    '- Background: environment, lighting, shadows, perspective',
    '- Camera: angle, framing, focal length'
  ].join('\n');

  const NATURAL_FIT_RULES = [
    'NATURAL FIT REQUIREMENTS:',
    '- The garment must drape realistically over the body',
    '- Folds, wrinkles, and shadows must match the lighting direction',
    '- Edges must blend naturally with skin and surrounding clothing',
    '- Maintain consistent perspective with the original photo',
    '- Photorealistic quality, no cartoon/illustration style'
  ].join('\n');

  const OUTPUT_RULES = [
    'OUTPUT REQUIREMENTS:',
    '- ONE single photorealistic image',
    '- No text, no watermarks, no borders, no captions',
    '- Same aspect ratio as the input selfie'
  ].join('\n');

  const prompts = {
    top: [
      'You are a professional virtual fitting room. The user wants to try on the TOP garment "' + pname + '".',
      '',
      'TASK: Replace ONLY the upper-body clothing in the first image with the garment shown in the second image.',
      '',
      'TARGET REGION (modify ONLY this area):',
      '- Upper body: shirt / blouse / jacket / hoodie / sweater area',
      '- From shoulders down to waistline',
      '',
      'KEEP UNCHANGED:',
      '- Existing pants / shorts / skirt / bottoms',
      '- Existing shoes and accessories',
      '- Everything listed in PRESERVATION below',
      '',
      PRESERVE_RULES,
      '',
      NATURAL_FIT_RULES,
      '',
      OUTPUT_RULES
    ].join('\n'),

    bottom: [
      'You are a professional virtual fitting room. The user wants to try on the BOTTOM garment "' + pname + '".',
      '',
      'TASK: Replace ONLY the lower-body clothing in the first image with the item shown in the second image.',
      '',
      'TARGET REGION (modify ONLY this area):',
      '- Lower body: pants / shorts / skirt / trousers area',
      '- From waistline down to ankles (or hem of new garment)',
      '',
      'KEEP UNCHANGED:',
      '- Existing top / shirt / jacket / upper-body clothing',
      '- Existing shoes and accessories',
      '- Everything listed in PRESERVATION below',
      '',
      PRESERVE_RULES,
      '',
      NATURAL_FIT_RULES,
      '',
      OUTPUT_RULES
    ].join('\n'),

    bag: [
      'You are a professional virtual fitting room. The user wants to try on the BAG "' + pname + '".',
      '',
      'TASK: ADD the bag from the second image onto the person in the first image — naturally carried.',
      '',
      'TARGET REGION (add bag here):',
      '- On the shoulder, crossbody, or held in hand — choose the most natural placement based on bag style',
      '- Match strap length and bag size to body proportions',
      '',
      'KEEP UNCHANGED:',
      '- ALL existing clothing (top, bottom, shoes)',
      '- ALL other accessories already in the photo',
      '- Everything listed in PRESERVATION below',
      '',
      PRESERVE_RULES,
      '',
      NATURAL_FIT_RULES,
      '',
      OUTPUT_RULES
    ].join('\n'),

    hat: [
      'You are a professional virtual fitting room. The user wants to try on the HAT "' + pname + '".',
      '',
      'TASK: ADD the hat/cap from the second image onto the head of the person in the first image.',
      '',
      'TARGET REGION (add hat here):',
      '- On top of the head, matching the head angle',
      '- Hat size proportional to head size',
      '',
      'KEEP UNCHANGED:',
      '- ALL existing clothing',
      '- Hairstyle visible below the hat brim',
      '- Everything listed in PRESERVATION below',
      '',
      PRESERVE_RULES,
      '',
      NATURAL_FIT_RULES,
      '',
      OUTPUT_RULES
    ].join('\n')
  };

  return prompts[category] || [
    'You are a professional virtual fitting room. The user wants to try on "' + pname + '".',
    '',
    'TASK: Replace the relevant clothing in the first image with the item shown in the second image.',
    '',
    PRESERVE_RULES,
    '',
    NATURAL_FIT_RULES,
    '',
    OUTPUT_RULES
  ].join('\n');
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
  // CORS
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }

  if (request.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) return json(500, { error: 'GEMINI_API_KEY not configured' });

  try {
    const body = await request.json();
    const {
      selfieBase64, selfieType,
      clothingUrl, clothingBase64, clothingType,
      maskBase64, maskType, maskRegion,
      productName, category,
      isLayered  // when true, selfieBase64 is a previous AI-generated result, skip moderation
    } = body;

    if (!selfieBase64) return json(400, { error: 'Missing selfie image' });
    if (!clothingBase64 && !clothingUrl) return json(400, { error: 'Missing clothing image' });

    /* ── Phase 1: Content moderation (only on first layer / real user-uploaded selfie) ── */
    if (!isLayered) {
      const verdict = await moderateImage(selfieBase64, selfieType, GEMINI_KEY);
      if (!verdict.safe) {
        return json(403, {
          error: 'content_blocked',
          category: verdict.category,
          message: rejectionMessage(verdict.category),
          details: verdict.reason
        });
      }
    }

    // Build prompt based on category (and append mask instructions if a mask is provided)
    let promptText = getPrompt(category, productName);
    if (maskBase64) {
      promptText += '\n\n' + [
        'MASK GUIDANCE:',
        'A third reference image is provided as a binary MASK.',
        '- WHITE pixels in the mask = the ONLY region you may modify (the clothing area)',
        '- BLACK pixels in the mask = STRICTLY PRESERVE — do not alter at all',
        '- The mask precisely defines the ' + (maskRegion === 'bottom' ? 'lower-body' : 'upper-body') + ' clothing region within the person silhouette',
        '- Outside the white region: face, skin, hair, background, lighting, and other clothing must remain pixel-identical to the input',
        '- Use the mask as ground truth for editing boundaries — respect it precisely'
      ].join('\n');
    }

    // Build image parts
    const parts = [];
    parts.push({ text: promptText });

    // Selfie image (or previous result for layered composition)
    parts.push({
      inlineData: {
        mimeType: selfieType || 'image/jpeg',
        data: selfieBase64
      }
    });

    // Clothing image
    if (clothingBase64) {
      parts.push({
        inlineData: {
          mimeType: clothingType || 'image/jpeg',
          data: clothingBase64
        }
      });
    } else if (clothingUrl) {
      const imgRes = await fetch(clothingUrl);
      if (!imgRes.ok) return json(400, { error: 'Failed to fetch clothing image', details: 'status ' + imgRes.status + ' from ' + clothingUrl.substring(0, 100) });
      const imgBuf = await imgRes.arrayBuffer();
      const bytes = new Uint8Array(imgBuf);
      /* Chunk-based btoa to avoid string size limits in Edge runtime */
      const CHUNK = 8192;
      let binary = '';
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
      }
      const imgBase64 = btoa(binary);
      const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
      parts.push({
        inlineData: {
          mimeType: contentType,
          data: imgBase64
        }
      });
    }

    // Mask image (Phase 3) — append as third reference if provided
    if (maskBase64) {
      parts.push({
        inlineData: {
          mimeType: maskType || 'image/png',
          data: maskBase64
        }
      });
    }

    // Call Gemini API with timeout protection
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 250000); // 250s timeout

    let geminiRes;
    try {
      geminiRes = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + GEMINI_KEY,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig: {
              responseModalities: ['TEXT', 'IMAGE'],
              temperature: 0.4
            }
          })
        }
      );
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr.name === 'AbortError') {
        return json(504, { error: 'Gemini API timeout', details: 'The AI took too long to generate the image. Please try again.' });
      }
      throw fetchErr;
    }
    clearTimeout(timeoutId);

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      // Friendly error for region restriction
      if (errText.includes('location is not supported')) {
        return json(400, { error: 'Region not supported', details: 'location_error' });
      }
      return json(geminiRes.status, { error: 'Gemini API error', details: errText.substring(0, 500) });
    }

    const geminiData = await geminiRes.json();

    // Extract image from response
    const candidates = geminiData.candidates || [];
    for (const candidate of candidates) {
      const resParts = candidate.content?.parts || [];
      for (const part of resParts) {
        if (part.inlineData) {
          return json(200, {
            success: true,
            image: part.inlineData.data,
            mimeType: part.inlineData.mimeType || 'image/png'
          });
        }
      }
    }

    return json(500, {
      error: 'No image generated',
      raw: JSON.stringify(geminiData).substring(0, 500)
    });

  } catch (err) {
    return json(500, { error: err.message || 'Unknown server error', details: String(err.stack || err).substring(0, 300) });
  }
}

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
