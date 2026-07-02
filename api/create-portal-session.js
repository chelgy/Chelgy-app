// api/create-portal-session.js
// Opens the Stripe Customer Portal for the logged-in member — update card, see the
// next renewal date, download invoices, or cancel. Uses the raw Stripe REST API via
// fetch (no SDK), matching create-checkout.js / create-membership-checkout.js.
//
// Required Vercel env vars: SUPABASE_URL, SUPABASE_ANON_KEY, STRIPE_SECRET_KEY
// One-time in Stripe: enable the Customer Portal (Settings → Billing → Customer portal).

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const token = (body.access_token || (req.headers.authorization || "").replace(/^Bearer\s+/i, "")).trim();
    if (!token) return res.status(401).json({ error: "Please log in again." });

    // Verify the member from their Supabase login token
    const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
    const SUPABASE_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
    const uRes = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { "apikey": SUPABASE_ANON, "Authorization": "Bearer " + token }
    });
    const u = await uRes.json().catch(() => null);
    if (!uRes.ok || !u || !u.id) return res.status(401).json({ error: "Your session expired. Please log in again." });
    const email = u.email;
    if (!email) return res.status(400).json({ error: "No email is on file for your account." });

    const STRIPE_SECRET = (process.env.STRIPE_SECRET_KEY || "").trim();
    if (!STRIPE_SECRET) return res.status(500).json({ error: "Billing is not configured yet." });

    // Find the Stripe customer by email (checkout creates them with this email)
    const cRes = await fetch("https://api.stripe.com/v1/customers?email=" + encodeURIComponent(email) + "&limit=1", {
      headers: { "Authorization": "Bearer " + STRIPE_SECRET }
    });
    const cData = await cRes.json().catch(() => null);
    if (!cRes.ok) return res.status(502).json({ error: (cData && cData.error && cData.error.message) || "Could not reach billing." });
    const customer = cData && cData.data && cData.data[0];
    if (!customer) return res.status(404).json({ error: "We couldn't find a subscription for your account yet." });

    // Create the billing-portal session
    const origin = (req.headers.origin || ("https://" + (req.headers.host || "chelgy.app"))).replace(/\/+$/, "");
    const params = new URLSearchParams();
    params.append("customer", customer.id);
    params.append("return_url", origin + "/profile");

    const pRes = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + STRIPE_SECRET, "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });
    const portal = await pRes.json().catch(() => null);
    if (!pRes.ok) return res.status(502).json({ error: (portal && portal.error && portal.error.message) || "Could not open the billing portal." });
    return res.status(200).json({ url: portal.url });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
