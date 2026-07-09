// ─────────────────────────────────────────────────────────────────────────────
//  /api/unsubscribe  — public one-click unsubscribe  (Vercel serverless)
//
//  Recipients click the link in the email footer (or their mail app hits it
//  automatically for one-click unsubscribe). We verify the signed link, record
//  the opt-out, and show a friendly confirmation page. After this, the sender
//  is blocked from ever emailing that address again.
//
//  This endpoint is intentionally PUBLIC (no login) — recipients aren't members.
//
//  Vercel environment variables:
//    UNSUB_SECRET       — same secret used in /api/outreach-email
//    SUPABASE_URL       — https://yuzvpmxbtjpqtapborhr.supabase.co
//    SUPABASE_ANON_KEY  — your Supabase publishable key
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require("crypto");

const UNSUB_SECRET      = process.env.UNSUB_SECRET || "";
const SUPABASE_URL      = process.env.SUPABASE_URL || "https://yuzvpmxbtjpqtapborhr.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

function page(title, msg) {
  return (
    "<!doctype html><html><head><meta charset='utf-8'>" +
    "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
    "<title>" + title + "</title></head>" +
    "<body style='margin:0;font-family:Arial,Helvetica,sans-serif;background:#F7F6F4;color:#111;'>" +
    "<div style='max-width:460px;margin:14vh auto;padding:40px 32px;background:#fff;border:1px solid #E8E6E1;text-align:center;'>" +
    "<div style='font-family:Georgia,serif;font-size:22px;margin-bottom:12px;'>" + title + "</div>" +
    "<div style='font-size:14px;line-height:1.6;color:#555;'>" + msg + "</div>" +
    "</div></body></html>"
  );
}

function validSig(uid, email, sig) {
  try {
    const expected = crypto.createHmac("sha256", UNSUB_SECRET).update(uid + "|" + email).digest("hex").slice(0, 32);
    const a = Buffer.from(String(sig || ""));
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

module.exports = async function handler(req, res) {
  const q = req.query || {};
  const uid = (q.u || "").toString();
  const email = (q.e || "").toString();
  const sig = (q.s || "").toString();

  res.setHeader("Content-Type", "text/html; charset=utf-8");

  if (!uid || !email || !validSig(uid, email, sig)) {
    res.status(400).send(page("Link expired", "This unsubscribe link isn't valid. If you keep receiving emails, reply to one and ask to be removed."));
    return;
  }

  try {
    // Record the opt-out. Ignore duplicates (already unsubscribed = still success).
    await fetch(SUPABASE_URL + "/rest/v1/suppression", {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: "Bearer " + SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
        Prefer: "resolution=ignore-duplicates,return=minimal",
      },
      body: JSON.stringify({ user_id: uid, email: email }),
    });
  } catch (e) {}

  res.status(200).send(page("You're unsubscribed", "You won't receive any more emails from this sender. It can take a moment to take effect everywhere."));
};
