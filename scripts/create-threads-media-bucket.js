#!/usr/bin/env node
/**
 * 建立 Supabase Storage 公開 bucket，供 Telegram 上傳的圖片/影片存放。
 * 只需要跑一次。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadEnv() {
  const env = {};
  const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf-8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const env = loadEnv();
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const BUCKET = 'threads-media';

async function main() {
  const { data: buckets } = await supabase.storage.listBuckets();
  if (buckets?.some((b) => b.name === BUCKET)) {
    console.log(`✅ bucket "${BUCKET}" 已存在`);
    return;
  }
  const { error } = await supabase.storage.createBucket(BUCKET, {
    public: true,
    fileSizeLimit: '52428800', // 50MB
  });
  if (error) throw error;
  console.log(`✅ 已建立公開 bucket "${BUCKET}"`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
