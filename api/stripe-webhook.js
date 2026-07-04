// api/stripe-webhook.js — receives Stripe events and records store orders.
//
// On checkout.session.completed it writes a row to store_orders for the member
// whose store made the sale. Verifies the Stripe signature manually (no SDK) so
// nobody can fake an order.
//
// IMPORTANT: body parsing is disabled so we can read the raw payload for
// signature verification.
//
// Env: STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import crypto from "crypto";

export const config = { api: { bodyParser: false } };

const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_SVC = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const WH_SECRET = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();

async function rawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}
function verify(raw, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = {};
  sigHeader.split(",").forEach((kv) => { const i = kv.indexOf("="); if (i > 0) parts[kv.slice(0, i)] = kv.slice(i + 1); });
  if (!parts.t || !parts.v1) return false;
  const signed = parts.t + "." + raw.toString("utf8");
  const expected = crypto.createHmac("sha256", secret).update(signed).digest("hex");
  try {
    const a = Buffer.from(expected); const b = Buffer.from(parts.v1);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  let raw;
  try { raw = await rawBody(req); } catch { return res.status(400).json({ error: "No body" }); }

  const sig = req.headers["stripe-signature"];
  if (!verify(raw, sig, WH_SECRET)) return res.status(400).json({ error: "Bad signature" });

  let event;
  try { event = JSON.parse(raw.toString("utf8")); } catch { return res.status(400).json({ error: "Bad JSON" }); }

  try {
    if (event.type === "checkout.session.completed") {
      const s = event.data && event.data.object ? event.data.object : {};
      const md = s.metadata || {};
      let items = [];
      try { items = JSON.parse(md.items || "[]"); } catch {}
      const ship = s.shipping_details || (s.collected_information && s.collected_information.shipping_details) || null;
      const addr = (ship && ship.address) || (s.customer_details && s.customer_details.address) || null;
      const shipName = (ship && ship.name) || (s.customer_details && s.customer_details.name) || null;
      const shipAddr = addr ? [addr.line1, addr.line2, addr.city, addr.state, addr.postal_code, addr.country].filter(Boolean).join(", ") : null;
      const order = {
        owner_id: md.owner_id || null,
        session_id: s.id || null,
        customer_email: (s.customer_details && s.customer_details.email) || s.customer_email || null,
        amount_total: typeof s.amount_total === "number" ? s.amount_total : null,
        currency: s.currency || "usd",
        application_fee: md.fee ? parseInt(md.fee, 10) : null,
        items,
        shipping_name: shipName,
        shipping_address: shipAddr,
        status: "paid",
      };
      if (order.owner_id && order.session_id) {
        // upsert on session_id so retried webhooks don't duplicate the order
        await fetch(SB_URL + "/rest/v1/store_orders", {
          method: "POST",
          headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify(order),
        });
      }
    }
  } catch (e) {
    // never 500 on a handled event — Stripe would retry forever
  }
  return res.status(200).json({ received: true });
}
