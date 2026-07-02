// api/stripe-webhook.js
// The ONLY place a purchase changes anything server-side.
//   • Credit packs → add credits (unchanged)
//   • Marketer membership subscription → flip the marketer's account to "active"
//
// Stripe calls this URL after a payment. We verify the request is genuinely from
// Stripe (signature check), then act using the Supabase service-role key — which
// only lives on the server. The browser is never involved, so nothing can be faked.
//
// Required Vercel env vars:
//   STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import crypto from "crypto";

// We need Stripe's RAW request body to verify the signature, so turn off
// Vercel's automatic body parsing for this function.
export const config = { api: { bodyParser: false } };

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function verifyStripe(payload, sigHeader, secret) {
  try {
    const parts = {};
    sigHeader.split(",").forEach((kv) => { const [k, v] = kv.split("="); parts[k] = v; });
    if (!parts.t || !parts.v1) return false;
    const signed = parts.t + "." + payload;
    const expected = crypto.createHmac("sha256", secret).update(signed, "utf8").digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(parts.v1);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const secret = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  const sig = req.headers["stripe-signature"];
  let raw;
  try { raw = await readRaw(req); } catch { return res.status(400).json({ error: "no body" }); }
  if (!secret || !sig || !verifyStripe(raw, sig, secret)) {
    return res.status(400).json({ error: "Invalid signature" });
  }

  let event;
  try { event = JSON.parse(raw); } catch { return res.status(400).json({ error: "bad json" }); }

  const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
  const SERVICE = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

  async function setMemberStatus(userId, status) {
    try {
      await fetch(SUPABASE_URL + "/rest/v1/members?user_id=eq." + userId, {
        method: "PATCH",
        headers: { "apikey": SERVICE, "Authorization": "Bearer " + SERVICE, "Content-Type": "application/json", "Prefer": "return=minimal" },
        body: JSON.stringify({ status })
      });
    } catch { /* swallow; Stripe retries on non-200 */ }
  }
  async function addCredits(userId, credits, packId) {
    try {
      await fetch(SUPABASE_URL + "/rest/v1/rpc/add_credits", {
        method: "POST",
        headers: { "apikey": SERVICE, "Authorization": "Bearer " + SERVICE, "Content-Type": "application/json" },
        body: JSON.stringify({ p_user: userId, p_amount: credits, p_reason: "purchase:" + (packId || "pack") })
      });
    } catch { /* swallow */ }
  }
  // Update a member's status looked up by email. `onlyFrom` (optional) restricts the
  // update to members currently in those statuses — so we never clobber admin/comp
  // accounts or re-suspend someone who's fine.
  async function setMemberStatusByEmail(email, status, onlyFrom) {
    if (!email) return;
    try {
      let url = SUPABASE_URL + "/rest/v1/members?email=eq." + encodeURIComponent(email);
      if (onlyFrom && onlyFrom.length) url += "&status=in.(" + onlyFrom.join(",") + ")";
      await fetch(url, {
        method: "PATCH",
        headers: { "apikey": SERVICE, "Authorization": "Bearer " + SERVICE, "Content-Type": "application/json", "Prefer": "return=minimal" },
        body: JSON.stringify({ status })
      });
    } catch { /* swallow */ }
  }

  if (event.type === "checkout.session.completed") {
    const s = event.data.object || {};
    const meta = s.metadata || {};
    const userId = meta.user_id;
    const paid = s.payment_status === "paid" || s.status === "complete";

    if (paid && userId) {
      // Marketer membership subscription → activate the marketer
      if (meta.kind === "marketer_membership") {
        await setMemberStatus(userId, "active");
      }
      // Regular member subscription → activate the member.
      // (Their 12,000 monthly allowance is granted by the monthly claim on next login.)
      if (meta.kind === "member_membership") {
        await setMemberStatus(userId, "active");
      }
      // Credit pack purchase → add credits
      const credits = parseInt(meta.credits, 10);
      if (credits > 0) {
        await addCredits(userId, credits, meta.pack_id);
      }
    }
  }

  // Marketer or member cancels / subscription lapses → revoke access
  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object || {};
    const meta = sub.metadata || {};
    if (meta.user_id && (meta.kind === "marketer_membership" || meta.kind === "member_membership")) {
      await setMemberStatus(meta.user_id, "canceled");
    }
  }

  // A subscription payment failed (card declined mid-membership) → suspend access.
  // Only touches members who were actively paying, so admin/comp accounts are safe.
  if (event.type === "invoice.payment_failed") {
    const inv = event.data.object || {};
    if (inv.subscription && inv.customer_email) {
      await setMemberStatusByEmail(inv.customer_email, "past_due", ["active", "paid"]);
    }
  }

  // A subscription payment cleared (initial or a recovered retry) → restore access.
  // Only un-suspends someone currently past_due; won't disturb admin/comp/active.
  if (event.type === "invoice.payment_succeeded") {
    const inv = event.data.object || {};
    if (inv.subscription && inv.customer_email) {
      await setMemberStatusByEmail(inv.customer_email, "active", ["past_due"]);
    }
  }

  // Always acknowledge receipt so Stripe doesn't retry endlessly
  return res.status(200).json({ received: true });
}
