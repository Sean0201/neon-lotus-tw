/**
 * /api/threads-publish-due.js — 排程發文
 *
 * 由 Vercel Cron 定時呼叫。找出 threads_posts 裡
 * status = 'approved' 且 scheduled_at 已到的貼文，
 * 呼叫 Threads API 建立容器 → 發布，寫回結果，並用 Telegram 通知。
 * media_items（Telegram webhook 附加的多筆圖片/影片）：
 *   2 筆以上 → 組成 Threads 相簿（CAROUSEL）；剛好 1 筆 → 發單張 IMAGE/VIDEO。
 * media_items 是空的但舊欄位 media_type/media_url 有值 → 走原本的單張邏輯（相容舊資料）。
 * 都沒有 → 純文字。
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

export const config = { runtime: 'nodejs', maxDuration: 120 };

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
    .select('id, approved_draft, topic_tag, media_type, media_url, media_items')
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
        mediaType: row.media_type,
        mediaUrl: row.media_url,
        mediaItems: row.media_items,
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

const MAX_CAROUSEL_ITEMS = 20; // Threads CAROUSEL 上限（Meta 官方文件）

// media_items 優先；沒有的話 fallback 回舊的單一 media_type/media_url 欄位
function normalizeMediaItems({ mediaType, mediaUrl, mediaItems }) {
  if (Array.isArray(mediaItems) && mediaItems.length) {
    return mediaItems
      .filter((it) => it && it.url && (it.type === 'IMAGE' || it.type === 'VIDEO'))
      .slice(0, MAX_CAROUSEL_ITEMS);
  }
  if (mediaType && mediaUrl) return [{ type: mediaType, url: mediaUrl }];
  return [];
}

async function publishToThreads({ userId, token, text, topicTag, mediaType, mediaUrl, mediaItems }) {
  const items = normalizeMediaItems({ mediaType, mediaUrl, mediaItems });

  if (items.length >= 2) {
    return await publishCarousel({ userId, token, text, topicTag, items });
  }

  const single = items[0];
  const type = single ? single.type : 'TEXT';
  const createParams = new URLSearchParams({ media_type: type, access_token: token });
  if (text) createParams.set('text', text);
  if (topicTag) createParams.set('topic_tag', topicTag);
  if (type === 'IMAGE') createParams.set('image_url', single.url);
  if (type === 'VIDEO') createParams.set('video_url', single.url);

  const createRes = await fetch(`https://graph.threads.net/v1.0/${userId}/threads`, {
    method: 'POST',
    body: createParams,
  });
  const createData = await createRes.json();
  if (!createRes.ok || !createData.id) {
    throw new Error(`建立容器失敗: ${JSON.stringify(createData)}`);
  }

  // 圖片/影片需要 Threads 端下載處理，輪詢容器狀態直到完成才能發布
  if (type !== 'TEXT') {
    await waitUntilContainerReady(createData.id, token);
  }

  return await publishContainer(userId, createData.id, token);
}

// 多筆媒體：先幫每筆建立 is_carousel_item 子容器，全部處理完成後，
// 再建立一個 media_type=CAROUSEL 的父容器把子容器串起來，最後發布父容器。
async function publishCarousel({ userId, token, text, topicTag, items }) {
  const childIds = [];
  for (const item of items) {
    const params = new URLSearchParams({
      media_type: item.type,
      is_carousel_item: 'true',
      access_token: token,
    });
    if (item.type === 'IMAGE') params.set('image_url', item.url);
    if (item.type === 'VIDEO') params.set('video_url', item.url);

    const res = await fetch(`https://graph.threads.net/v1.0/${userId}/threads`, { method: 'POST', body: params });
    const data = await res.json();
    if (!res.ok || !data.id) throw new Error(`建立相簿項目容器失敗: ${JSON.stringify(data)}`);
    childIds.push(data.id);
  }

  await waitAllContainersReady(childIds, token);

  const parentParams = new URLSearchParams({
    media_type: 'CAROUSEL',
    children: childIds.join(','),
    access_token: token,
  });
  if (text) parentParams.set('text', text);
  if (topicTag) parentParams.set('topic_tag', topicTag);

  const parentRes = await fetch(`https://graph.threads.net/v1.0/${userId}/threads`, { method: 'POST', body: parentParams });
  const parentData = await parentRes.json();
  if (!parentRes.ok || !parentData.id) throw new Error(`建立相簿容器失敗: ${JSON.stringify(parentData)}`);

  await waitUntilContainerReady(parentData.id, token);

  return await publishContainer(userId, parentData.id, token);
}

async function publishContainer(userId, creationId, token) {
  const publishParams = new URLSearchParams({
    creation_id: creationId,
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

async function waitUntilContainerReady(creationId, token, { maxWaitMs = 100000, intervalMs = 3000 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  // 先固定等一下，容器建立後不會立刻查得到狀態
  await new Promise((resolve) => setTimeout(resolve, 5000));

  while (Date.now() < deadline) {
    const res = await fetch(
      `https://graph.threads.net/v1.0/${creationId}?fields=status,error_message&access_token=${token}`
    );
    const data = await res.json();
    if (data.status === 'FINISHED') return;
    if (data.status === 'ERROR') {
      throw new Error(`媒體處理失敗: ${data.error_message || JSON.stringify(data)}`);
    }
    // IN_PROGRESS / EXPIRED(視為還在處理) → 繼續等
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('媒體處理逾時，可能檔案過大或處理時間超過 function 執行上限');
}

// 相簿子容器可能同時在處理，逐輪檢查所有還沒完成的，比逐一等待省時間
async function waitAllContainersReady(ids, token, { maxWaitMs = 100000, intervalMs = 3000 } = {}) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const pending = new Set(ids);
  const deadline = Date.now() + maxWaitMs;

  while (pending.size && Date.now() < deadline) {
    for (const id of Array.from(pending)) {
      const res = await fetch(
        `https://graph.threads.net/v1.0/${id}?fields=status,error_message&access_token=${token}`
      );
      const data = await res.json();
      if (data.status === 'FINISHED') {
        pending.delete(id);
      } else if (data.status === 'ERROR') {
        throw new Error(`媒體處理失敗（相簿項目 ${id}）: ${data.error_message || JSON.stringify(data)}`);
      }
    }
    if (pending.size) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  if (pending.size) throw new Error('相簿媒體處理逾時，可能檔案過大或項目過多');
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
