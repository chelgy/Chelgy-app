// ─────────────────────────────────────────────────────────────────────────────
//  /api/outreach-sms  — Chelgy consent-gated SMS sender  (Vercel serverless)
//
//  Sends a text through Twilio ONLY to a lead the member has marked as opted-in
//  (sms_consent = true). This is deliberate: US law (TCPA) requires prior
//  consent for marketing texts, and carriers block un-consented 10DLC traffic.
//  Every message carries an opt-out line; Twilio's Advanced Opt-Out enforces
//  STOP automatically at the Messaging Service level.
//
//  Vercel environment variables:
//    TWILIO_ACCOUNT_SID          — from twilio.com
//    TWILIO_AUTH_TOKEN           — from twilio.com
//    TWILIO_MESSAGING_SERVICE_SID— your 10DLC-registered Messaging Service (MG...)
//    (or) TWILIO_FROM_NUMBER     — a registered sending number in E.164 (+1...)
//    SUPABASE_URL / SUPABASE_ANON_KEY — already yours
// ─────────────────────────────────────────────────────────────────────────────

const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_MSG_SVC = process.env.TWILIO_MESSAGING_SERVICE_SID || "";
const TWILIO_FROM  = process.env.TWILIO_FROM_NUMBER || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://yuzvpmxbtjpqtapborhr.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

const COST_SMS   = 40;   // keep in sync with CREDIT_COSTS.smsSend in App.jsx
const DAILY_CAP  = 100;  // per member per day

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

// Read a single lead the member owns; used to confirm SMS consent server-side.
async function getLead(token, uid, leadId) {
  try {
    const res = await fetch(
      SUPABASE_URL + "/rest/v1/leads?select=id,phone,sms_consent&user_id=eq." + uid + "&id=eq." + leadId,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token } }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (e) { return null; }
}

async function sentToday(token, uid) {
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const res = await fetch(
      SUPABASE_URL + "/rest/v1/outreach?select=id&channel=eq.sms&user_id=eq." + uid + "&created_at=gte." + encodeURIComponent(since),
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

async function logSms(token, uid, leadId, to, body) {
  try {
    await fetch(SUPABASE_URL + "/rest/v1/outreach", {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ user_id: uid, lead_id: leadId || null, to_email: to, subject: body.slice(0, 120), status: "sent", channel: "sms" }),
    });
  } catch (e) {}
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST." }); return; }
  if (!TWILIO_SID || !TWILIO_TOKEN || (!TWILIO_MSG_SVC && !TWILIO_FROM)) {
    res.status(500).json({ error: "SMS isn't configured yet (missing Twilio credentials or sending number)." });
    return;
  }

  const auth = await verifyMember(req.headers.authorization);
  if (!auth) { res.status(401).json({ error: "Please sign in again and retry." }); return; }
  const { user, token } = auth;

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const leadId = (body.leadId || "").toString();
    const to = (body.to || "").toString().trim();
    let text = (body.body || "").toString().trim();

    if (!to || !/^\+?[0-9][0-9\-\s().]{6,}$/.test(to)) { res.status(400).json({ error: "That doesn't look like a valid phone number." }); return; }
    if (!text) { res.status(400).json({ error: "Write a message first." }); return; }

    // HARD consent gate — the whole point of this endpoint.
    const lead = leadId ? await getLead(token, user.id, leadId) : null;
    if (!lead || lead.sms_consent !== true) {
      res.status(403).json({ error: "You can only text a lead who has opted in. Mark them as agreed-to-texts first." });
      return;
    }

    if ((await sentToday(token, user.id)) >= DAILY_CAP) {
      res.status(429).json({ error: "You've hit today's texting limit. Try again tomorrow." });
      return;
    }

    const balance = await readBalance(token, user.id);
    if (balance < COST_SMS) { res.status(402).json({ error: "Not enough credits to send.", balance }); return; }

    // Always include an opt-out (legally required for marketing SMS).
    if (!/stop/i.test(text)) text = text + "\n\nReply STOP to opt out.";

    // Build the Twilio request (form-encoded, basic auth).
    const params = new URLSearchParams();
    params.set("To", to.replace(/[\s\-().]/g, ""));
    params.set("Body", text);
    if (TWILIO_MSG_SVC) params.set("MessagingServiceSid", TWILIO_MSG_SVC);
    else params.set("From", TWILIO_FROM);

    const tw = await fetch("https://api.twilio.com/2010-04-01/Accounts/" + TWILIO_SID + "/Messages.json", {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(TWILIO_SID + ":" + TWILIO_TOKEN).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!tw.ok) {
      const detail = await tw.json().catch(() => ({}));
      res.status(502).json({ error: (detail && detail.message) ? String(detail.message).slice(0, 200) : "The SMS service rejected the send. Check your Twilio setup." });
      return;
    }

    const newBalance = await spend(token, COST_SMS, balance - COST_SMS);
    await logSms(token, user.id, leadId, to, text);

    res.status(200).json({ ok: true, balance: newBalance });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) ? e.message.slice(0, 300) : "Send failed. Try again." });
  }
};
