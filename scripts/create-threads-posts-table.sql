-- 建立 threads_posts 內容表：AI 產稿 → Telegram 核准 → 排程發文 → 寫回結果
create table if not exists threads_posts (
  id uuid primary key default gen_random_uuid(),
  topic text,                    -- 主題方向
  goal text,                     -- 這篇想達成什麼（引流/信任/促銷）
  facts text,                    -- 已確認的事實素材（給 AI 產稿用，AI 不可自行編造）
  draft text,                    -- AI 產出的草稿
  approved_draft text,           -- 人工確認/修改後的最終文字
  status text not null default 'draft',
    -- draft | pending_approval | approved | rejected | published | failed
  scheduled_at timestamptz,      -- 預計發文時間
  published_at timestamptz,      -- 實際發文時間
  threads_post_id text,          -- Threads API 回傳的貼文 id
  telegram_message_id bigint,    -- 送去核准的 Telegram 訊息 id
  error text,                    -- 失敗原因
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_threads_posts_status_scheduled
  on threads_posts (status, scheduled_at);

-- updated_at 自動更新
create or replace function set_threads_posts_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_threads_posts_updated_at on threads_posts;
create trigger trg_threads_posts_updated_at
  before update on threads_posts
  for each row execute function set_threads_posts_updated_at();

-- RLS：只有 service role 能讀寫，前端/匿名不可碰
alter table threads_posts enable row level security;
