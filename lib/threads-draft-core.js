/**
 * lib/threads-draft-core.js — Threads 草稿產生共用邏輯
 *
 * 給 CLI 腳本 (scripts/threads-generate-draft.js) 與
 * Vercel serverless function (api/threads-telegram-webhook.js) 共用，
 * 不依賴檔案系統，styleGuide/conceptLib 由呼叫端傳入字串。
 */

export async function generateThreadsDraft({ topic, goal, facts, styleGuide, conceptLib, openaiKey }) {
  const systemMsg = `你是 Neon Lotus（越南設計師品牌代購/選品）的 Threads 文案寫手。
嚴格依照下面提供的「風格指南」與「已使用過的內容/比喻清單」寫作：

1. 只用「已確認事實」欄位裡的資訊，不可捏造價格、庫存、授權、店址等未提供的細節。
2. 避免「風格指南」與「內容庫」中標記為疲乏（fatigue risk 高）的句型與比喻，例如「NPC/路人/反骨」這套挑釁框架短期內不要用。
3. 語氣依風格指南：口語直球、第二人稱「你/妳」、短句多行、無正式書面語。
4. 不要下 hashtag。可以視內容自然使用 1–2 個表情符號畫龍點睛（例如 🌶️⚡️這類風格指南裡出現過的），不要堆疊超過 2 個。
5. 貼文本文只輸出內容，不要加任何說明、標題或引號。
6. 最後另起一行，格式固定為 \`TOPIC_TAG: <詞>\`，給出這篇貼文最貼切的 Threads 主題標籤（單一詞或短詞組，中文或英文皆可，不含 # 字號，不要用「越南代購」這種帳號自我標籤，要用讀者會拿來搜尋/瀏覽的主題詞，例如：穿搭、選品、設計師品牌）。

【風格指南】
${styleGuide}

【已使用內容/比喻庫（避免重複疲乏）】
${conceptLib}`;

  const userMsg = `主題：${topic}
目的：${goal || '（未指定，依風格指南判斷最適合的角度）'}
已確認事實：${facts}

請依此產出一則 Threads 貼文草稿，並在最後一行附上 TOPIC_TAG。`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${openaiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: userMsg },
      ],
      temperature: 0.8,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI API 失敗: ${res.status} ${errText}`);
  }

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content?.trim() || '';

  const match = raw.match(/\n?TOPIC_TAG:\s*(.+)\s*$/i);
  const topicTag = match ? match[1].trim() : null;
  const draft = match ? raw.slice(0, match.index).trim() : raw;

  return { draft, topicTag };
}
