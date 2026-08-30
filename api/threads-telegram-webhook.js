/**
 * /api/threads-telegram-webhook.js — 接收 Telegram 核准/拒絕按鈕回呼
 *
 * 流程:
 *   1. Telegram 使用者按「核准」或「拒絕」→ Telegram 送 callback_query 到這裡
 *   2. 驗證來源 (Telegram secret token header)
 *   3. 解析 callback_data: "approve:<uuid>" | "reject:<uuid>"
 *   4. 更新 Supabase threads_posts.status
 *   5. 回覆 Telegram：關閉按鈕、顯示結果
 *   6. 使用者也可以直接「回覆」某則草稿訊息、貼上新文字，覆蓋該筆 draft
 *      （待核准或已核准都可以改；已核准的話會同步更新 approved_draft）
 *   7. 已核准的貼文按「❌ 拒絕」＝取消核准（按鈕會保留，不會因為核准而消失），
 *      會轉為 rejected 並自動重新產一則新草稿
 *   8. 直接輸入「查詢」「排程」「status」會回覆目前所有貼文的排程總覽
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

import { generateThreadsDraft } from '../lib/threads-draft-core.js';

export const config = { runtime: 'nodejs', maxDuration: 20 };

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
  const msg = update?.message;

  if (!cq) {
    if (!msg || typeof msg.text !== 'string' || !msg.text.trim()) {
      return res.status(200).json({ ok: true });
    }
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

    try {
      const STATUS_TRIGGERS = ['查詢', '排程', 'status', 'list', '總覽'];
      if (msg.reply_to_message) {
        // 回覆某則草稿訊息 → 用新文字覆蓋 draft
        await handleEditReply({ supabase, TG_TOKEN, msg });
      } else if (STATUS_TRIGGERS.includes(msg.text.trim().toLowerCase())) {
        await sendStatusOverview({ supabase, TG_TOKEN, chatId: msg.chat.id });
      }
    } catch (err) {
      console.error('[threads-telegram-webhook] message handling failed', err);
    }
    return res.status(200).json({ ok: true });
  }

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
      .select('id, draft, status, topic, goal, facts, scheduled_at')
      .eq('id', postId)
      .single();

    if (fetchErr || !row) {
      await answerCallback(TG_TOKEN, cq.id, '⚠️ 找不到這篇草稿');
      return res.status(200).json({ ok: true });
    }

    // 核准只能對「待核准」做；拒絕（＝取消）則待核准、已核准都可以做
    const cancelable = ['pending_approval', 'approved'];
    if (!cancelable.includes(row.status)) {
      await answerCallback(TG_TOKEN, cq.id, `已經處理過了（狀態：${row.status}）`);
      return res.status(200).json({ ok: true });
    }
    if (action === 'approve' && row.status === 'approved') {
      await answerCallback(TG_TOKEN, cq.id, '已經核准過了');
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

    const feedback =
      action === 'approve'
        ? '✅ 已核准，等待排程發文'
        : row.status === 'approved'
          ? '❌ 已取消核准'
          : '❌ 已拒絕';
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

    // 拒絕時自動重新產一則新草稿，同樣需要核准才會發文
    if (action === 'reject') {
      try {
        await regenerateDraft({ supabase, TG_TOKEN, chatId: cq.message.chat.id, original: row });
      } catch (regenErr) {
        console.error('[threads-telegram-webhook] regenerate failed', regenErr);
        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: cq.message.chat.id,
            text: `⚠️ 自動重新產稿失敗：${regenErr.message}`,
          }),
        });
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[threads-telegram-webhook]', err);
    return res.status(200).json({ ok: true });
  }
}

// 使用者直接回覆待核准草稿訊息 → 用新文字覆蓋 draft，保留核准/拒絕按鈕
async function handleEditReply({ supabase, TG_TOKEN, msg }) {
  const repliedMessageId = msg.reply_to_message.message_id;
  const chatId = msg.chat.id;
  const newText = msg.text.trim();

  const { data: row, error: fetchErr } = await supabase
    .from('threads_posts')
    .select('id, status, topic_tag, scheduled_at')
    .eq('telegram_message_id', repliedMessageId)
    .single();

  if (fetchErr || !row) return; // 回覆的不是我們追蹤的草稿訊息，忽略

  const editable = ['pending_approval', 'approved'];
  if (!editable.includes(row.status)) {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        reply_to_message_id: msg.message_id,
        text: `⚠️ 這則草稿目前狀態是「${row.status}」，已無法修改。`,
      }),
    });
    return;
  }

  const updatePayload = { draft: newText };
  if (row.status === 'approved') updatePayload.approved_draft = newText;

  const { error: updateErr } = await supabase
    .from('threads_posts')
    .update(updatePayload)
    .eq('id', row.id);

  if (updateErr) {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        reply_to_message_id: msg.message_id,
        text: `⚠️ 更新失敗：${updateErr.message}`,
      }),
    });
    return;
  }

  const displayText = `✏️ 草稿已手動修改\n\n${newText}\n\n──────────\n主題標籤：${row.topic_tag || '（無）'}\n預定發文：${row.scheduled_at || '（未排定）'}`;

  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: repliedMessageId,
      text: displayText,
    }),
  });

  const confirmText =
    row.status === 'approved'
      ? '✅ 已更新草稿內容，狀態仍是已核准，會照原排程時間發文。'
      : '✅ 已更新草稿內容，還沒核准，記得去上面按核准或拒絕。';

  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      reply_to_message_id: msg.message_id,
      text: confirmText,
    }),
  });
}

const STATUS_LABEL = {
  published: '✅ 已發布',
  approved: '🗓️ 已核准，等待發文',
  pending_approval: '⏳ 待核准',
  rejected: '❌ 已拒絕',
  failed: '⚠️ 發文失敗',
};

function formatTaipeiTime(iso) {
  if (!iso) return '（未排定）';
  return new Date(iso).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// 使用者輸入「查詢／排程／status」→ 回覆目前所有貼文的排程總覽
async function sendStatusOverview({ supabase, TG_TOKEN, chatId }) {
  const { data: rows, error } = await supabase
    .from('threads_posts')
    .select('topic, status, scheduled_at')
    .neq('status', 'rejected')
    .order('scheduled_at', { ascending: true });

  if (error) {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `⚠️ 查詢失敗：${error.message}` }),
    });
    return;
  }

  const lines = (rows || []).map(
    (r) => `${STATUS_LABEL[r.status] || r.status} ${formatTaipeiTime(r.scheduled_at)} ${r.topic}`
  );
  const text = lines.length ? `📋 目前排程總覽\n\n${lines.join('\n\n')}` : '目前沒有排程中的貼文。';

  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
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

// 拒絕後自動重新產一則新草稿，走一樣的核准流程
async function regenerateDraft({ supabase, TG_TOKEN, chatId, original }) {
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) throw new Error('缺少 OPENAI_API_KEY');

  const { data: voiceRows, error: voiceErr } = await supabase
    .from('threads_brand_voice')
    .select('key, content')
    .in('key', ['style_guide', 'concept_library']);

  if (voiceErr || !voiceRows || voiceRows.length < 2) {
    throw new Error('缺少品牌風格資料，請先執行 scripts/seed-threads-brand-voice.js');
  }

  const styleGuide = voiceRows.find((r) => r.key === 'style_guide')?.content || '';
  const conceptLib = voiceRows.find((r) => r.key === 'concept_library')?.content || '';

  const { draft, topicTag } = await generateThreadsDraft({
    topic: original.topic,
    goal: original.goal,
    facts: original.facts,
    styleGuide,
    conceptLib,
    openaiKey: OPENAI_KEY,
  });

  const { data: newRow, error: insertErr } = await supabase
    .from('threads_posts')
    .insert({
      topic: original.topic,
      goal: original.goal,
      facts: original.facts,
      draft,
      topic_tag: topicTag,
      status: 'pending_approval',
      scheduled_at: original.scheduled_at,
    })
    .select()
    .single();

  if (insertErr) throw new Error(`寫入 Supabase 失敗: ${insertErr.message}`);

  const text = `🔄 *草稿被拒絕，已重新產生新版本*\n\n${draft}\n\n──────────\n主題標籤：${topicTag || '（無）'}\n預定發文：${original.scheduled_at || '（未排定）'}`;

  const tgRes = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ 核准', callback_data: `approve:${newRow.id}` },
          { text: '❌ 拒絕', callback_data: `reject:${newRow.id}` },
        ]],
      },
    }),
  });

  const tgData = await tgRes.json();
  if (!tgData.ok) throw new Error(`Telegram 推送失敗: ${JSON.stringify(tgData)}`);

  await supabase
    .from('threads_posts')
    .update({ telegram_message_id: tgData.result.message_id })
    .eq('id', newRow.id);
}
