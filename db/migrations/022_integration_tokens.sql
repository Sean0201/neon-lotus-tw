-- ═══════════════════════════════════════════════════════════════
-- 022_integration_tokens.sql — 外部服務權杖(Threads 自動續期用)
-- ───────────────────────────────────────────────────────────────
-- api/lib/threads-token.js 每 7 天續期 Threads 長效權杖,新權杖存這裡。
-- RLS 開啟且不建立任何 policy:只有後端 service role 讀寫得到,
-- 網頁公開金鑰(anon)與登入會員都讀不到。
--
-- 執行:Supabase → SQL Editor → 貼上整份 → Run。可重複執行。
-- ═══════════════════════════════════════════════════════════════

create table if not exists public.integration_tokens (
  key          text primary key,
  token        text not null,
  env_hash     text,                 -- 對應的環境變數權杖雜湊(偵測手動更換)
  expires_at   timestamptz,
  refreshed_at timestamptz not null default now()
);

alter table public.integration_tokens enable row level security;
revoke all on public.integration_tokens from anon, authenticated;
