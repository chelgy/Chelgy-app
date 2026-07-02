// api/create-membership-checkout.js
// Creates a REAL Stripe SUBSCRIPTION Checkout session for the $100/month Chelgy
// membership (regular members — separate from the marketer membership flow).
//
// Why this exists: a hosted Payment Link can't tell the webhook WHICH user paid,
// so members never auto-activate. This route stamps the member's id onto both the
// checkout session AND the subscription, so activation, renewals and cancellation
// all wire up automatically in api/stripe-webhook.js.
//
// The price is owned by the server (env var, never the browser), and the buyer is
// verified from their Supabase login token. Credits/status are granted by the
// webhook + the monthly claim — never here.
//
// Required Vercel env vars:
//   SUPABASE_URL, SUPABASE_ANON_KEY, STRIPE_SECRET_KEY, STRIPE_MEMBER_PRICE_ID

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    const token = body.access_token;
    if (!token) return res.status(401).json({ error: "Please log in before subscribing." });

    // Verify the buyer from their Supabase login token
    const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
    const SUPABASE_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
    const uRes = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { "apikey": SUPABASE_ANON, "Authorization": "Bearer " + token }
    });
    const u = await uRes.json().catch(() => null);
    if (!uRes.ok || !u || !u.id) return res.status(401).json({ error: "Your session expired. Please log in again." });

    const STRIPE_SECRET = (process.env.STRIPE_SECRET_KEY || "").trim();
    const PRICE = (process.env.STRIPE_MEMBER_PRICE_ID || "price_1Tn7EQBHcqB4fDLDuIiOut6S").trim();
    if (!STRIPE_SECRET) return res.status(500).json({ error: "Payments are not configured yet." });
    if (!PRICE) return res.status(500).json({ error: "Membership plan is not configured yet." });

    const origin = req.headers.origin || ("https://" + (req.headers.host || "chelgy.app"));

    const params = new URLSearchParams();
    params.append("mode", "subscription");
    params.append("allow_promotion_codes", "true");
    params.append("success_url", origin + "/?member=success");
    params.append("cancel_url", origin + "/?member=cancel");
    if (u.email) params.append("customer_email", u.email);
    params.append("client_reference_id", u.id);
    // Metadata on the SESSION → used by checkout.session.completed
    params.append("metadata[user_id]", u.id);
    params.append("metadata[kind]", "member_membership");
    // Metadata on the SUBSCRIPTION → used by customer.subscription.deleted (cancellation)
    params.append("subscription_data[metadata][user_id]", u.id);
    params.append("subscription_data[metadata][kind]", "member_membership");
    // The $100/month recurring price (server-owned)
    params.append("line_items[0][price]", PRICE);
    params.append("line_items[0][quantity]", "1");

    const sRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + STRIPE_SECRET, "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });
    const session = await sRes.json();
    if (!sRes.ok) return res.status(502).json({ error: (session.error && session.error.message) || "Could not start checkout." });
    return res.status(200).json({ url: session.url });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
