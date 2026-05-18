/**
 * auth.js — NEON LOTUS TW
 * ─────────────────────────────────────────────────────────────────
 * Supabase Auth wrapper + member loader.
 *
 * Exposes:
 *   window.AuthSystem.init()
 *   window.AuthSystem.getUser()          → Supabase auth.user object or null
 *   window.AuthSystem.getMember()        → cached members row or null
 *   window.AuthSystem.fetchMember()      → re-query and refresh cache
 *   window.AuthSystem.signInWithGoogle()
 *   window.AuthSystem.signInWithFacebook()
 *   window.AuthSystem.signInWithEmail(email)   // magic link
 *   window.AuthSystem.signInWithLine()         // (Phase 2.1b — stub for now)
 *   window.AuthSystem.signOut()
 *   window.AuthSystem.onAuthChange(cb)   → returns unsubscribe()
 *
 * 取消強迫登入 — 訪客結帳仍可正常使用購物車。
 * ─────────────────────────────────────────────────────────────────
 */
'use strict';

(function () {
  // ── Supabase client config (與 cart.js 同源) ─────────
  const SUPABASE_URL = 'https://epemuyojkprepknuzuzc.supabase.co';
  const SUPABASE_ANON_KEY = [
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVwZW11eW9qa3ByZXBrbnV6dXpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4MDMwMTAsImV4cCI6MjA5MTM3OTAxMH0',
    'nTv7W1_ndzzAQGNgVzSKSkruvsnEgt6N7PbnRK31l0M',
  ].join('.');

  // ── State ────────────────────────────────────────────
  let _supabase = null;
  let _user = null;       // Supabase auth user (or null)
  let _member = null;     // public.members row (or null)
  let _listeners = [];    // onAuthChange callbacks
  let _initPromise = null;

  function getClient() {
    if (_supabase) return _supabase;
    if (!window.supabase || !window.supabase.createClient) {
      console.warn('[AuthSystem] Supabase JS client not loaded yet');
      return null;
    }
    _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,    // 自動偵測 OAuth callback 後 #access_token=...
        flowType: 'pkce',            // 比 implicit 安全;Supabase v2 推薦
      },
    });
    return _supabase;
  }

  // ── Internal: notify all subscribers ────────────────
  function _emit() {
    const payload = { user: _user, member: _member };
    _listeners.forEach((fn) => {
      try { fn(payload); } catch (e) { console.warn('[AuthSystem] listener error:', e); }
    });
  }

  // ── Fetch members row for current user ──────────────
  async function fetchMember() {
    const sb = getClient();
    if (!sb || !_user) {
      _member = null;
      return null;
    }
    try {
      const { data, error } = await sb
        .from('members')
        .select('id, email, display_name, phone, birthday, accumulated_spend, tier, founding_member, founding_credit_balance, birthday_used_year')
        .eq('user_id', _user.id)
        .maybeSingle();
      if (error) {
        console.warn('[AuthSystem] fetchMember error:', error);
        _member = null;
      } else {
        _member = data || null;
      }
    } catch (e) {
      console.warn('[AuthSystem] fetchMember exception:', e);
      _member = null;
    }
    return _member;
  }

  // ── Init ────────────────────────────────────────────
  async function init() {
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
      const sb = getClient();
      if (!sb) return;

      // 取得目前 session (若已登入)
      try {
        const { data: { session } } = await sb.auth.getSession();
        _user = session ? session.user : null;
        if (_user) await fetchMember();
      } catch (e) {
        console.warn('[AuthSystem] getSession error:', e);
      }

      // 監聽未來 auth 狀態變化 (login/logout/refresh)
      sb.auth.onAuthStateChange(async (event, session) => {
        const wasLoggedIn = !!_user;
        _user = session ? session.user : null;

        if (_user) {
          // 第一次取得 user 後抓 member
          await fetchMember();
        } else {
          _member = null;
        }

        // 通知所有 subscriber
        _emit();

        // Console debug
        if (event === 'SIGNED_IN' && !wasLoggedIn) {
          console.log('[AuthSystem] SIGNED_IN:', _user?.email);
        } else if (event === 'SIGNED_OUT') {
          console.log('[AuthSystem] SIGNED_OUT');
        }
      });

      // 初始狀態也 emit 一次給已監聽的 UI
      _emit();
    })();
    return _initPromise;
  }

  // ── Public sign-in methods ──────────────────────────

  async function signInWithGoogle() {
    const sb = getClient();
    if (!sb) throw new Error('Supabase not loaded');
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
    if (error) throw error;
  }

  async function signInWithFacebook() {
    const sb = getClient();
    if (!sb) throw new Error('Supabase not loaded');
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'facebook',
      options: { redirectTo: window.location.origin },
    });
    if (error) throw error;
  }

  /* Magic-link email — 不需密碼,點連結即登入 */
  async function signInWithEmail(email) {
    const sb = getClient();
    if (!sb) throw new Error('Supabase not loaded');
    if (!email || !/^.+@.+\..+$/.test(email)) {
      throw new Error('請輸入有效的 Email');
    }
    const { error } = await sb.auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: window.location.origin,
        shouldCreateUser: true,
      },
    });
    if (error) throw error;
  }

  /* LINE Login — Phase 2.1b 才完成,目前 stub */
  async function signInWithLine() {
    // 將會 redirect 到 /api/auth-line-start 開始 OAuth flow
    // 目前是預留接口
    throw new Error('LINE 登入功能即將推出 (Phase 2.1b),請先用其他方式登入 🙏');
  }

  async function signOut() {
    const sb = getClient();
    if (!sb) return;
    const { error } = await sb.auth.signOut();
    if (error) console.warn('[AuthSystem] signOut error:', error);
    _user = null;
    _member = null;
    _emit();
  }

  // ── Subscription API ────────────────────────────────
  function onAuthChange(cb) {
    if (typeof cb !== 'function') return () => {};
    _listeners.push(cb);
    // 立即觸發一次,讓 UI 不用等下次變化
    try { cb({ user: _user, member: _member }); } catch (e) {}
    return () => {
      _listeners = _listeners.filter((fn) => fn !== cb);
    };
  }

  // ── Public API ──────────────────────────────────────
  window.AuthSystem = {
    init,
    getUser: () => _user,
    getMember: () => _member,
    fetchMember,
    signInWithGoogle,
    signInWithFacebook,
    signInWithEmail,
    signInWithLine,
    signOut,
    onAuthChange,
    // For debugging:
    _getClient: getClient,
  };

  // Auto-init when supabase-js is available
  function tryAutoInit() {
    if (window.supabase && window.supabase.createClient) {
      init();
    } else {
      // 還沒載到 supabase-js,等一會再試
      setTimeout(tryAutoInit, 100);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryAutoInit);
  } else {
    tryAutoInit();
  }
})();
