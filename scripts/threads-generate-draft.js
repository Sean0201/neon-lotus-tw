#!/usr/bin/env node
/**
 * threads-generate-draft.js
 * ─────────────────────────────────────────────────────────────────
 * 依 style_guide.md + concept_library.md 產出一則 Threads 草稿，
 * 寫進 Supabase threads_posts 表，再推送到 Telegram 給你核准。
 *
 * 用法:
 *   node scripts/threads-generate-draft.js \
 *     --topic "越南品牌選品清單" \
 *     --goal "帶動分享與收藏" \
 *     --facts "只列出已確認在賣的品牌與現貨狀態，不補寫價格" \
 *     --scheduled "2026-08-29T09:00:00+08:00"
 *
 * env 需求 (從 .env 自動讀):
 *   NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 *   OPENAI_API_KEY
 *   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
 * ─────────────────────────────────────────────────────────────────
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..');
const ENV_PATH   = path.join(ROOT, '.env');

// ─── .env 載入器 ─────────────────────────────────────────────────
function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) {
    console.error('❌ 找不到 .env');
    process.exit(1);
  }
  const out = {};
  const lines = fs.readFileSync(ENV_PATH, 'utf-8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

const env = loadEnv();
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_KEY   = env.OPENAI_API_KEY;
const TG_TOKEN     = env.TELEGRAM_BOT_TOKEN;
const TG_CHAT       = env.TELEGRAM_CHAT_ID;

for (const [k, v] of Object.entries({
  NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: SUPABASE_KEY,
  OPENAI_API_KEY: OPENAI_KEY,
  TELEGRAM_BOT_TOKEN: TG_TOKEN,
  TELEGRAM_CHAT_ID: TG_CHAT,
})) {
  if (!v) {
    console.error(`❌ .env 缺少 ${k}`);
    process.exit(1);
  }
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── 解析 CLI 參數 ───────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : '';
      out[key] = val;
    }
  }
  return out;
}

const argv = parseArgs();
if (!argv.topic || !argv.facts) {
  console.error('❌ 至少需要 --topic 與 --facts 參數');
  console.error('範例: node scripts/threads-generate-draft.js --topic "..." --facts "..." --goal "..." --scheduled "2026-08-29T09:00:00+08:00"');
  process.exit(1);
}

// ─── 讀品牌風格資料 ──────────────────────────────────────────────
const styleGuide = fs.readFileSync(path.join(ROOT, 'style_guide.md'), 'utf-8');
const conceptLib = fs.readFileSync(path.join(ROOT, 'concept_library.md'), 'utf-8');

// ─── 呼叫 OpenAI 產草稿 ──────────────────────────────────────────
async function generateDraft({ topic, goal, facts }) {
  const systemMsg = `你是 Neon Lotus（越南設計師品牌代購/選品）的 Threads 文案寫手。
嚴格依照下面提供的「風格指南」與「已使用過的內容/比喻清單」寫作：

1. 只用「已確認事實」欄位裡的資訊，不可捏造價格、庫存、授權、店址等未提供的細節。
2. 避免「風格指南」與「內容庫」中標記為疲乏（fatigue risk 高）的句型與比喻，例如「NPC/路人/反骨」這套挑釁框架短期內不要用。
3. 語氣依風格指南：口語直球、第二人稱「你/妳」、短句多行、無正式書面語。
4. 不要下 hashtag。可以視內容自然使用 1–2 個表情符號畫龍點睛（例如 🌶️⚡️這類風格指南裡出現過的），不要堆疊超過 2 個。
5. 只輸出貼文本文，不要加任何說明、標題或引號。

【風格指南】
${styleGuide}

【已使用內容/比喻庫（避免重複疲乏）】
${conceptLib}`;

  const userMsg = `主題：${topic}
目的：${goal || '（未指定，依風格指南判斷最適合的角度）'}
已確認事實：${facts}

請依此產出一則 Threads 貼文草稿。`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_KEY}`,
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
  return data.choices?.[0]?.message?.content?.trim();
}

// ─── 推送到 Telegram 供核准 ──────────────────────────────────────
async function sendForApproval(postId, draftText, scheduledAt) {
  const text = `📝 *新草稿待核准*\n\n${draftText}\n\n──────────\n預定發文：${scheduledAt || '（未排定，需核准後另外排時間）'}`;

  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TG_CHAT,
      text,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ 核准', callback_data: `approve:${postId}` },
          { text: '❌ 拒絕', callback_data: `reject:${postId}` },
        ]],
      },
    }),
  });

  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram 推送失敗: ${JSON.stringify(data)}`);
  return data.result.message_id;
}

// ─── 主流程 ──────────────────────────────────────────────────────
async function main() {
  console.log('🖊️  產生草稿中...');
  const draft = await generateDraft(argv);
  console.log('\n────── 草稿內容 ──────\n' + draft + '\n──────────────────\n');

  const { data: row, error: insertErr } = await supabase
    .from('threads_posts')
    .insert({
      topic: argv.topic,
      goal: argv.goal || null,
      facts: argv.facts,
      draft,
      status: 'pending_approval',
      scheduled_at: argv.scheduled || null,
    })
    .select()
    .single();

  if (insertErr) {
    console.error('❌ 寫入 Supabase 失敗:', insertErr.message);
    process.exit(1);
  }
  console.log(`✅ 已寫入 Supabase，id: ${row.id}`);

  const tgMsgId = await sendForApproval(row.id, draft, argv.scheduled);
  console.log(`✅ 已推送到 Telegram，message_id: ${tgMsgId}`);

  const { error: updateErr } = await supabase
    .from('threads_posts')
    .update({ telegram_message_id: tgMsgId })
    .eq('id', row.id);
  if (updateErr) console.error('⚠️  寫回 telegram_message_id 失敗:', updateErr.message);

  console.log('\n完成，請到 Telegram 核准或拒絕這則草稿。');
}

main().catch((e) => {
  console.error('Fatal:', e.message || e);
  process.exit(1);
});
