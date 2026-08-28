create table if not exists threads_brand_voice (
  key text primary key,
  content text not null,
  updated_at timestamptz not null default now()
);

alter table threads_brand_voice enable row level security;
