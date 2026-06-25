/**
 * /api/admin-member-detail.js — 後台會員詳細頁
 *
 * 一次回傳會員的完整資料,讓詳細 modal 不用多次往返:
 *   - 會員主檔
 *   - 最近 30 筆訂單
 *   - audit log 全部 (累積消費 / 折抵金 / 等級 / 消費次數)
 *
 * 流程:
 *   1. 驗證 JWT (Authorization: Bearer <token>)
 *   2. 確認 email 在 ADMIN_EMAILS 白名單
 *   3. 用 service_role client 跨 RLS 取資料
 *
 * Query:
 *   GET /api/admin-member-detail?id=<member_id>
 *
 * 回傳:
 *   { ok: true,
 *     member: { id, email, display_name, phone, birthday, tier,
 *               accumulated_spend, purchase_count, founding_credit_balance,
 *               founding_member, birthday_used_year, created_at, updated_at },
 *     orders: [{ order_number, created_at, status, subtotal, total,
 *                tier_at_purchase, tier_discount, birthday_discount,
 *                signup_credit_used, refund_amount, payment_method, note }, ...],
 *     audit_log: [{ id, delta, field, reason, ref_order_number,
 *                   operator_email, created_at }, ...] }
 *
 * 環境變數:
 *   SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_KEY / SUPABASE_SERVICE_ROLE_KEY
 *   ADMIN_EMAILS — comma-separated admin email allowlist
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

// UUID 簡單驗證 (8-4-4-4-12 hex)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { url, key } = getSupabaseEnv();
    if (!url || !key) {
      console.error('[admin-member-detail] Supabase env vars missing');
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
      console.warn('[admin-member-detail] invalid token:', userErr?.message);
      return res.status(401).json({ error: 'invalid_token' });
    }

    const callerEmail = String(userData.user.email || '').toLowerCase();
    const allowlist = getAdminAllowlist();
    if (!allowlist.has(callerEmail)) {
      console.warn('[admin-member-detail] unauthorized caller:', callerEmail);
      return res.status(403).json({ error: 'not_admin', email: callerEmail });
    }

    // 3. 解析 query
    const id = String(req.query?.id || '').trim();
    if (!UUID_RE.test(id)) {
      return res.status(400).json({ error: 'invalid_id', message: 'id must be a valid UUID' });
    }

    // 4. 三個 query 並行 (Promise.all 加速)
    const [memberRes, ordersRes, auditRes] = await Promise.all([
      supabaseAdmin
        .from('members')
        .select('id, email, display_name, phone, birthday, tier, ' +
                'accumulated_spend, purchase_count, founding_credit_balance, ' +
                'founding_member, birthday_used_year, created_at, updated_at')
        .eq('id', id)
        .maybeSingle(),

      supabaseAdmin
        .from('orders')
        .select('order_number, created_at, status, subtotal, total, ' +
                'tier_at_purchase, tier_discount, birthday_discount, ' +
                'signup_credit_used, refund_amount, payment_method, note')
        .eq('member_id', id)
        .order('created_at', { ascending: false })
        .limit(30),

      supabaseAdmin
        .from('member_audit_log')
        .select('id, delta, field, reason, ref_order_number, operator_email, created_at')
        .eq('member_id', id)
        .order('created_at', { ascending: false })
        .limit(200),
    ]);

    if (memberRes.error) {
      console.error('[admin-member-detail] member query error:', memberRes.error);
      return res.status(500).json({ error: 'db_error', message: memberRes.error.message });
    }
    if (!memberRes.data) {
      return res.status(404).json({ error: 'not_found' });
    }
    if (ordersRes.error) {
      console.warn('[admin-member-detail] orders query failed:', ordersRes.error.message);
    }
    if (auditRes.error) {
      console.warn('[admin-member-detail] audit query failed:', auditRes.error.message);
    }

    return res.status(200).json({
      ok: true,
      member: memberRes.data,
      orders: ordersRes.data || [],
      audit_log: auditRes.data || [],
    });

  } catch (err) {
    console.error('[admin-member-detail] Error:', err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
}
