/**
 * api/rebuild-snapshot.js
 * ─────────────────────────────────────────────────────────────
 * Admin-only endpoint that triggers a Vercel rebuild, which in
 * turn re-runs `scripts/dump-snapshot.js` and refreshes the
 * static JSON snapshot served from Vercel Edge.
 *
 * Auth: Supabase JWT (Authorization: Bearer <access_token>)
 *       + email must be in ADMIN_EMAILS allowlist.
 *
 * Rate limit: 60 seconds between successful triggers (per Vercel
 *             function instance — best-effort, mostly for click spam).
 *
 * Usage from admin.html:
 *   const { data: { session } } = await sb.auth.getSession();
 *   fetch('/api/rebuild-snapshot', {
 *     method: 'POST',
 *     headers: {
 *       'Authorization': `Bearer ${session.access_token}`,
 *       'content-type': 'application/json',
 *     },
 *   })
 *
 * Env vars required:
 *   VERCEL_DEPLOY_HOOK_URL                      Deploy Hook URL from Vercel
 *   SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)  Supabase project URL
 *   SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY)
 *   ADMIN_EMAILS                                comma-separated admin email allowlist
 *                                               (fallback: nhkbee184@gmail.com)
 */

export const config = { runtime: 'nodejs', maxDuration: 10 };

// In-memory rate limit — best-effort, shared per warm function instance.
// Not a hard guarantee across all instances but stops obvious click spam.
const RATE_LIMIT_MS = 60 * 1000;
let _lastTriggeredAt = 0;

function getAdminAllowlist() {
  const raw = (process.env.ADMIN_EMAILS || 'nhkbee184@gmail.com').trim();
  return new Set(raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

function getSupabaseEnv() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { url, key };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const HOOK = process.env.VERCEL_DEPLOY_HOOK_URL;
  const { url: SB_URL, key: SB_KEY } = getSupabaseEnv();

  if (!HOOK || !SB_URL || !SB_KEY) {
    return res.status(500).json({
      ok: false,
      error: 'server_misconfigured',
      detail: 'Missing VERCEL_DEPLOY_HOOK_URL / Supabase URL / Service Role Key',
    });
  }

  // 1. Extract Bearer token
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ ok: false, error: 'missing_token' });
  }

  // 2. Validate JWT + admin allowlist (using service_role client)
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const supabaseAdmin = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) {
      console.warn('[rebuild-snapshot] invalid token:', userErr?.message);
      return res.status(401).json({ ok: false, error: 'invalid_token' });
    }

    const callerEmail = String(userData.user.email || '').toLowerCase();
    const allowlist = getAdminAllowlist();
    if (!allowlist.has(callerEmail)) {
      console.warn('[rebuild-snapshot] unauthorized caller:', callerEmail);
      return res.status(403).json({ ok: false, error: 'not_admin', email: callerEmail });
    }

    // 3. Rate limit (60s between successful triggers, per warm instance)
    const now = Date.now();
    const since = now - _lastTriggeredAt;
    if (since < RATE_LIMIT_MS) {
      const retryAfter = Math.ceil((RATE_LIMIT_MS - since) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        ok: false,
        error: 'rate_limited',
        detail: `Please wait ${retryAfter}s before triggering another rebuild.`,
        retry_after_seconds: retryAfter,
      });
    }

    // 4. Forward to Vercel Deploy Hook
    const r = await fetch(HOOK, { method: 'POST' });
    const text = await r.text();
    let hookJson = null;
    try { hookJson = JSON.parse(text); } catch (_) { /* Deploy Hook returns JSON but be defensive */ }

    if (!r.ok) {
      return res.status(502).json({
        ok: false,
        error: 'deploy_hook_failed',
        status: r.status,
        body: hookJson || text.slice(0, 500),
      });
    }

    _lastTriggeredAt = now;

    console.log('[rebuild-snapshot] triggered by:', callerEmail, 'job:', hookJson?.job?.id || 'unknown');

    return res.status(200).json({
      ok: true,
      triggered_at: new Date().toISOString(),
      triggered_by: callerEmail,
      job: hookJson || null,
      note: 'Rebuild queued. New snapshot will be live in ~1-3 minutes.',
    });
  } catch (err) {
    console.error('[rebuild-snapshot] error:', err);
    return res.status(500).json({
      ok: false,
      error: 'internal_error',
      detail: err?.message || String(err),
    });
  }
}
