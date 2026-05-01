/**
 * api/hunt.js
 * ─────────────────────────────────────────────────────────────
 * 獵物雷達 (Target Radar) 委託代尋表單後端
 *
 * 目前 (方案 A):接收前端表單 → 發送通知到 Telegram
 *               (跟 notify-order.js 共用同一個 bot)
 *
 * 之後 (方案 B):若要切換或併行 Supabase 表格紀錄,只需在
 *               下方標記為 "PLAN B" 的區塊取消註解即可,
 *               前端 fetch('/api/hunt') 不需要任何改動。
 * ─────────────────────────────────────────────────────────────
 */

const TG_TOKEN = "8573719490:AAE0VQM7LndIvJKXkTuqGn0JEQPV_wzGoLg";
const TG_CHAT  = "7083254563";

// PLAN B (Supabase) — 之後啟用時把下面三行解開,加上 hunt_requests table migration 即可
// import { createClient } from '@supabase/supabase-js';
// const SUPABASE_URL = process.env.SUPABASE_URL;
// const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const {
      target,        // 獵物名稱 / 品牌  (必填)
      ref_url,       // 參考連結
      price_range,   // 預期價格範圍
      contact,       // 聯絡方式  (必填)
      notes,         // 備註
      submitted_at,  // 前端 ISO 時間戳
      user_agent,    // 用戶 UA
      referrer,      // 來源頁面
    } = req.body || {};

    // ── 必填檢查 + 反垃圾長度限制 ────────────────────────────
    if (!target || !contact) {
      return res.status(400).json({ error: "Missing required fields: target, contact" });
    }
    if (String(target).length > 500 || String(contact).length > 500
        || String(notes || "").length > 2000) {
      return res.status(400).json({ error: "Field too long" });
    }

    // ── 組 Telegram 訊息 ────────────────────────────────────
    const ts = (submitted_at ? new Date(submitted_at) : new Date())
      .toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
    const lines = [
      "\ud83d\udce1 \u7375\u7269\u96f7\u9054 \u2014 \u65b0\u4ee3\u5c0b\u59d4\u8a17",  // 📡 獵物雷達 — 新代尋委託
      "",
      "\ud83c\udfaf \u7375\u7269: " + target,                                          // 🎯 獵物
    ];
    if (ref_url)     lines.push("\ud83d\udd17 \u53c3\u8003\u9023\u7d50: " + ref_url);   // 🔗 參考連結
    if (price_range) lines.push("\ud83d\udcb0 \u9810\u671f\u50f9\u683c: " + price_range); // 💰 預期價格
    lines.push("\ud83d\udcde \u806f\u7d61: " + contact);                                // 📞 聯絡
    if (notes) lines.push("", "\ud83d\udcdd \u5099\u8a3b:", notes);                     // 📝 備註
    lines.push("", "\u23f0 \u9001\u51fa\u6642\u9593: " + ts);                          // ⏰ 送出時間
    if (referrer)   lines.push("\ud83c\udf10 \u4f86\u6e90: " + String(referrer).slice(0, 120));  // 🌐 來源
    const msg = lines.join("\n");

    // ── 發送到 Telegram ─────────────────────────────────────
    let tgOk = false;
    try {
      const tgRes = await fetch("https://api.telegram.org/bot" + TG_TOKEN + "/sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TG_CHAT, text: msg }),
      });
      const tgData = await tgRes.json();
      tgOk = !!tgData.ok;
      if (!tgOk) console.error("[hunt] Telegram error:", tgData);
    } catch (e) {
      console.error("[hunt] Telegram fetch failed:", e);
    }

    // ── PLAN B (Supabase) — 之後想啟用的時候解開 ──────────────
    // const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    // const { error: dbErr } = await sb.from("hunt_requests").insert({
    //   target, ref_url, price_range, contact, notes,
    //   user_agent, referrer,
    //   status: "pending",
    // });
    // if (dbErr) console.error("[hunt] Supabase insert failed:", dbErr);

    // 即使 Telegram 失敗也回 200,讓前端不要顯示錯誤
    // (前端 localStorage 會把資料留底,你之後用得到)
    return res.status(200).json({ success: true, telegram: tgOk });
  } catch (err) {
    console.error("[hunt]", err);
    return res.status(200).json({ success: false, error: err.message });
  }
}
