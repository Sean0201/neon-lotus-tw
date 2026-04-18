/**
 * /api/tryon.js — Vercel Serverless Function
 * Proxies virtual try-on requests to Google Gemini 2.5 Flash (Nano Banana 2)
 * Keeps API key server-side for security.
 */

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  try {
    const { selfieBase64, selfieType, clothingUrl, clothingBase64, clothingType, productName } = req.body;

    if (!selfieBase64) return res.status(400).json({ error: 'Missing selfie image' });
    if (!clothingBase64 && !clothingUrl) return res.status(400).json({ error: 'Missing clothing image' });

    // Build image parts
    const parts = [];

    // Prompt
    parts.push({
      text: `You are a virtual fitting room assistant. The user wants to try on "${productName || 'this clothing item'}".

TASK: Generate ONE photorealistic image showing the person in the first image wearing the clothing item shown in the second image.

CRITICAL RULES:
- Preserve the person's face, hairstyle, skin tone, body shape, pose, and proportions EXACTLY
- Replace ONLY the relevant clothing with the garment from the second image
- Maintain the original photo's lighting, camera angle, and background
- The clothing must look naturally fitted — correct draping, folds, shadows
- Output a single high-quality photorealistic image
- Do NOT add text, watermarks, or borders`
    });

    // Selfie image
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
      // Fetch clothing image and convert to base64
      const imgRes = await fetch(clothingUrl);
      if (!imgRes.ok) return res.status(400).json({ error: 'Failed to fetch clothing image' });
      const imgBuf = await imgRes.arrayBuffer();
      const imgBase64 = Buffer.from(imgBuf).toString('base64');
      const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
      parts.push({
        inlineData: {
          mimeType: contentType,
          data: imgBase64
        }
      });
    }

    // Call Gemini API (Nano Banana — gemini-2.5-flash-image)
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            temperature: 0.4
          }
        })
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('Gemini API error:', errText);
      return res.status(geminiRes.status).json({ error: 'Gemini API error', details: errText });
    }

    const geminiData = await geminiRes.json();

    // Extract image from response
    const candidates = geminiData.candidates || [];
    for (const candidate of candidates) {
      const resParts = candidate.content?.parts || [];
      for (const part of resParts) {
        if (part.inlineData) {
          return res.status(200).json({
            success: true,
            image: part.inlineData.data,
            mimeType: part.inlineData.mimeType || 'image/png'
          });
        }
      }
    }

    return res.status(500).json({
      error: 'No image generated',
      raw: JSON.stringify(geminiData).substring(0, 500)
    });

  } catch (err) {
    console.error('Try-on error:', err);
    return res.status(500).json({ error: err.message });
  }
}
