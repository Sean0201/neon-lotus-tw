/**
 * api/rebuild-snapshot.js
 * ─────────────────────────────────────────────────────────────
 * Admin-only endpoint that triggers a Vercel rebuild, which in
 * turn re-runs `scripts/dump-snapshot.js` and refreshes the
 * static JSON snapshot served from Vercel Edge.
 *
 * Usage from admin.html:
 *   fetch('/api/rebuild-snapshot', {
 *     method: 'POST',
 *     headers: { 'x-admin-token': ADMIN_REBUILD_TOKEN, 'content-type': 'application/json' },
 *   })
 *
 * Requires two env vars on Vercel:
 *   VERCEL_DEPLOY_HOOK_URL   the Deploy Hook URL from Project Settings → Git
 *   ADMIN_REBUILD_TOKEN      shared secret to gate access
 */

export default async function handler(req, res) {
  // CORS: same-origin only in practice — admin.html is on same domain.
  // Reject anything but POST.
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const HOOK  = process.env.VERCEL_DEPLOY_HOOK_URL;
  const TOKEN = process.env.ADMIN_REBUILD_TOKEN;

  if (!HOOK || !TOKEN) {
    return res.status(500).json({
      ok: false,
      error: 'server_misconfigured',
      detail: 'VERCEL_DEPLOY_HOOK_URL or ADMIN_REBUILD_TOKEN missing on server',
    });
  }

  // Token check — header OR body (admin.html sends header)
  const provided =
    req.headers['x-admin-token'] ||
    (req.body && (req.body.token || req.body.admin_token));

  if (!provided || provided !== TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  // Forward to Vercel Deploy Hook
  try {
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

    return res.status(200).json({
      ok: true,
      triggered_at: new Date().toISOString(),
      job: hookJson || null,
      note: 'Rebuild queued. New snapshot will be live in ~1-3 minutes.',
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: 'fetch_failed',
      detail: err?.message || String(err),
    });
  }
}
