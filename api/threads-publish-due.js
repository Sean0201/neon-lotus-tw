/**
 * /api/threads-publish-due.js — 排程發文
 *
 * 由 Vercel Cron 定時呼叫。找出 threads_posts 裡
 * status = 'approved' 且 scheduled_at 已到的貼文，
 * 呼叫 Threads API 建立容器 → 發布，寫回結果，並用 Telegram 通知。
 *
 * 環境變數:
 *   SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_KEY / SUPABASE_SERVICE_ROLE_KEY
 *   THREADS_USER_ID           — Threads 帳號 id (numeric, from /me)
 *   THREADS_USER_ACCESS_TOKEN — 長期 access token
 *   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
 *   CRON_SECRET — 若有設定，只有帶正確 Authorization: Bearer <CRON_SECRET>
 *                 的請求才會執行（Vercel Cron 會自動帶這個 header）
 */

export const config = { runtime: 'nodejs', maxDuration: 60 };

function getSupabaseEnv() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { url, key };
}

export default async function handler(req, res) {
  const CRON_SECRET = process.env.CRON_SECRET;
  if (CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  const { url: SUPABASE_URL, key: SUPABASE_KEY } = getSupabaseEnv();
  const THREADS_USER_ID = process.env.THREADS_USER_ID;
  const THREADS_TOKEN = process.env.THREADS_USER_ACCESS_TOKEN;
  const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

  if (!SUPABASE_URL || !SUPABASE_KEY || !THREADS_USER_ID || !THREADS_TOKEN) {
    console.error('[threads-publish-due] missing env vars');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

  const { data: due, error: fetchErr } = await supabase
    .from('threads_posts')
    .select('id, approved_draft, topic_tag')
    .eq('status', 'approved')
    .lte('scheduled_at', new Date().toISOString());

  if (fetchErr) {
    console.error('[threads-publish-due] fetch failed', fetchErr);
    return res.status(500).json({ error: fetchErr.message });
  }

  const results = [];
  for (const row of due || []) {
    try {
      const postId = await publishToThreads({
        userId: THREADS_USER_ID,
        token: THREADS_TOKEN,
        text: row.approved_draft,
        topicTag: row.topic_tag,
      });

      await supabase
        .from('threads_posts')
        .update({ status: 'published', threads_post_id: postId, published_at: new Date().toISOString() })
        .eq('id', row.id);

      results.push({ id: row.id, ok: true, threads_post_id: postId });

      if (TG_TOKEN && TG_CHAT) {
        await notifyTelegram(TG_TOKEN, TG_CHAT, `✅ 已發文\nhttps://www.threads.com/@neon_lotus_select/post/${postId}`);
      }
    } catch (err) {
      console.error('[threads-publish-due] publish failed', row.id, err);
      await supabase
        .from('threads_posts')
        .update({ status: 'failed', error: String(err.message || err) })
        .eq('id', row.id);

      results.push({ id: row.id, ok: false, error: String(err.message || err) });

      if (TG_TOKEN && TG_CHAT) {
        await notifyTelegram(TG_TOKEN, TG_CHAT, `⚠️ 發文失敗（id: ${row.id}）\n${String(err.message || err)}`);
      }
    }
  }

  return res.status(200).json({ ok: true, processed: results.length, results });
}

async function publishToThreads({ userId, token, text, topicTag }) {
  const createParams = new URLSearchParams({
    media_type: 'TEXT',
    text,
    access_token: token,
  });
  if (topicTag) createParams.set('topic_tag', topicTag);

  const createRes = await fetch(`https://graph.threads.net/v1.0/${userId}/threads`, {
    method: 'POST',
    body: createParams,
  });
  const createData = await createRes.json();
  if (!createRes.ok || !createData.id) {
    throw new Error(`建立容器失敗: ${JSON.stringify(createData)}`);
  }

  // Threads API 建立容器後需要幾秒處理時間，太快發布會 "Media Not Found"
  await new Promise((resolve) => setTimeout(resolve, 30000));

  const publishParams = new URLSearchParams({
    creation_id: createData.id,
    access_token: token,
  });
  const publishRes = await fetch(`https://graph.threads.net/v1.0/${userId}/threads_publish`, {
    method: 'POST',
    body: publishParams,
  });
  const publishData = await publishRes.json();
  if (!publishRes.ok || !publishData.id) {
    throw new Error(`發布失敗: ${JSON.stringify(publishData)}`);
  }

  return publishData.id;
}

async function notifyTelegram(token, chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (e) {
    console.error('[notifyTelegram] failed', e);
  }
}
