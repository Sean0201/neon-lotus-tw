/**
 * worker/index.js — Cloudflare Workers 入口
 * ─────────────────────────────────────────────────────────────────
 *   /api/<name>  → api/<name>.js(Vercel 寫法,經 vercel-adapter 轉接,程式不用改)
 *   其他網址      → 靜態網站(dist/,wrangler.toml 的 assets;找不到的頁面回 index.html)
 *   排程          → Threads 定時發文(取代 vercel.json 的 crons)
 *
 * 排程開關:環境變數 ENABLE_CRON=1 才會真的呼叫發文,
 * 切換網域前 Vercel 的排程還在跑,先不要開,避免重複發文。
 * ─────────────────────────────────────────────────────────────────
 */
import { runVercelHandler } from './vercel-adapter.js';
import { ROUTES } from './routes.js';

const json = (obj, status) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/([a-z0-9-]+)\/?$/);
    if (m) {
      const mod = ROUTES[m[1]];
      if (!mod) return json({ ok: false, error: 'not_found' }, 404);
      return runVercelHandler(mod, request, env, ctx);
    }
    if (url.pathname.startsWith('/api/')) return json({ ok: false, error: 'not_found' }, 404);
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    if (env.ENABLE_CRON !== '1') {
      console.log('[cron] ENABLE_CRON 未開啟,略過', event.cron);
      return;
    }
    const req = new Request('https://internal/api/threads-publish-due', {
      headers: env.CRON_SECRET ? { authorization: `Bearer ${env.CRON_SECRET}` } : {},
    });
    const res = await runVercelHandler(ROUTES['threads-publish-due'], req, env, ctx);
    console.log('[cron] threads-publish-due', res.status, (await res.text()).slice(0, 500));
  },
};
