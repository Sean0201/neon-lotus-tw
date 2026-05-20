/**
 * /api/newebpay-notify.js — Vercel Serverless Function (Node.js)
 * 接收藍新金流 Server-to-Server 付款結果通知 (NotifyURL)
 *
 * 藍新 POST 過來的 body:
 *   {
 *     Status:    "SUCCESS" | "...",
 *     MerchantID: "...",
 *     TradeInfo:  "...",   // AES 加密的結果 JSON
 *     TradeSha:   "...",   // 驗證用 SHA256
 *     Version:    "2.0"
 *   }
 *
 * 解密後 TradeInfo 是 JSON:
 *   { Status, Message, Result: { MerchantOrderNo, TradeNo, Amt, PaymentType,
 *                                PayTime, RespondCode, ... } }
 *
 * Phase 2.2 — 付款成功後的會員副作用 (此 endpoint 是唯一 trusted side):
 *   1. orders.status = 'paid' (或 'failed' 若失敗)
 *   2. 若有 member_id:
 *      - members.accumulated_spend += (order.total - order.shipping_fee)
 *      - members.purchase_count    += 1
 *      - tier upgrade — 用 lib/discount.computeTierFromSpend 重算,若變更則寫入
 *      - founding_credit_balance   -= order.signup_credit_used (若 > 0)
 *      - birthday_used_year         = (今年)   (若 order.birthday_discount > 0)
 *   3. 每個變動都寫一筆 member_audit_log (idempotent — 若 order 已 paid 就跳過)
 *
 * 冪等性 (idempotency):
 *   - 用 orders.status 當「已處理」旗標。藍新可能重送通知,但我們只在 status
 *     從 'pending' 改成 'paid' 的那一次才會跑會員副作用。
 *
 * 環境變數:
 *   NEWEBPAY_HASH_KEY, NEWEBPAY_HASH_IV — 解密用
 *   SUPABASE_URL (或 NEXT_PUBLIC_SUPABASE_URL)        — Supabase project URL
 *   SUPABASE_SERVICE_KEY (或 SUPABASE_SERVICE_ROLE_KEY) — service role
 *     (寫 orders / members / audit_log,需 service role 才能 bypass RLS)
 */

import crypto from 'crypto';
import D from './lib/discount.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

/* ── AES-256-CBC 解密 ───────────────────────────
 * NewebPay 文件雖然講 PKCS#7,但實務上有些商店帳號回傳的 TradeInfo 是
 * zero-padding。setAutoPadding(true) 對 zero-padding 會在 final() 噴
 * "bad decrypt" (1C800064)。所以先試 PKCS#7,失敗 fallback 到 manual
 * zero-padding strip。
 */
function aesDecrypt(encryptedHex, key, iv) {
  // 嘗試 1: PKCS#7 padding (官方文件規格)
  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    decipher.setAutoPadding(true);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err1) {
    // 嘗試 2: 關掉 auto-padding,自己 strip null bytes / 控制字元
    try {
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      decipher.setAutoPadding(false);
      const buf = Buffer.concat([
        decipher.update(Buffer.from(encryptedHex, 'hex')),
        decipher.final(),
      ]);
      // 去尾端 null bytes + ASCII 控制字元 (zero-padding / pkcs#7 padding bytes)
      let endIdx = buf.length;
      while (endIdx > 0 && buf[endIdx - 1] < 0x20) endIdx--;
      const decrypted = buf.slice(0, endIdx).toString('utf8');
      console.warn('[NewebPay Notify] AES decrypt: PKCS#7 failed, recovered with zero-padding strip');
      return decrypted;
    } catch (err2) {
      // 兩種都失敗 — 重 throw 原本的錯,並補充 key/iv 長度資訊方便診斷
      const e = new Error(
        `${err1.message} (key_len=${key && key.length}, iv_len=${iv && iv.length}, ciphertext_hex_len=${encryptedHex && encryptedHex.length}, fallback_err=${err2.message})`
      );
      e.code = err1.code;
      e.stack = err1.stack;
      throw e;
    }
  }
}

