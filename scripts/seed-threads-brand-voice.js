#!/usr/bin/env node
/**
 * seed-threads-brand-voice.js
 * ─────────────────────────────────────────────────────────────────
 * 把本地 style_guide.md / concept_library.md 同步到 Supabase
 * threads_brand_voice 表，讓 Vercel 上的 threads-telegram-webhook.js
 * 可以在拒絕草稿時自動重新產稿（serverless 環境無法讀本地檔案）。
 *
 * 每次更新 style_guide.md 或 concept_library.md 後，重新跑一次這支腳本。
 *
 * 用法: node scripts/seed-threads-brand-voice.js
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

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ .env 缺少 NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const styleGuide = fs.readFileSync(path.join(ROOT, 'style_guide.md'), 'utf-8');
const conceptLib = fs.readFileSync(path.join(ROOT, 'concept_library.md'), 'utf-8');

async function main() {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('threads_brand_voice')
    .upsert([
      { key: 'style_guide', content: styleGuide, updated_at: now },
      { key: 'concept_library', content: conceptLib, updated_at: now },
    ]);

  if (error) {
    console.error('❌ 同步失敗:', error.message);
    process.exit(1);
  }
  console.log('✅ 已同步 style_guide.md / concept_library.md 到 Supabase threads_brand_voice');
}

main();
