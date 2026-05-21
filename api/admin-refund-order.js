/**
 * /api/admin-refund-order.js — 後台訂單退款 (帳本端 only)
 *
 * 流程:
 *   1. 驗證呼叫者 JWT
 *   2. 確認 email 在 ADMIN_EMAILS 白名單
 *   3. 呼叫 RPC apply_order_refund
 *
 * Body:
 *   { order_id: uuid, refund_amount: number, full_refund?: boolean, note?: string }
 *
 * 注意:本 endpoint 只處理會員帳本 + 訂單狀態。
 * 實際金流退款必須在 NewebPay 後台手動執行。
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
      console.error('[admin-refund-order] Supabase env vars missing');
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
      console.warn('[admin-refund-order] invalid token:', userErr?.message);
      return res.status(401).json({ error: 'invalid_token' });
    }

    const callerEmail = String(userData.user.email || '').toLowerCase();
    const allowlist = getAdminAllowlist();
    if (!allowlist.has(callerEmail)) {
      console.warn('[admin-refund-order] unauthorized caller:', callerEmail);
      return res.status(403).json({ error: 'not_admin', email: callerEmail });
    }

    // 3. body 解析
    const { order_id, refund_amount, full_refund, note } = req.body || {};

    if (!order_id || typeof order_id !== 'string') {
      return res.status(400).json({ error: 'order_id required' });
    }
    const amt = Number(refund_amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: 'refund_amount must be > 0' });
    }
    if (amt > 10_000_000) {
      return res.status(400).json({ error: 'refund_amount too large (max 10,000,000)' });
    }

    const cleanNote = (note || '').trim().slice(0, 500) || null;
    const isFull = Boolean(full_refund);

    // 4. 呼叫 RPC
    const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc('apply_order_refund', {
      p_order_id:       order_id,
      p_refund_amount:  amt,
      p_full_refund:    isFull,
      p_note:           cleanNote,
      p_operator_email: callerEmail,
    });

    if (rpcErr) {
      console.error('[admin-refund-order] RPC error:', rpcErr);
      return res.status(500).json({
        error: 'rpc_failed',
        message: rpcErr.message,
        details: rpcErr.details,
        hint: rpcErr.hint,
      });
    }

    console.log('[admin-refund-order] success:', {
      operator: callerEmail, order_id, amount: amt, full: isFull, result: rpcResult,
    });

    return res.status(200).json({ ok: true, result: rpcResult });

  } catch (err) {
    console.error('[admin-refund-order] Error:', err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
}
