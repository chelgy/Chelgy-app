// ─────────────────────────────────────────────────────────────────────────────
//  /api/outreach-email  — Chelgy compliant email sender  (Vercel serverless)
//
//  Sends a member's outreach email through Resend with everything CAN-SPAM
//  requires baked in: a real physical mailing address and a one-click
//  unsubscribe link. It refuses to email anyone who has unsubscribed, caps
//  daily volume to protect deliverability, and charges credits server-side.
//
//  Vercel environment variables this file expects:
//    RESEND_API_KEY      — from resend.com (after you verify a sending domain)
//    OUTREACH_ADDR       — the verified from-address, e.g. outreach@mail.chelgy.app
//    OUTREACH_DEFAULT_NAME — fallback sender display name, e.g. "Chelgy"
//    OUTREACH_ADDRESS    — your physical mailing address (shown in every footer)
//    APP_BASE_URL        — e.g. https://chelgy.app  (used for the unsubscribe link)
//    UNSUB_SECRET        — any long random string (signs unsubscribe links)
//    SUPABASE_URL        — https://yuzvpmxbtjpqtapborhr.supabase.co
//    SUPABASE_ANON_KEY   — your Supabase publishable key
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require("crypto");

const RESEND_API_KEY   = process.env.RESEND_API_KEY || "";
const OUTREACH_ADDR    = process.env.OUTREACH_ADDR || "";
const DEFAULT_NAME     = process.env.OUTREACH_DEFAULT_NAME || "Chelgy";
const MAILING_ADDRESS  = process.env.OUTREACH_ADDRESS || "";
const APP_BASE_URL     = (process.env.APP_BASE_URL || "https://chelgy.app").replace(/\/+$/, "");
const UNSUB_SECRET     = process.env.UNSUB_SECRET || "";
const SUPABASE_URL     = process.env.SUPABASE_URL || "https://yuzvpmxbtjpqtapborhr.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

const COST_EMAIL   = 25;   // keep in sync with CREDIT_COSTS.emailSend in App.jsx
const DAILY_CAP     = 150;  // per member, protects the shared sending reputation

async function verifyMember(authHeader) {
  try {
    if (!authHeader) return null;
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return null;
    const res = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.id ? { user, token } : null;
  } catch (e) { return null; }
}

async function isSuppressed(token, uid, email) {
  try {
    const res = await fetch(
      SUPABASE_URL + "/rest/v1/suppression?select=id&user_id=eq." + uid + "&email=eq." + encodeURIComponent(email),
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token } }
    );
    if (!res.ok) return false;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) { return false; }
}

async function sentToday(token, uid) {
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const res = await fetch(
      SUPABASE_URL + "/rest/v1/outreach?select=id&user_id=eq." + uid + "&created_at=gte." + encodeURIComponent(since),
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token } }
    );
    if (!res.ok) return 0;
    const rows = await res.json();
    return Array.isArray(rows) ? rows.length : 0;
  } catch (e) { return 0; }
}

async function readBalance(token, uid) {
  try {
    const res = await fetch(
      SUPABASE_URL + "/rest/v1/members?select=credits,credits_purchased&user_id=eq." + uid,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token } }
    );
    if (!res.ok) return 0;
    const rows = await res.json();
    const m = Array.isArray(rows) && rows[0] ? rows[0] : {};
    return (Number(m.credits) || 0) + (Number(m.credits_purchased) || 0);
  } catch (e) { return 0; }
}

async function spend(token, amount, fallback) {
  try {
    const res = await fetch(SUPABASE_URL + "/rest/v1/rpc/spend_credits", {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ p_amount: amount }),
    });
    if (!res.ok) return fallback;
    const v = await res.json();
    return typeof v === "number" && v >= 0 ? v : fallback;
  } catch (e) { return fallback; }
}

async function logOutreach(token, uid, leadId, to, subject) {
  try {
    await fetch(SUPABASE_URL + "/rest/v1/outreach", {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ user_id: uid, lead_id: leadId || null, to_email: to, subject: subject, status: "sent" }),
    });
  } catch (e) {}
}

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function cleanName(s) {
  return String(s || "").replace(/[<>"\r\n]/g, "").trim().slice(0, 60);
}
function unsubLink(uid, email) {
  const sig = crypto.createHmac("sha256", UNSUB_SECRET).update(uid + "|" + email).digest("hex").slice(0, 32);
  return APP_BASE_URL + "/api/unsubscribe?u=" + encodeURIComponent(uid) + "&e=" + encodeURIComponent(email) + "&s=" + sig;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST." }); return; }
  if (!RESEND_API_KEY || !OUTREACH_ADDR) {
    res.status(500).json({ error: "Email outreach isn't configured yet (missing Resend key or from-address)." });
    return;
  }

  const auth = await verifyMember(req.headers.authorization);
  if (!auth) { res.status(401).json({ error: "Please sign in again and retry." }); return; }
  const { user, token } = auth;

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const to = (body.to || "").toString().trim();
    const subject = (body.subject || "").toString().trim();
    const message = (body.body || "").toString().trim();
    const leadId = body.leadId || null;
    const fromName = cleanName(body.fromName) || DEFAULT_NAME;

    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) { res.status(400).json({ error: "That doesn't look like a valid email address." }); return; }
    if (!subject || !message) { res.status(400).json({ error: "Add a subject and a message first." }); return; }

    // Respect unsubscribes — legally required and just good practice.
    if (await isSuppressed(token, user.id, to)) {
      res.status(409).json({ error: "This contact unsubscribed from your emails, so it can't be sent." });
      return;
    }

    // Protect the sending reputation everyone shares.
    if ((await sentToday(token, user.id)) >= DAILY_CAP) {
      res.status(429).json({ error: "You've hit today's sending limit. Try again tomorrow — spacing sends out keeps you landing in inboxes." });
      return;
    }

    // Make sure they can afford it before we send.
    const balance = await readBalance(token, user.id);
    if (balance < COST_EMAIL) { res.status(402).json({ error: "Not enough credits to send.", balance }); return; }

    // Build the compliant email: their message + required footer.
    const link = unsubLink(user.id, to);
    const bodyHtml = esc(message).replace(/\n/g, "<br>");
    const html =
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#111;">' +
      bodyHtml +
      '</div>' +
      '<div style="margin-top:28px;padding-top:14px;border-top:1px solid #e5e5e5;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#888;">' +
      (MAILING_ADDRESS ? (esc(MAILING_ADDRESS) + '<br>') : '') +
      'You received this because we thought it might be relevant to your business. ' +
      '<a href="' + link + '" style="color:#888;">Unsubscribe</a> and you won\'t be contacted again.' +
      '</div>';

    const from = fromName + " <" + OUTREACH_ADDR + ">";

    const send = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        html,
        reply_to: user.email || undefined,
        headers: {
          "List-Unsubscribe": "<" + link + ">",
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
    });

    if (!send.ok) {
      const detail = await send.json().catch(() => ({}));
      res.status(502).json({ error: (detail && detail.message) ? detail.message.slice(0, 200) : "The email service rejected the send. Check your Resend domain setup." });
      return;
    }

    // Charge, log, report new balance.
    const newBalance = await spend(token, COST_EMAIL, balance - COST_EMAIL);
    await logOutreach(token, user.id, leadId, to, subject);

    res.status(200).json({ ok: true, balance: newBalance });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) ? e.message.slice(0, 300) : "Send failed. Try again." });
  }
};
