/**
 * vercel-adapter.js
 * ─────────────────────────────────────────────────────────────────
 * 讓 api/*.js(Vercel Serverless 寫法 handler(req, res))原封不動跑在
 * Cloudflare Pages Functions 上。
 *
 *   • Node 版(預設):組出 Vercel 風格的 req / res,等 handler 跑完後
 *     轉成標準 Response。支援本專案用到的:
 *       req.method / url / headers / query / body(JSON、表單自動解析)
 *       res.status / setHeader / getHeader / json / send / end / redirect / writeHead
 *   • Edge 版(config.runtime === 'edge',例如 tryon.js):本來就是
 *     handler(Request) → Response,直接呼叫。
 *
 * Cloudflare 的環境變數在 context.env;這裡同步寫進 process.env,
 * 讓既有的 process.env.XXX 寫法不用改。
 * ─────────────────────────────────────────────────────────────────
 */

function syncEnv(env) {
  if (!globalThis.process) globalThis.process = { env: {} };
  if (!globalThis.process.env) globalThis.process.env = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v === 'string') globalThis.process.env[k] = v;
  }
}

// Vercel 的 req.query:同名參數出現多次時是陣列
function toQuery(searchParams) {
  const q = {};
  for (const [k, v] of searchParams) {
    if (k in q) q[k] = [].concat(q[k], v);
    else q[k] = v;
  }
  return q;
}

// Vercel 預設的 body parser:JSON → 物件、表單 → 物件、其他 → 字串
async function parseBody(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const type = (request.headers.get('content-type') || '').toLowerCase();
  const text = await request.text();
  if (!text) return type.includes('application/json') ? {} : undefined;
  if (type.includes('application/json')) {
    try { return JSON.parse(text); } catch { return text; }
  }
  if (type.includes('application/x-www-form-urlencoded')) {
    return toQuery(new URLSearchParams(text));
  }
  return text;
}

export async function runVercelHandler(mod, request, env, ctx) {
  syncEnv(env);
  const handler = mod.default;

  if (mod.config && mod.config.runtime === 'edge') {
    return handler(request, ctx);
  }

  const url = new URL(request.url);
  const headers = {};
  request.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

  const req = {
    method: request.method,
    url: url.pathname + url.search,
    headers,
    query: toQuery(url.searchParams),
    body: await parseBody(request),
    cookies: Object.fromEntries((headers.cookie || '').split(';').filter(Boolean).map((c) => {
      const i = c.indexOf('=');
      return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
    })),
  };

  let status = 200;
  let body = null;
  let finished = false;
  const outHeaders = new Headers();
  let done;
  const sent = new Promise((r) => { done = r; });

  const finish = (payload) => {
    if (finished) return res;
    finished = true;
    res.headersSent = true;
    body = payload == null ? null : payload;
    done();
    return res;
  };

  const res = {
    headersSent: false,
    get statusCode() { return status; },
    set statusCode(v) { status = v; },
    status(code) { status = code; return res; },
    setHeader(k, v) { outHeaders.set(k, Array.isArray(v) ? v.join(', ') : String(v)); return res; },
    getHeader(k) { return outHeaders.get(k); },
    removeHeader(k) { outHeaders.delete(k); return res; },
    writeHead(code, hdrs) {
      status = code;
      for (const [k, v] of Object.entries(hdrs || {})) res.setHeader(k, v);
      return res;
    },
    json(obj) {
      if (!outHeaders.has('content-type')) outHeaders.set('content-type', 'application/json; charset=utf-8');
      return finish(JSON.stringify(obj));
    },
    send(payload) {
      if (payload !== null && typeof payload === 'object' && !(payload instanceof Uint8Array) && !(payload instanceof ArrayBuffer)) {
        return res.json(payload);
      }
      if (typeof payload === 'string' && !outHeaders.has('content-type')) {
        outHeaders.set('content-type', 'text/html; charset=utf-8');
      }
      return finish(payload);
    },
    end(payload) { return finish(payload); },
    redirect(a, b) {
      const [code, location] = typeof a === 'number' ? [a, b] : [307, a];
      status = code;
      outHeaders.set('location', location);
      return finish(null);
    },
  };

  // handler 可能在送出回應後還有收尾工作:兩者都等完,避免中途被結束
  const run = Promise.resolve().then(() => handler(req, res));
  try {
    await Promise.race([sent, run]);
    await run;
  } catch (err) {
    console.error('[vercel-adapter] handler error:', err && err.stack || err);
    if (!finished) {
      return new Response(JSON.stringify({ ok: false, error: 'internal_error' }), {
        status: 500, headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
  }
  if (!finished) finish(null);
  return new Response(status === 204 || status === 304 ? null : body, { status, headers: outHeaders });
}
