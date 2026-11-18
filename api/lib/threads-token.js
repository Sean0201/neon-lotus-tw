/**
 * Threads 長效存取權杖自動續期
 * ─────────────────────────────────────────────────────────────────
 * Threads 長效權杖 60 天有效,建立滿 24 小時後可用 th_refresh_token 換一把新的 60 天權杖。
 * 執行環境的變數(Cloudflare / Vercel)無法由程式改寫,所以續期後的權杖存在
 * Supabase integration_tokens(RLS 開啟、無 policy → 只有 service role 讀得到,migration 022)。
 *
 * 規則:
 *   • 平常用資料庫裡的權杖;超過 REFRESH_EVERY_MS 就續期一次
 *   • 環境變數 THREADS_USER_ACCESS_TOKEN 被手動換掉(雜湊不同)→ 改用新的那把並重新記錄
 *   • 資料表不存在或讀取失敗 → 直接用環境變數(與舊行為相同)
 */
import crypto from 'crypto';

const KEY = 'threads';
const REFRESH_EVERY_MS = 7 * 24 * 60 * 60 * 1000;   // 每 7 天續期一次
const WARN_BEFORE_MS   = 10 * 24 * 60 * 60 * 1000;  // 續期失敗且剩不到 10 天就提醒

const hashOf = (token) => crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16);

async function refreshToken(token) {
  const url = 'https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token='
    + encodeURIComponent(token);
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(json.error?.message || `refresh failed (HTTP ${res.status})`);
  }
  return {
    token: json.access_token,
    expiresAt: new Date(Date.now() + (Number(json.expires_in) || 60 * 24 * 3600) * 1000).toISOString(),
  };
}

/**
 * @param supabase  service role client
 * @param envToken  process.env.THREADS_USER_ACCESS_TOKEN
 * @param warn      (message) => Promise — 續期失敗快到期時的通知(例如 Telegram)
 * @returns 目前可用的權杖
 */
export async function getThreadsToken(supabase, envToken, warn) {
  const envHash = hashOf(envToken);
  const { data: row, error } = await supabase
    .from('integration_tokens')
    .select('token, env_hash, expires_at, refreshed_at')
    .eq('key', KEY)
    .maybeSingle();
  if (error) {
    console.warn('[threads-token] 讀取 integration_tokens 失敗,改用環境變數:', error.message);
    return envToken;
  }

  // 第一次使用,或環境變數被手動換成新權杖 → 以環境變數為準
  if (!row || row.env_hash !== envHash) {
    const { error: upErr } = await supabase.from('integration_tokens').upsert({
      key: KEY, token: envToken, env_hash: envHash, expires_at: null, refreshed_at: new Date().toISOString(),
    });
    if (upErr) console.warn('[threads-token] 記錄權杖失敗:', upErr.message);
    return envToken;
  }

  if (Date.now() - new Date(row.refreshed_at).getTime() < REFRESH_EVERY_MS) return row.token;

  try {
    const next = await refreshToken(row.token);
    const { error: upErr } = await supabase.from('integration_tokens').update({
      token: next.token, expires_at: next.expiresAt, refreshed_at: new Date().toISOString(),
    }).eq('key', KEY);
    if (upErr) throw new Error('save failed: ' + upErr.message);
    console.log('[threads-token] 已自動續期,新到期日', next.expiresAt.slice(0, 10));
    return next.token;
  } catch (err) {
    console.error('[threads-token] 自動續期失敗:', err.message);
    const exp = row.expires_at ? new Date(row.expires_at).getTime() : null;
    if (warn && exp && exp - Date.now() < WARN_BEFORE_MS) {
      await warn(`⚠️ Threads 權杖自動續期失敗,將於 ${row.expires_at.slice(0, 10)} 到期\n${err.message}\n請到 Meta 後台重新產生並更新 THREADS_USER_ACCESS_TOKEN`);
    }
    return row.token;
  }
}
