// api/domain-renew.js — Stripe Checkout to renew a domain the member bought through Chelgy.
//
// Verifies the member owns the domain, charges the yearly renewal price, and the
// webhook (metadata.type = "domain_renew") extends it via Vercel + bumps expires_at.
//
// Env: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
//      VERCEL_TOKEN, VERCEL_TEAM_ID (opt), DOMAIN_MARKUP_USD (opt), SHOPIFY_APP_URL / APP_URL

const SB_URL = (process.env.SUPABASE_URL || "").trim();
const ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const STRIPE_KEY = (process.env.STRIPE_SECRET_KEY || "").trim();
const VT = (process.env.VERCEL_TOKEN || "").trim();
const TEAM = (process.env.VERCEL_TEAM_ID || "").trim();
const MARKUP_PCT = (parseFloat(process.env.DOMAIN_MARKUP_PCT || "50") || 50) / 100; // Chelgy's margin, % of Vercel's at-cost price (scales with pricier domains)
const MARKUP_MIN = parseFloat(process.env.DOMAIN_MARKUP_MIN_USD || "4") || 4;         // dollar floor so cheap domains still clear Stripe's fee
function withMargin(base) { const m = Math.max(base * MARKUP_PCT, MARKUP_MIN); return Math.round((base + m) * 100) / 100; } // ~$10 domain -> ~$15
const APP_URL = (process.env.SHOPIFY_APP_URL || process.env.APP_URL || "https://chelgy.app").trim();

async function stripe(path, params) {
  const r = await fetch("https://api.stripe.com/v1/" + path, {
    method: "POST",
    headers: { Authorization: "Bearer " + STRIPE_KEY, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, j };
}
async function vget(path) {
  const url = "https://api.vercel.com" + path + (path.includes("?") ? "&" : "?") + (TEAM ? "teamId=" + encodeURIComponent(TEAM) : "");
  const r = await fetch(url, { headers: { Authorization: "Bearer " + VT } });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, j };
}
function okUrl(u, f) { return (typeof u === "string" && /^https?:\/\//.test(u)) ? u : f; }

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    if (!STRIPE_KEY || !VT) return res.status(500).json({ error: "Domain renewal isn't set up yet." });
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const token = (req.headers.authorization || "").replace(/^Bearer /, "").trim();
    const domain = String(body.domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!token) return res.status(401).json({ error: "Please sign in again." });
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return res.status(400).json({ error: "Invalid domain." });

    const ures = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: ANON, Authorization: "Bearer " + token } });
    const user = await ures.json().catch(() => ({}));
    if (!user || !user.id) return res.status(401).json({ error: "Please sign in again." });

    // confirm the member actually owns this domain
    const svc = { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC };
    const dq = await fetch(SB_URL + "/rest/v1/domains?select=id&domain=eq." + encodeURIComponent(domain) + "&user_id=eq." + user.id, { headers: svc });
    const drows = await dq.json().catch(() => []);
    if (!Array.isArray(drows) || !drows.length) return res.status(404).json({ error: "We don't have that domain on your account." });

    // renewal price (server-side)
    const p = await vget("/v1/registrar/domains/" + encodeURIComponent(domain) + "/price?years=1");
    const base = (p.ok && p.j && p.j.renewalPrice != null) ? parseFloat(p.j.renewalPrice) : NaN;
    if (!isFinite(base) || base <= 0) return res.status(400).json({ error: "Couldn't price that renewal right now." });
    const chargeCents = Math.round(withMargin(base) * 100);

    const params = {};
    params["mode"] = "payment";
    params["success_url"] = okUrl(body.success_url, APP_URL + "/?domain_renewed=" + encodeURIComponent(domain));
    params["cancel_url"] = okUrl(body.cancel_url, APP_URL + "/");
    params["line_items[0][price_data][currency]"] = "usd";
    params["line_items[0][price_data][product_data][name]"] = "Renew domain: " + domain + " (1 year)";
    params["line_items[0][price_data][unit_amount]"] = String(chargeCents);
    params["line_items[0][quantity]"] = "1";
    params["metadata[type]"] = "domain_renew";
    params["metadata[domain]"] = domain;
    params["metadata[owner_id]"] = user.id;
    params["metadata[years]"] = "1";

    const session = await stripe("checkout/sessions", params);
    if (!session.ok || !session.j.url) return res.status(502).json({ error: (session.j && session.j.error && session.j.error.message) || "Couldn't start checkout." });
    return res.status(200).json({ url: session.j.url });
  } catch (e) {
    return res.status(500).json({ error: "Server error." });
  }
}
