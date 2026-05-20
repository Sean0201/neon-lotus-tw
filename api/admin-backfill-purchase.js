/**
 * /api/admin-backfill-purchase.js — 後台補登歷史訂單
 *
 * 流程:
 *   1. 驗證呼叫者 JWT (Authorization: Bearer <token>)
 *   2. 確認 email 在 ADMIN_EMAILS 白名單
 *   3. 呼叫 RPC apply_historical_purchase
 *
 * Body:
 *   { member_id: uuid, amount: number, purchase_date: 'YYYY-MM-DD'?, note: string? }
 *
 * 環境變數:
 *   SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_KEY / SUPABASE_SERVICE_ROLE_KEY
 *   ADMIN_EMAILS — comma-separated admin email allowlist
 *                  (若未設定,fallback 到 nhkbee184@gmail.com)
 */

export const config = { runtime: 'nodejs', maxDuration: 15 };

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
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { url, key } = getSupabaseEnv();
    if (!url || !key) {
      console.error('[admin-backfill-purchase] Supabase env vars missing');
      return res.status(500).json({ error: 'server_misconfigured' });
    }

    // 1. 從 Authorization header 取 JWT
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: 'missing_token' });
    }

    const { createClient } = await import('@supabase/supabase-js');
    const supabaseAdmin = createClient(url, key, { auth: { persistSession: false } });

    // 2. 驗證 token + 取 user
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) {
      console.warn('[admin-backfill-purchase] invalid token:', userErr?.message);
      return res.status(401).json({ error: 'invalid_token' });
    }

    const callerEmail = String(userData.user.email || '').toLowerCase();
    const allowlist = getAdminAllowlist();
    if (!allowlist.has(callerEmail)) {
      console.warn('[admin-backfill-purchase] unauthorized caller:', callerEmail);
      return res.status(403).json({ error: 'not_admin', email: callerEmail });
    }

    // 3. 解析 body
    const { member_id, amount, purchase_date, note } = req.body || {};

    if (!member_id || typeof member_id !== 'string') {
      return res.status(400).json({ error: 'member_id required' });
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: 'amount must be > 0' });
    }
    if (amt > 10_000_000) {
      return res.status(400).json({ error: 'amount too large (max 10,000,000)' });
    }

    let purchaseDate = null;
    if (purchase_date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(purchase_date)) {
        return res.status(400).json({ error: 'purchase_date must be YYYY-MM-DD' });
      }
      purchaseDate = purchase_date;
    }

    const cleanNote = (note || '').trim().slice(0, 500) || null;

    // 4. 呼叫 RPC
    const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc('apply_historical_purchase', {
      p_member_id:      member_id,
      p_amount:         amt,
      p_purchase_date:  purchaseDate,
      p_note:           cleanNote,
      p_operator_email: callerEmail,
    });

    if (rpcErr) {
      console.error('[admin-backfill-purchase] RPC error:', rpcErr);
      return res.status(500).json({
        error: 'rpc_failed',
        message: rpcErr.message,
        details: rpcErr.details,
        hint: rpcErr.hint,
      });
    }

    console.log('[admin-backfill-purchase] success:', {
      operator: callerEmail, member_id, amount: amt, result: rpcResult,
    });

    return res.status(200).json({ ok: true, result: rpcResult });

  } catch (err) {
    console.error('[admin-backfill-purchase] Error:', err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
}
