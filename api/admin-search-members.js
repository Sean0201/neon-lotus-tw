/**
 * /api/admin-search-members.js — 後台會員搜尋 (給補登 UI 用)
 *
 * 為什麼需要這個 endpoint:
 *   members 表 RLS 是 "members_select_own" (auth.uid() = user_id),
 *   前端用 anon key 只能讀到自己那一筆,搜不到其他會員。
 *   admin 補登必須走後端用 service_role 才能跨會員查。
 *
 * 流程:
 *   1. 驗證 JWT (Authorization: Bearer <token>)
 *   2. 確認 email 在 ADMIN_EMAILS 白名單
 *   3. 用 service_role client ilike 查 members
 *
 * Query:
 *   GET /api/admin-search-members?q=<keyword>
 *
 * 回傳:
 *   { ok: true, members: [{ id, email, display_name, tier, accumulated_spend, purchase_count, founding_credit_balance }, ...] }
 *
 * 環境變數:
 *   SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_KEY / SUPABASE_SERVICE_ROLE_KEY
 *   ADMIN_EMAILS — comma-separated admin email allowlist
 *                  (若未設定,fallback 到 nhkbee184@gmail.com)
 */

export const config = { runtime: 'nodejs', maxDuration: 10 };

function getSupabaseEnv() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { url, key };
}

function getAdminAllowlist() {
  const raw = (process.env.ADMIN_EMAILS || 'nhkbee184@gmail.com').trim();
  return new Set(raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { url, key } = getSupabaseEnv();
    if (!url || !key) {
      console.error('[admin-search-members] Supabase env vars missing');
      return res.status(500).json({ error: 'server_misconfigured' });
    }

    // 1. JWT
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: 'missing_token' });
    }

    const { createClient } = await import('@supabase/supabase-js');
    const supabaseAdmin = createClient(url, key, { auth: { persistSession: false } });

    // 2. 驗證 token + admin email 白名單
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) {
      console.warn('[admin-search-members] invalid token:', userErr?.message);
      return res.status(401).json({ error: 'invalid_token' });
    }

    const callerEmail = String(userData.user.email || '').toLowerCase();
    const allowlist = getAdminAllowlist();
    if (!allowlist.has(callerEmail)) {
      console.warn('[admin-search-members] unauthorized caller:', callerEmail);
      return res.status(403).json({ error: 'not_admin', email: callerEmail });
    }

    // 3. 解析 query
    const rawQ = String(req.query?.q || '').trim();
    if (rawQ.length < 2) {
      return res.status(400).json({ error: 'q must be at least 2 chars' });
    }
    if (rawQ.length > 100) {
      return res.status(400).json({ error: 'q too long' });
    }

    // 4. 用 service_role 查 (繞過 RLS)
    //    ilike 在 email、display_name 兩個欄位都搜,方便用名字找
    const pattern = `%${rawQ.replace(/[%_]/g, c => '\\' + c)}%`;
    const { data, error } = await supabaseAdmin
      .from('members')
      .select('id, email, display_name, tier, accumulated_spend, purchase_count, founding_credit_balance')
      .or(`email.ilike.${pattern},display_name.ilike.${pattern}`)
      .order('email', { ascending: true })
      .limit(20);

    if (error) {
      console.error('[admin-search-members] DB error:', error);
      return res.status(500).json({ error: 'db_error', message: error.message });
    }

    return res.status(200).json({ ok: true, members: data || [] });

  } catch (err) {
    console.error('[admin-search-members] Error:', err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
}
