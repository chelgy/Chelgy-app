// api/stripe-connect.js — start Stripe Connect (Express) onboarding for a member.
//
// Creates a connected Stripe account for the logged-in member (if they don't
// have one yet), stores it, and returns a Stripe-hosted onboarding link. After
// they finish, money from their store's sales is paid straight into THEIR Stripe,
// and Chelgy can take a small application fee per sale at checkout time.
//
// Env: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SHOPIFY_APP_URL

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const STRIPE_KEY = (process.env.STRIPE_SECRET_KEY || "").trim();
const APP_URL = (process.env.SHOPIFY_APP_URL || process.env.APP_URL || "https://chelgy.app").trim();

async function getUser(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, Authorization: "Bearer " + token } });
    const u = await r.json();
    return r.ok && u && u.id ? u : null;
  } catch { return null; }
}
async function stripe(path, params) {
  const body = new URLSearchParams(params).toString();
  const r = await fetch("https://api.stripe.com/v1/" + path, {
    method: "POST",
    headers: { Authorization: "Bearer " + STRIPE_KEY, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, j };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    if (!STRIPE_KEY) return res.status(500).json({ error: "Payments aren't configured yet." });
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const token = (body.access_token || (req.headers.authorization || "").replace(/^Bearer\s+/i, "")).trim();
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: "Please log in again." });

    const svc = { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC };

    // Do we already have a connected account for this member?
    let accountId = null;
    try {
      const q = await fetch(SB_URL + "/rest/v1/stripe_accounts?select=account_id&user_id=eq." + user.id, { headers: svc });
      const rows = await q.json();
      if (Array.isArray(rows) && rows[0]) accountId = rows[0].account_id;
    } catch {}

    if (!accountId) {
      const acct = await stripe("accounts", {
        type: "express",
        email: user.email || "",
        "capabilities[card_payments][requested]": "true",
        "capabilities[transfers][requested]": "true",
        "business_profile[product_description]": "Online store powered by Chelgy",
      });
      if (!acct.ok || !acct.j.id) return res.status(502).json({ error: (acct.j && acct.j.error && acct.j.error.message) || "Couldn't start Stripe setup." });
      accountId = acct.j.id;
      try {
        await fetch(SB_URL + "/rest/v1/stripe_accounts", {
          method: "POST",
          headers: { ...svc, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify({ user_id: user.id, account_id: accountId, charges_enabled: false, updated_at: new Date().toISOString() }),
        });
      } catch {}
    }

    const link = await stripe("account_links", {
      account: accountId,
      refresh_url: APP_URL + "/?stripe=refresh",
      return_url: APP_URL + "/?stripe=done",
      type: "account_onboarding",
    });
    if (!link.ok || !link.j.url) return res.status(502).json({ error: "Couldn't create the setup link. Try again." });

    return res.status(200).json({ url: link.j.url });
  } catch (e) {
    return res.status(500).json({ error: "Server error." });
  }
}
