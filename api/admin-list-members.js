/**
 * /api/admin-list-members.js — 後台會員管理 — 列表查詢
 *
 * 為什麼需要這個 endpoint:
 *   members 表 RLS 是 "members_select_own" (auth.uid() = user_id),
 *   前端用 anon key 只能讀到自己那一筆。
 *   admin 列表必須走後端用 service_role 才能跨會員列出全部。
 *
 * 流程:
 *   1. 驗證 JWT (Authorization: Bearer <token>)
 *   2. 確認 email 在 ADMIN_EMAILS 白名單
 *   3. 用 service_role client 取 members 並 left join orders 拿最後消費時間
 *
 * Query:
 *   GET /api/admin-list-members?sort=accumulated_spend&order=desc
 *     &tier=black&q=ali&page=0&pageSize=50
 *
 *   sort     — accumulated_spend | created_at | purchase_count | display_name
 *              (default: accumulated_spend)
 *   order    — asc | desc (default: desc)
 *   tier     — bronze | silver | gold | diamond | black | (空 = 全部)
 *   q        — email/display_name 關鍵字 (>=2 字, ilike)
 *   page     — 0-based (default 0)
 *   pageSize — default 50, max 200
 *
 * 回傳:
 *   { ok: true,
 *     members: [{ id, email, display_name, phone, tier,
 *                 accumulated_spend, purchase_count, founding_credit_balance,
 *                 founding_member, birthday, created_at, last_order_at }, ...],
 *     total:    <整體筆數>,
 *     page:     0,
 *     pageSize: 50 }
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

const VALID_SORT_FIELDS = new Set([
  'accumulated_spend', 'created_at', 'purchase_count', 'display_name', 'email',
]);
const VALID_TIERS = new Set(['bronze', 'silver', 'gold', 'diamond', 'black']);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { url, key } = getSupabaseEnv();
    if (!url || !key) {
      console.error('[admin-list-members] Supabase env vars missing');
      return res.status(500).json({ error: 'server_misconfigured' });
    }

    // 1. JWT
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'missing_token' });

    const { createClient } = await import('@supabase/supabase-js');
    const supabaseAdmin = createClient(url, key, { auth: { persistSession: false } });

    // 2. 驗證 token + admin email 白名單
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) {
      console.warn('[admin-list-members] invalid token:', userErr?.message);
      return res.status(401).json({ error: 'invalid_token' });
    }

    const callerEmail = String(userData.user.email || '').toLowerCase();
    const allowlist = getAdminAllowlist();
    if (!allowlist.has(callerEmail)) {
      console.warn('[admin-list-members] unauthorized caller:', callerEmail);
      return res.status(403).json({ error: 'not_admin', email: callerEmail });
    }

    // 3. 解析 query
    const sort     = VALID_SORT_FIELDS.has(String(req.query?.sort || '')) ? String(req.query.sort) : 'accumulated_spend';
    const order    = String(req.query?.order || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
    const tier     = VALID_TIERS.has(String(req.query?.tier || '')) ? String(req.query.tier) : '';
    const rawQ     = String(req.query?.q || '').trim();
    const page     = Math.max(0, parseInt(req.query?.page || '0', 10) || 0);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query?.pageSize || '50', 10) || 50));

    // 4. 主 query (跨 RLS,因為 service_role)
    let q = supabaseAdmin
      .from('members')
      .select(
        'id, email, display_name, phone, tier, accumulated_spend, ' +
          'purchase_count, founding_credit_balance, founding_member, ' +
          'birthday, created_at',
        { count: 'exact' }
      );

    if (tier) {
      q = q.eq('tier', tier);
    }

    if (rawQ.length >= 2 && rawQ.length <= 100) {
      const pattern = `%${rawQ.replace(/[%_]/g, c => '\\' + c)}%`;
      q = q.or(`email.ilike.${pattern},display_name.ilike.${pattern}`);
    }

    q = q.order(sort, { ascending: order === 'asc', nullsFirst: false })
         .range(page * pageSize, (page + 1) * pageSize - 1);

    const { data: members, error: mErr, count } = await q;
    if (mErr) {
      console.error('[admin-list-members] DB error:', mErr);
      return res.status(500).json({ error: 'db_error', message: mErr.message });
    }

    // 5. 為這頁的會員撈最後一筆訂單時間 (一次 IN query 批次拿,N+1 規避)
    const memberIds = (members || []).map(m => m.id).filter(Boolean);
    let lastOrderMap = {};
    if (memberIds.length > 0) {
      const { data: lastRows, error: lErr } = await supabaseAdmin
        .from('orders')
        .select('member_id, created_at')
        .in('member_id', memberIds)
        .not('status', 'in', '(cancelled,rejected)')
        .order('created_at', { ascending: false });

      if (lErr) {
        console.warn('[admin-list-members] last_order_at query failed:', lErr.message);
      } else {
        // 取每個 member_id 最大的 created_at — 因為已 sort desc,first wins
        for (const row of (lastRows || [])) {
          if (row.member_id && !lastOrderMap[row.member_id]) {
            lastOrderMap[row.member_id] = row.created_at;
          }
        }
      }
    }

    const enriched = (members || []).map(m => ({
      ...m,
      last_order_at: lastOrderMap[m.id] || null,
    }));

    return res.status(200).json({
      ok: true,
      members: enriched,
      total: count || 0,
      page,
      pageSize,
    });

  } catch (err) {
    console.error('[admin-list-members] Error:', err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
}