/* ── 重新計算 TradeSha 比對 ──────────────────── */
function verifyTradeSha(tradeInfo, receivedSha, key, iv) {
  const raw = `HashKey=${key}&${tradeInfo}&HashIV=${iv}`;
  const computed = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
  return computed === String(receivedSha || '').toUpperCase();
}

/* ── Order number 還原 ─────────────────────────
 * cart.js 寫進 DB 的 order_number 有 dash (`NLC-20260520-6724`),
 * 但藍新限制 MerchantOrderNo 1-20 碼英數+底線,所以 newebpay-create.js 用
 * sanitizeOrderNo() 把 dash 拿掉送過去。藍新 notify 回傳的也是 dashless。
 * 這個 helper 把 dashless 還原成 dashed,讓 notify 可以找到原訂單。
 *
 *   NLC202605206724 → NLC-20260520-6724  (carryback)
 *   NL202605206724  → NL-20260520-6724   (shipping)
 */
function reconstructDashedOrderNo(dashless) {
  if (!dashless) return null;
  let m = dashless.match(/^(NLC)(\d{8})(\w{4})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = dashless.match(/^(NL)(\d{8})(\w{4})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

/**
 * Phase 2.2 — 付款成功時對會員的副作用 (server-only,trusted)
 *
 *   1. 累積消費 += 商品實付金額 (= order.total - order.shipping_fee)
 *   2. purchase_count += 1
 *   3. tier upgrade — 用 computeTierFromSpend 重算
 *   4. founding_credit_balance -= order.signup_credit_used
 *   5. birthday_used_year = (今年)   (若 order.birthday_discount > 0)
 *   6. 每個變動寫一筆 member_audit_log
 *
 * 所有寫入都用 service_role,所以 trg_protect_member_fields 不會擋。
 * 任何一個子步驟失敗都會 log 但不丟,讓其他副作用照跑 — 最終
 * order.status='paid' 會被 set,確保不重複處理。
 */
async function applyMemberSideEffects(supabase, order, orderNo) {
  // 1. 撈會員當下狀態
  const { data: member, error: memberErr } = await supabase
    .from('members')
    .select('id, email, tier, accumulated_spend, purchase_count, founding_credit_balance, birthday, birthday_used_year')
    .eq('id', order.member_id)
    .maybeSingle();

  if (memberErr || !member) {
    console.error('[NewebPay Notify] member lookup failed:', { member_id: order.member_id, memberErr });
    return;
  }

  // 2. 確保 D._config 是最新 site_config 版本 (best-effort)
  try {
    await D.loadConfig(supabase);
  } catch (_) { /* fallback to defaults */ }

  /* ── 計算所有變動 ── */
  const merchandisePaid = Math.max(0, (Number(order.total) || 0) - (Number(order.shipping_fee) || 0));
  const newSpend        = (Number(member.accumulated_spend) || 0) + merchandisePaid;
  const newCount        = (Number(member.purchase_count) || 0) + 1;
  const newTier         = D.computeTierFromSpend(newSpend);
  const tierChanged     = newTier !== member.tier;

  const creditUsed   = Math.max(0, Number(order.signup_credit_used) || 0);
  const newBalance   = Math.max(0, (Number(member.founding_credit_balance) || 0) - creditUsed);

  const birthdayUsed = (Number(order.birthday_discount) || 0) > 0;
  const todayYear    = new Date().getFullYear();

  /* ── 一次性 UPDATE members (一個 transaction) ── */
  const memberPatch = {
    accumulated_spend:       newSpend,
    purchase_count:          newCount,
    tier:                    newTier,
    founding_credit_balance: newBalance,
  };
  if (birthdayUsed) memberPatch.birthday_used_year = todayYear;

  const { error: updErr } = await supabase
    .from('members')
    .update(memberPatch)
    .eq('id', member.id);

  if (updErr) {
    console.error('[NewebPay Notify] member update failed:', { member_id: member.id, updErr, memberPatch });
    return; // 別寫 audit 進去
  }

  console.log('[NewebPay Notify] member updated:', {
    member_id:     member.id,
    order_number:  orderNo,
    delta_spend:   merchandisePaid,
    new_spend:     newSpend,
    purchase_count: newCount,
    tier_before:   member.tier,
    tier_after:    newTier,
    credit_used:   creditUsed,
    new_balance:   newBalance,
    birthday_used: birthdayUsed,
  });

  /* ── 寫 audit_log entries (一筆 row 一個欄位變動) ── */
  const auditRows = [];

  // 累積消費
  auditRows.push({
    member_id:        member.id,
    delta:            merchandisePaid,
    field:            'accumulated_spend',
    reason:           '訂單付款成功',
    ref_order_number: orderNo,
    operator_email:   'system',
  });

  // 消費次數
  auditRows.push({
    member_id:        member.id,
    delta:            1,
    field:            'purchase_count',
    reason:           '訂單付款成功',
    ref_order_number: orderNo,
    operator_email:   'system',
  });

  // 等級升降 (只在改變時記)
  if (tierChanged) {
    auditRows.push({
      member_id:        member.id,
      delta:            0,             // tier 是 text,delta 沒語意,記 0
      field:            'tier',
      reason:           `等級變更 ${member.tier} → ${newTier} (累積消費 ${newSpend})`,
      ref_order_number: orderNo,
      operator_email:   'system',
    });
  }

  // 折抵金使用
  if (creditUsed > 0) {
    auditRows.push({
      member_id:        member.id,
      delta:            -creditUsed,
      field:            'founding_credit_balance',
      reason:           '註冊禮金使用',
      ref_order_number: orderNo,
      operator_email:   'system',
    });
  }

  const { error: auditErr } = await supabase
    .from('member_audit_log')
    .insert(auditRows);

  if (auditErr) {
    console.error('[NewebPay Notify] audit log insert failed:', { auditErr, auditRows });
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  try {
    /* trim — 防 Vercel env var 帶空白導致 SHA 驗證失敗 */
    const HASH_KEY = (process.env.NEWEBPAY_HASH_KEY || '').trim();
    const HASH_IV  = (process.env.NEWEBPAY_HASH_IV  || '').trim();

    const { Status, MerchantID, TradeInfo, TradeSha, Version } = req.body || {};

    console.log('[NewebPay Notify] Received:', JSON.stringify({
      Status, MerchantID, Version, hasTradeInfo: !!TradeInfo,
      // 診斷用 (不洩漏 secret) — 確認 env var 長度是否為 AES-256-CBC 要求的 32/16
      keyLen: HASH_KEY.length,
      ivLen:  HASH_IV.length,
      tradeInfoLen: TradeInfo ? TradeInfo.length : 0,
      tradeInfoHexValid: TradeInfo ? /^[0-9a-fA-F]+$/.test(TradeInfo) : false,
    }));

    if (!TradeInfo || !TradeSha) {
      console.error('[NewebPay Notify] Missing TradeInfo / TradeSha');
      return res.status(400).send('Missing fields');
    }

    // 1. 驗證簽名
    if (!verifyTradeSha(TradeInfo, TradeSha, HASH_KEY, HASH_IV)) {
      console.error('[NewebPay Notify] TradeSha verification FAILED');
      return res.status(400).send('TradeSha Error');
    }

    // 2. 解密 TradeInfo
    const decryptedJson = aesDecrypt(TradeInfo, HASH_KEY, HASH_IV);
    let payload;
    try {
      payload = JSON.parse(decryptedJson);
    } catch (e) {
      console.error('[NewebPay Notify] TradeInfo JSON parse error:', e.message, decryptedJson);
      return res.status(400).send('Invalid TradeInfo');
    }

    const result = payload.Result || {};
    const isPaid = String(payload.Status) === 'SUCCESS' && String(result.RespondCode || '00') === '00';

    console.log('[NewebPay Notify] Decoded:', {
      payloadStatus:   payload.Status,
      respondCode:     result.RespondCode,
      merchantOrderNo: result.MerchantOrderNo,
      tradeNo:         result.TradeNo,
      paymentType:     result.PaymentType,
      amt:             result.Amt,
      payTime:         result.PayTime,
      isPaid,
    });

    // 3. 更新 Supabase 訂單狀態 + 會員副作用 (Phase 2.2)
    const _sbUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const _sbKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!_sbUrl || !_sbKey) {
      console.warn('[NewebPay Notify] Supabase env vars missing — skipping order/member updates');
      return res.status(200).send('OK');
    }

    try {
      const { createClient } = await import('@supabase/supabase-js');
      const supabase = createClient(
        _sbUrl,
        _sbKey,
        { auth: { persistSession: false } }
      );

      const orderNo = result.MerchantOrderNo;

      /* ── 撈訂單 (用 order_number,Phase 2.2 訂單 schema)
       * 先試 dashless (藍新原樣),沒中再試還原成 dashed (cart.js DB 格式)
       */
      const ORDER_COLS = 'id, order_number, status, member_id, subtotal, shipping_fee, total, tier_at_purchase, tier_discount, birthday_discount, signup_credit_used';
      let order = null;
      let orderErr = null;
      {
        const r1 = await supabase.from('orders').select(ORDER_COLS).eq('order_number', orderNo).maybeSingle();
        if (r1.error) orderErr = r1.error;
        else order = r1.data;
      }
      if (!order && !orderErr) {
        const dashed = reconstructDashedOrderNo(orderNo);
        if (dashed) {
          const r2 = await supabase.from('orders').select(ORDER_COLS).eq('order_number', dashed).maybeSingle();
          if (r2.error) orderErr = r2.error;
          else if (r2.data) {
            order = r2.data;
            console.log('[NewebPay Notify] resolved order via dashed fallback:', orderNo, '→', dashed);
          }
        }
      }

      if (orderErr) {
        console.error('[NewebPay Notify] order lookup error:', orderErr);
        return res.status(200).send('OK'); // 別讓藍新一直重送
      }
      if (!order) {
        console.warn('[NewebPay Notify] order not found:', orderNo);
        return res.status(200).send('OK');
      }

      /* ── Idempotency: 若 order 已 paid,跳過會員副作用 ── */
      if (order.status === 'paid' || order.status === 'failed') {
        console.log('[NewebPay Notify] order already finalised, skipping:', {
          order_number: orderNo, status: order.status,
        });
        return res.status(200).send('OK');
      }

      if (!isPaid) {
        /* ── 失敗:只更新 status,不動會員 ── */
        const { error: failErr } = await supabase
          .from('orders')
          .update({
            status: 'failed',
            note: `[NewebPay] ${payload.Message || ('RespondCode=' + (result.RespondCode || 'unknown'))}`,
          })
          .eq('id', order.id);
        if (failErr) console.error('[NewebPay Notify] order failed update error:', failErr);
        return res.status(200).send('OK');
      }

      /* ── 成功:先跑會員副作用,最後再 mark paid ──
       * 用 DB 裡的 order.order_number (有 dash) 寫進 audit log,
       * 讓客服 / 對帳人員看到的訂單號跟其他地方一致。
       */
      if (order.member_id) {
        await applyMemberSideEffects(supabase, order, order.order_number);
      }

      /* ── 最後一步:標記 order 為 paid (idempotency 信號) ── */
      const { error: paidErr } = await supabase
        .from('orders')
        .update({ status: 'paid' })
        .eq('id', order.id)
        .eq('status', 'pending'); // 只在仍 pending 時更新,避免 race
      if (paidErr) {
        console.error('[NewebPay Notify] order paid update error:', paidErr);
      } else {
        console.log('[NewebPay Notify] order marked paid:', {
          order_number: orderNo,
          trade_no:     result.TradeNo,
          payment_type: result.PaymentType,
          amt:          result.Amt,
        });
      }

    } catch (sbErr) {
      console.error('[NewebPay Notify] Supabase block error:', sbErr);
      // 不丟 500 — 藍新會一直重送
    }

    // 4. 藍新規格: 200 OK 即視為成功接收 (不像綠界要回 "1|OK")
    return res.status(200).send('OK');

  } catch (err) {
    console.error('[NewebPay Notify] Error:', err);
    // 不丟 500,避免藍新不斷重試 (但 log 留住)
    return res.status(200).send('OK');
  }
}
