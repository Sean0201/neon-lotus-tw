-- ═══════════════════════════════════════════════════════════════
-- 023_product_free_shipping.sql — 免運商品
-- ───────────────────────────────────────────────────────────────
-- 後台勾選「🚚 免運商品」的商品,只要在購物車裡,整筆訂單免運
-- (cart.js 結帳頁顯示 + newebpay-create 運費下限檢查)。
--
-- 執行:Supabase → SQL Editor → 貼上整份 → Run。可重複執行。
-- 必須先執行,再部署程式(快照會讀這個欄位)。
-- ═══════════════════════════════════════════════════════════════

alter table public.products
  add column if not exists free_shipping boolean not null default false;
