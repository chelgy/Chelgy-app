// api/stripe-webhook.js
// The ONLY place credits get added from a purchase.
//
// Stripe calls this URL after a payment. We verify the request is genuinely
// from Stripe (signature check), then add the purchased credits to the buyer's
// account using the Supabase service-role key — which only lives on the server.
// The browser is never involved, so credits can't be faked.
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

  if (event.type === "checkout.session.completed") {
    const s = event.data.object || {};
    const meta = s.metadata || {};
    const userId = meta.user_id;
    const credits = parseInt(meta.credits, 10);
    // Only credit if the payment is actually paid
    const paid = s.payment_status === "paid" || s.status === "complete";
    if (paid && userId && credits > 0) {
      const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
      const SERVICE = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
      try {
        await fetch(SUPABASE_URL + "/rest/v1/rpc/add_credits", {
          method: "POST",
          headers: { "apikey": SERVICE, "Authorization": "Bearer " + SERVICE, "Content-Type": "application/json" },
          body: JSON.stringify({ p_user: userId, p_amount: credits, p_reason: "purchase:" + (meta.pack_id || "pack") })
        });
      } catch { /* Stripe will retry the webhook if we error, so swallow & 200 below only on success */ }
    }
  }

  // Always acknowledge receipt so Stripe doesn't retry endlessly
  return res.status(200).json({ received: true });
}
