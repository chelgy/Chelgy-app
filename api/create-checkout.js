// api/create-checkout.js
// Creates a REAL Stripe Checkout session for a credit pack.
//
// Two things are locked down here so the browser can't cheat:
//   1. PRICING is owned by the server (the client only names a pack id; the
//      server decides the dollar amount and credit count). A user can't claim
//      "I bought 850,000 credits for $30."
//   2. The BUYER is verified from their Supabase login token, so the credits
//      can only ever be assigned to the real logged-in person.
//
// Credits are NOT added here — they're added by api/stripe-webhook.js only
// after Stripe confirms the payment actually cleared.
//
// Required Vercel env vars:
//   SUPABASE_URL, SUPABASE_ANON_KEY, STRIPE_SECRET_KEY

const PACKS = {
  starter: { credits: 33000,  amount: 3000,  name: "Starter Pack — 33,000 credits" },
  creator: { credits: 70000,  amount: 5900,  name: "Creator Pack — 70,000 credits" },
  pro:     { credits: 150000, amount: 11900, name: "Pro Pack — 150,000 credits" },
  studio:  { credits: 400000, amount: 29900, name: "Studio Pack — 400,000 credits" },
  agency:  { credits: 850000, amount: 59900, name: "Agency Pack — 850,000 credits" },
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const pack = PACKS[body.pack_id];
    if (!pack) return res.status(400).json({ error: "Unknown pack." });

    const token = body.access_token;
    if (!token) return res.status(401).json({ error: "Please log in before purchasing." });

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

    const origin = req.headers.origin || ("https://" + (req.headers.host || "chelgy.app"));

    // Build the Checkout session via Stripe's REST API (form-encoded, no SDK needed)
    const params = new URLSearchParams();
    params.append("mode", "payment");
    params.append("success_url", origin + "/?credits=success");
    params.append("cancel_url", origin + "/?credits=cancel");
    if (u.email) params.append("customer_email", u.email);
    params.append("client_reference_id", u.id);
    params.append("metadata[user_id]", u.id);
    params.append("metadata[credits]", String(pack.credits));
    params.append("metadata[pack_id]", body.pack_id);
    params.append("line_items[0][quantity]", "1");
    params.append("line_items[0][price_data][currency]", "usd");
    params.append("line_items[0][price_data][unit_amount]", String(pack.amount));
    params.append("line_items[0][price_data][product_data][name]", pack.name);

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
