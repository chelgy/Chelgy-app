// api/domain-checkout.js — Stripe Checkout to buy a domain through Chelgy.
//
// The member pays Chelgy. Stripe collects their name/email/phone/address at
// checkout (used as the domain registrant). The webhook then registers the domain
// via Vercel and auto-connects it to their site. Price is verified SERVER-SIDE.
//
// Env: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, VERCEL_TOKEN,
//      VERCEL_TEAM_ID (opt), DOMAIN_MARKUP_USD (opt), SHOPIFY_APP_URL / APP_URL

const SB_URL = (process.env.SUPABASE_URL || "").trim();
const ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
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
    if (!STRIPE_KEY || !VT) return res.status(500).json({ error: "Domain purchases aren't set up yet." });
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const token = (req.headers.authorization || "").replace(/^Bearer /, "").trim();
    const domain = String(body.domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!token) return res.status(401).json({ error: "Please sign in again." });
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return res.status(400).json({ error: "Invalid domain." });

    // who is the member?
    const ures = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: ANON, Authorization: "Bearer " + token } });
    const user = await ures.json().catch(() => ({}));
    if (!user || !user.id) return res.status(401).json({ error: "Please sign in again." });

    // verify it's still available + get the real price (never trust the client)
    const a = await vget("/v1/registrar/domains/" + encodeURIComponent(domain) + "/availability");
    if (!a.ok || !a.j || !a.j.available) return res.status(400).json({ error: "That domain isn't available anymore." });
    const p = await vget("/v1/registrar/domains/" + encodeURIComponent(domain) + "/price?years=1");
    const base = (p.ok && p.j && p.j.purchasePrice != null) ? parseFloat(p.j.purchasePrice) : NaN;
    if (!isFinite(base) || base <= 0) return res.status(400).json({ error: "Couldn't price that domain right now." });
    const chargeCents = Math.round(withMargin(base) * 100);

    // Stripe Checkout (pays Chelgy) + collect registrant contact
    const params = {};
    params["mode"] = "payment";
    params["success_url"] = okUrl(body.success_url, APP_URL + "/?domain_bought=" + encodeURIComponent(domain));
    params["cancel_url"] = okUrl(body.cancel_url, APP_URL + "/");
    params["line_items[0][price_data][currency]"] = "usd";
    params["line_items[0][price_data][product_data][name]"] = "Domain: " + domain + " (1 year)";
    params["line_items[0][price_data][unit_amount]"] = String(chargeCents);
    params["line_items[0][quantity]"] = "1";
    params["billing_address_collection"] = "required";
    params["phone_number_collection[enabled]"] = "true";
    params["metadata[type]"] = "domain";
    params["metadata[domain]"] = domain;
    params["metadata[owner_id]"] = user.id;
    params["metadata[site_id]"] = String(body.site_id || "");
    params["metadata[years]"] = "1";

    const session = await stripe("checkout/sessions", params);
    if (!session.ok || !session.j.url) return res.status(502).json({ error: (session.j && session.j.error && session.j.error.message) || "Couldn't start checkout." });
    return res.status(200).json({ url: session.j.url });
  } catch (e) {
    return res.status(500).json({ error: "Server error." });
  }
}
