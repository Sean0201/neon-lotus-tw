/**
 * /api/threads-telegram-webhook.js — 接收 Telegram 核准/拒絕按鈕回呼
 *
 * 流程:
 *   1. Telegram 使用者按「核准」或「拒絕」→ Telegram 送 callback_query 到這裡
 *   2. 驗證來源 (Telegram secret token header)
 *   3. 解析 callback_data: "approve:<uuid>" | "reject:<uuid>"
 *   4. 更新 Supabase threads_posts.status
 *   5. 回覆 Telegram：關閉按鈕、顯示結果
 *
 * 環境變數:
 *   SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_KEY / SUPABASE_SERVICE_ROLE_KEY
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_WEBHOOK_SECRET — 註冊 webhook 時帶的 secret_token，用來驗證請求真的來自 Telegram
 *
 * 部署後註冊 webhook (只需跑一次):
 *   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<你的網域>/api/threads-telegram-webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
 */

export const config = { runtime: 'nodejs', maxDuration: 10 };

function getSupabaseEnv() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { url, key };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
  const { url: SUPABASE_URL, key: SUPABASE_KEY } = getSupabaseEnv();

  if (!TG_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[threads-telegram-webhook] missing env vars');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  // 驗證請求真的來自 Telegram
  if (WEBHOOK_SECRET) {
    const gotSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (gotSecret !== WEBHOOK_SECRET) {
      console.error('[threads-telegram-webhook] secret token mismatch');
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  const update = req.body;
  const cq = update?.callback_query;

  // 不是按鈕回呼（例如一般訊息），直接 200 回應，避免 Telegram 重送
  if (!cq) return res.status(200).json({ ok: true });

  try {
    const [action, postId] = String(cq.data || '').split(':');
    if (!['approve', 'reject'].includes(action) || !postId) {
      await answerCallback(TG_TOKEN, cq.id, '⚠️ 無法識別的操作');
      return res.status(200).json({ ok: true });
    }

    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

    const { data: row, error: fetchErr } = await supabase
      .from('threads_posts')
      .select('id, draft, status')
      .eq('id', postId)
      .single();

    if (fetchErr || !row) {
      await answerCallback(TG_TOKEN, cq.id, '⚠️ 找不到這篇草稿');
      return res.status(200).json({ ok: true });
    }

    if (row.status !== 'pending_approval') {
      await answerCallback(TG_TOKEN, cq.id, `已經處理過了（狀態：${row.status}）`);
      return res.status(200).json({ ok: true });
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    const updatePayload = { status: newStatus };
    if (action === 'approve') updatePayload.approved_draft = row.draft;

    const { error: updateErr } = await supabase
      .from('threads_posts')
      .update(updatePayload)
      .eq('id', postId);

    if (updateErr) {
      console.error('[threads-telegram-webhook] update failed', updateErr);
      await answerCallback(TG_TOKEN, cq.id, '⚠️ 更新失敗，請稍後再試');
      return res.status(200).json({ ok: true });
    }

    const feedback = action === 'approve' ? '✅ 已核准，等待排程發文' : '❌ 已拒絕';
    await answerCallback(TG_TOKEN, cq.id, feedback);

    // 更新原訊息：移除按鈕，附上結果
    const originalText = cq.message?.text || '';
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        text: `${originalText}\n\n${feedback}`,
        parse_mode: 'Markdown',
      }),
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[threads-telegram-webhook]', err);
    return res.status(200).json({ ok: true });
  }
}

async function answerCallback(token, callbackQueryId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  } catch (e) {
    console.error('[answerCallback] failed', e);
  }
}
