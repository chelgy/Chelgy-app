// api/stripe-status.js — check whether a member's Stripe Connect account is
// fully onboarded and ready to take payments. Also refreshes the stored flag.
//
// Env: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const STRIPE_KEY = (process.env.STRIPE_SECRET_KEY || "").trim();

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

    const svc = { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC };
    let accountId = null;
    try {
      const q = await fetch(SB_URL + "/rest/v1/stripe_accounts?select=account_id&user_id=eq." + user.id, { headers: svc });
      const rows = await q.json();
      if (Array.isArray(rows) && rows[0]) accountId = rows[0].account_id;
    } catch {}

    if (!accountId) return res.status(200).json({ connected: false, charges_enabled: false });

    if (!STRIPE_KEY) return res.status(200).json({ connected: true, charges_enabled: false });
    const r = await fetch("https://api.stripe.com/v1/accounts/" + accountId, { headers: { Authorization: "Bearer " + STRIPE_KEY } });
    const acct = await r.json().catch(() => ({}));
    const charges = !!(acct && acct.charges_enabled);
    const payouts = !!(acct && acct.payouts_enabled);
    const submitted = !!(acct && acct.details_submitted);

    // keep our stored flag fresh
    try {
      await fetch(SB_URL + "/rest/v1/stripe_accounts?user_id=eq." + user.id, {
        method: "PATCH",
        headers: { ...svc, "Content-Type": "application/json" },
        body: JSON.stringify({ charges_enabled: charges, updated_at: new Date().toISOString() }),
      });
    } catch {}

    return res.status(200).json({ connected: true, charges_enabled: charges, payouts_enabled: payouts, details_submitted: submitted, account_id: accountId });
  } catch (e) {
    return res.status(500).json({ error: "Server error." });
  }
}
