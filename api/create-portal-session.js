// api/create-portal-session.js — opens the Stripe Customer Portal for the logged-in member.
//
// Flow: verify the logged-in user (Supabase) → find their Stripe customer by email →
// create a billing-portal session → return its URL for the browser to redirect to.
// The portal is where the member sees their renewal date, updates payment method,
// downloads invoices, and cancels — all handled securely by Stripe.
//
// Env: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_ANON_KEY
// Note: enable the Customer Portal once in the Stripe dashboard
// (Settings → Billing → Customer portal) or portal creation will error.

import Stripe from "stripe";

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();

async function getUser(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, Authorization: "Bearer " + token } });
    const u = await r.json();
    return r.ok && u && u.id ? u : null;
  } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const token = (body.access_token || (req.headers.authorization || "").replace(/^Bearer\s+/i, "")).trim();

    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: "Please log in again." });

    const email = user.email;
    if (!email) return res.status(400).json({ error: "No email is on file for your account." });

    const key = (process.env.STRIPE_SECRET_KEY || "").trim();
    if (!key) return res.status(500).json({ error: "Billing is not configured." });
    const stripe = new Stripe(key);

    // Checkout creates the customer with the member's email, so we can find them by it.
    const found = await stripe.customers.list({ email, limit: 1 });
    const customer = found && found.data && found.data[0];
    if (!customer) return res.status(404).json({ error: "We couldn't find a subscription for your account yet." });

    const origin = (req.headers.origin || "https://chelgy.app").replace(/\/+$/, "");
    const session = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: origin + "/profile",
    });

    return res.status(200).json({ url: session.url });
  } catch (e) {
    return res.status(500).json({ error: "Could not open billing portal: " + (e && e.message ? e.message : "unknown") });
  }
}
