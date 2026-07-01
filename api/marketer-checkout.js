// api/marketer-checkout.js
// Starts a REAL Stripe subscription checkout for the $100/mo Chelgy Marketer membership.
//
// Mirrors create-checkout.js: the SERVER owns the price ($100/mo) so the browser
// can't cheat it, and the buyer is verified from their Supabase login token.
// The membership is only switched ON by api/stripe-webhook.js after Stripe
// confirms the payment cleared — never here.
//
// Coupons: promo codes are entered on Stripe's checkout page (allow_promotion_codes).
// Create matching Promotion Codes in your Stripe dashboard: CHELGYFREE (100% off,
// duration "once"), CHELGY25/50/75/90 (that % off, duration "once").
//
// Required Vercel env vars:
//   SUPABASE_URL, SUPABASE_ANON_KEY, STRIPE_SECRET_KEY

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const token = body.access_token;
    if (!token) return res.status(401).json({ error: "Please log in before starting your membership." });

    // Verify the buyer from their Supabase login token
    const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
    const SUPABASE_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
    const uRes = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { "apikey": SUPABASE_ANON, "Authorization": "Bearer " + token }
    });
    const u = await uRes.json().catch(() => null);
    if (!uRes.ok || !u || !u.id) return res.status(401).json({ error: "Your session expired. Please log in again." });

    const STRIPE_SECRET = (process.env.STRIPE_SECRET_KEY || "").trim();
    if (!STRIPE_SECRET) return res.status(500).json({ error: "Payments are not configured yet." });

    const origin = req.headers.origin || ("https://" + (req.headers.host || "team.chelgy.app"));

    const params = new URLSearchParams();
    params.append("mode", "subscription");
    params.append("allow_promotion_codes", "true");
    params.append("success_url", origin + "/?team&membership=success");
    params.append("cancel_url", origin + "/?team&membership=cancel");
    if (u.email) params.append("customer_email", u.email);
    params.append("client_reference_id", u.id);
    params.append("metadata[user_id]", u.id);
    params.append("metadata[kind]", "marketer_membership");
    // Also stamp the subscription itself, so future subscription events carry the user id
    params.append("subscription_data[metadata][user_id]", u.id);
    params.append("subscription_data[metadata][kind]", "marketer_membership");
    // Inline recurring price — no pre-created Stripe product needed
    params.append("line_items[0][quantity]", "1");
    params.append("line_items[0][price_data][currency]", "usd");
    params.append("line_items[0][price_data][unit_amount]", "10000"); // $100.00
    params.append("line_items[0][price_data][recurring][interval]", "month");
    params.append("line_items[0][price_data][product_data][name]", "Chelgy Marketer Membership");

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
