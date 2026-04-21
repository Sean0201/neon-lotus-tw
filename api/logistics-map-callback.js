/**
 * /api/logistics-map-callback.js — Vercel Serverless Function (Node.js)
 * 接收綠界超商地圖選擇結果
 *
 * 使用者在綠界地圖選完門市後，綠界 POST 結果到此 endpoint
 * 此 endpoint 將結果回傳給前端 (透過 postMessage 或 redirect)
 *
 * 綠界回傳欄位:
 *   MerchantID, MerchantTradeNo, LogisticsSubType,
 *   CVSStoreID, CVSStoreName, CVSAddress, CVSTelephone, CVSOutSide
 */

export const config = { runtime: 'nodejs', maxDuration: 15 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  const {
    CVSStoreID,
    CVSStoreName,
    CVSAddress,
    CVSTelephone,
    LogisticsSubType,
  } = req.body;

  console.log('[Logistics Map Callback]', JSON.stringify(req.body));

  // 回傳一個 HTML 頁面，用 postMessage 將門市資訊傳給父視窗
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>門市選擇完成</title></head>
<body>
  <p>已選擇門市：${escapeHtml(CVSStoreName || '')} (${escapeHtml(CVSStoreID || '')})</p>
  <p>地址：${escapeHtml(CVSAddress || '')}</p>
  <p>正在關閉視窗...</p>
  <script>
    // 傳送門市資訊給父視窗
    if (window.opener) {
      window.opener.postMessage({
        type: 'ecpay-cvs-store',
        storeId: ${JSON.stringify(CVSStoreID || '')},
        storeName: ${JSON.stringify(CVSStoreName || '')},
        storeAddress: ${JSON.stringify(CVSAddress || '')},
        storeTelephone: ${JSON.stringify(CVSTelephone || '')},
        logisticsSubType: ${JSON.stringify(LogisticsSubType || '')},
      }, '*');
      setTimeout(() => window.close(), 1500);
    } else {
      document.body.innerHTML += '<p>請手動關閉此視窗，並回到 Neon Lotus 結帳頁面。</p>';
    }
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
}
