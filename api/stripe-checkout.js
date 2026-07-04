// api/stripe-checkout.js — create a Stripe Checkout Session for a store's cart.
//
// A shopper on a member's published store checks out. The charge is created on
// Chelgy's platform, Chelgy keeps a small application fee, and the rest is
// transferred to the store owner's connected Stripe account (destination charge).
// Prices are read SERVER-SIDE from the saved site, so a shopper can't tamper with them.
//
// Env: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SHOPIFY_APP_URL

const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_SVC = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const STRIPE_KEY = (process.env.STRIPE_SECRET_KEY || "").trim();
const APP_URL = (process.env.SHOPIFY_APP_URL || process.env.APP_URL || "https://chelgy.app").trim();

const PLATFORM_FEE_BPS = 500; // Chelgy's fee = 5% of each sale. Change this to adjust.

async function stripe(path, params) {
  const r = await fetch("https://api.stripe.com/v1/" + path, {
    method: "POST",
    headers: { Authorization: "Bearer " + STRIPE_KEY, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, j };
}
function centsFromPrice(s) {
  const n = parseFloat(String(s || "").replace(/[^0-9.]/g, ""));
  return isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}
function okUrl(u, fallback) {
  return (typeof u === "string" && /^https?:\/\//.test(u)) ? u : fallback;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    if (!STRIPE_KEY) return res.status(500).json({ error: "Payments aren't configured yet." });
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const slug = String(body.slug || "").trim();
    const cart = Array.isArray(body.cart) ? body.cart : [];
    if (!slug || !cart.length) return res.status(400).json({ error: "Nothing to check out." });

    const svc = { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC };

    // 1) look up the store + its products (server-side prices)
    const q = await fetch(SB_URL + "/rest/v1/websites?select=user_id,data&slug=eq." + encodeURIComponent(slug), { headers: svc });
    const rows = await q.json();
    const site = Array.isArray(rows) && rows[0];
    if (!site) return res.status(404).json({ error: "Store not found." });
    const ownerId = site.user_id;
    const secs = (site.data && site.data.sections) || [];
    const off = secs.find((s) => s && s.type === "offerings");
    const products = (off && Array.isArray(off.items)) ? off.items : [];

    // 2) is the owner set up to take payments?
    const aq = await fetch(SB_URL + "/rest/v1/stripe_accounts?select=account_id,charges_enabled&user_id=eq." + ownerId, { headers: svc });
    const arows = await aq.json();
    const acct = Array.isArray(arows) && arows[0];
    if (!acct || !acct.account_id || !acct.charges_enabled) return res.status(400).json({ error: "This store isn't set up to take payments yet." });

    // 3) build line items from trusted server prices
    const params = {};
    let n = 0, total = 0; const meta = [];
    for (const c of cart) {
      const it = products[c && c.i];
      if (!it) continue;
      const cents = centsFromPrice(it.price);
      if (cents <= 0) continue;
      const qty = Math.max(1, Math.min(99, parseInt(c && c.qty, 10) || 1));
      params["line_items[" + n + "][price_data][currency]"] = "usd";
      params["line_items[" + n + "][price_data][product_data][name]"] = String(it.name || "Item").slice(0, 120);
      params["line_items[" + n + "][price_data][unit_amount]"] = String(cents);
      params["line_items[" + n + "][quantity]"] = String(qty);
      total += cents * qty; meta.push({ n: String(it.name || "Item").slice(0, 40), q: qty }); n++;
    }
    if (!n) return res.status(400).json({ error: "Those items aren't available." });

    const fee = Math.round(total * PLATFORM_FEE_BPS / 10000);
    params["mode"] = "payment";
    params["success_url"] = okUrl(body.success_url, APP_URL + "/?paid=1");
    params["cancel_url"] = okUrl(body.cancel_url, APP_URL + "/");
    params["payment_intent_data[application_fee_amount]"] = String(fee);
    params["payment_intent_data[transfer_data][destination]"] = acct.account_id;
    params["metadata[owner_id]"] = ownerId;
    params["metadata[slug]"] = slug;
    params["metadata[fee]"] = String(fee);
    params["metadata[items]"] = JSON.stringify(meta).slice(0, 480);
    params["phone_number_collection[enabled]"] = "true";
    ["US","CA","GB","AU","IE","NZ","DE","FR","ES","IT","NL","SE","NO","DK","FI"].forEach((cc, idx) => { params["shipping_address_collection[allowed_countries][" + idx + "]"] = cc; });

    const session = await stripe("checkout/sessions", params);
    if (!session.ok || !session.j.url) return res.status(502).json({ error: (session.j && session.j.error && session.j.error.message) || "Couldn't start checkout." });
    return res.status(200).json({ url: session.j.url });
  } catch (e) {
    return res.status(500).json({ error: "Server error." });
  }
}
