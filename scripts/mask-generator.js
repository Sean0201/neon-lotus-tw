/**
 * scripts/mask-generator.js — MediaPipe-powered clothing mask generator
 *
 * Uses MediaPipe Tasks Vision:
 *   - Image Segmenter (selfie_segmenter)  → person silhouette
 *   - Pose Landmarker  (pose_landmarker_lite) → hip / shoulder / knee Y coords
 *
 * Combines both to produce an upper-body or lower-body clothing mask:
 *   WHITE pixels = region the AI may modify (clothing region within person)
 *   BLACK pixels = locked (face / background / wrong-region clothing)
 *
 * Used by outfit-builder.js to send a mask image to /api/tryon, which forwards
 * it to Gemini as a third reference image with prompt instructions to honour
 * the mask boundary.
 *
 * Lazy-loaded on first use; subsequent calls reuse the same instances.
 *
 * Public API: window.MaskGenerator
 *   - .generateMask(b64, mimeType, region)  → { base64, mimeType }
 *   - .regionFor(category)                  → 'top' | 'bottom' | null
 *   - .preload()                            → kick off model load (idle)
 *   - .isReady()                            → boolean
 */

(function () {
  'use strict';

  const CDN_BASE        = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
  const VISION_BUNDLE   = CDN_BASE + '/vision_bundle.mjs';
  const WASM_PATH       = CDN_BASE + '/wasm';
  const SEGMENTER_MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';
  const POSE_MODEL      = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';

  let _segmenter      = null;
  let _pose           = null;
  let _ready          = false;
  let _loadingPromise = null;

  async function _ensureLoaded() {
    if (_ready) return;
    if (_loadingPromise) return _loadingPromise;

    _loadingPromise = (async () => {
      // Dynamic ES module import (CDN ESM build)
      const mod = await import(/* @vite-ignore */ VISION_BUNDLE);
      const { FilesetResolver, ImageSegmenter, PoseLandmarker } = mod;

      const resolver = await FilesetResolver.forVisionTasks(WASM_PATH);

      [_segmenter, _pose] = await Promise.all([
        ImageSegmenter.createFromOptions(resolver, {
          baseOptions:           { modelAssetPath: SEGMENTER_MODEL, delegate: 'GPU' },
          runningMode:           'IMAGE',
          outputCategoryMask:    true,
          outputConfidenceMasks: false
        }),
        PoseLandmarker.createFromOptions(resolver, {
          baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'GPU' },
          runningMode: 'IMAGE',
          numPoses:    1
        })
      ]);
      _ready = true;
    })().catch(err => {
      _loadingPromise = null;     // allow retry next call
      throw err;
    });

    return _loadingPromise;
  }

  function _b64ToImg(b64, mimeType) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload  = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to decode selfie image'));
      img.src = 'data:' + (mimeType || 'image/jpeg') + ';base64,' + b64;
    });
  }

  /**
   * Generate a clothing-region mask for a given selfie.
   *
   * @param  {string} selfieBase64 raw base64 (no data: prefix)
   * @param  {string} selfieType   mime type, e.g. 'image/jpeg'
   * @param  {'top'|'bottom'} region
   * @return {Promise<{base64:string, mimeType:string, debug:object}>}
   */
  async function generateMask(selfieBase64, selfieType, region) {
    if (region !== 'top' && region !== 'bottom') {
      throw new Error('region must be "top" or "bottom"');
    }
    await _ensureLoaded();

    const img = await _b64ToImg(selfieBase64, selfieType);
    const W = img.naturalWidth  || img.width;
    const H = img.naturalHeight || img.height;
    if (!W || !H) throw new Error('Selfie has zero dimensions');

    // ── 1. Segmentation: person silhouette ────────────────────────────
    const segRes  = _segmenter.segment(img);
    const segMask = segRes.categoryMask;
    if (!segMask) throw new Error('Segmenter returned no mask');
    const segData = segMask.getAsUint8Array();

    // ── 2. Pose: locate hip line for top/bottom split ─────────────────
    const poseRes  = _pose.detect(img);
    const lms      = (poseRes.landmarks && poseRes.landmarks[0]) || null;

    let hipY, shoulderY, kneeY;
    if (lms) {
      hipY      = (lms[23].y + lms[24].y) / 2;   // 23/24 = left/right hip
      shoulderY = (lms[11].y + lms[12].y) / 2;   // 11/12 = left/right shoulder
      kneeY     = (lms[25].y + lms[26].y) / 2;   // 25/26 = left/right knee
    } else {
      // Fallback: heuristic split at 55% height (works for typical selfies)
      hipY      = 0.55;
      shoulderY = 0.20;
      kneeY     = 0.85;
    }
    const hipPx = Math.round(hipY * H);

    // ── 3. Build mask canvas (white = modify, black = preserve) ───────
    const canvas = document.createElement('canvas');
    canvas.width  = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const out = ctx.createImageData(W, H);

    // selfie_segmenter category mask: non-zero = person, 0 = background
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i        = y * W + x;
        const isPerson = segData[i] !== 0;
        const inRegion = region === 'top' ? y < hipPx : y >= hipPx;
        const white    = isPerson && inRegion;
        const off      = i * 4;
        out.data[off]     = white ? 255 : 0;
        out.data[off + 1] = white ? 255 : 0;
        out.data[off + 2] = white ? 255 : 0;
        out.data[off + 3] = 255;
      }
    }
    ctx.putImageData(out, 0, 0);

    // Cleanup
    if (segMask.close) try { segMask.close(); } catch (_) {}

    // Export as PNG base64
    const dataUrl = canvas.toDataURL('image/png');
    const b64     = dataUrl.split(',')[1];

    return {
      base64:   b64,
      mimeType: 'image/png',
      debug:    { hipY, shoulderY, kneeY, hipPx, hadLandmarks: !!lms, w: W, h: H }
    };
  }

  /**
   * Map outfit category → mask region.
   * Returns null for categories that don't need a mask (bag, hat → additive).
   */
  function regionFor(category) {
    const cat = (category || '').toLowerCase();
    if (cat === 'top' || cat === 'tops' || cat === 'outerwear') return 'top';
    if (cat === 'bottom' || cat === 'bottoms' || cat === 'pants') return 'bottom';
    return null;
  }

  /**
   * Pre-load MediaPipe models in the background (idle priority).
   * Call this when the user uploads a selfie so mask gen is instant on click.
   */
  function preload() {
    const kick = () => _ensureLoaded().catch(err => {
      console.warn('[mask-generator] preload failed:', err.message || err);
    });
    if ('requestIdleCallback' in window) {
      requestIdleCallback(kick, { timeout: 5000 });
    } else {
      setTimeout(kick, 1500);
    }
  }

  window.MaskGenerator = {
    generateMask,
    regionFor,
    preload,
    isReady: function () { return _ready; }
  };
})();
