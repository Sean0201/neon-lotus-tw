-- 支援多圖/影片（Threads CAROUSEL）：
-- media_items 存一個 jsonb 陣列，每筆是 {"type":"IMAGE"|"VIDEO","url":"..."}，依加入順序發文。
-- 舊有的 media_type / media_url（單張）欄位保留不動，作為只有一筆媒體時的相容 fallback。
alter table threads_posts add column if not exists media_items jsonb not null default '[]'::jsonb;

-- 原子附加一筆媒體到 media_items，避免 Telegram 相簿的多則訊息同時處理時互相蓋掉。
create or replace function threads_append_media_item(p_id uuid, p_item jsonb)
returns jsonb as $$
declare
  result jsonb;
begin
  update threads_posts
  set media_items = coalesce(media_items, '[]'::jsonb) || jsonb_build_array(p_item)
  where id = p_id
  returning media_items into result;
  return result;
end;
$$ language plpgsql;
