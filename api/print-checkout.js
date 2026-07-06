// api/print-checkout.js — Stripe Checkout to buy a printed product through Chelgy.
//
// The member pays Chelgy. We re-price the order SERVER-SIDE via Gelato (never trust
// the client), save a pending order row, then start Stripe. After payment, the
// webhook places the real Gelato order and Gelato prints + ships it. Chelgy pays
// Gelato from its wallet; the member's payment (with your margin) covers it.
//
// Body: { productUid, productLabel, quantity, designUrl, designBackUrl?,
//         recipient: { firstName, lastName, addressLine1, addressLine2?, city, state?, postCode, country, email, phone? } }
//
// Env: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
//      GELATO_API_KEY, PRINT_MARKUP_PCT (opt), PRINT_MARKUP_MIN_USD (opt), APP_URL / SHOPIFY_APP_URL

const SB_URL = (process.env.SUPABASE_URL || "").trim();
const ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SERVICE = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const STRIPE_KEY = (process.env.STRIPE_SECRET_KEY || "").trim();
const GELATO_KEY = (process.env.GELATO_API_KEY || "").trim();
const MARKUP_PCT = (parseFloat(process.env.PRINT_MARKUP_PCT || "50") || 50) / 100;
const MARKUP_MIN = parseFloat(process.env.PRINT_MARKUP_MIN_USD || "3") || 3;
function withMargin(base) { const m = Math.max(base * MARKUP_PCT, MARKUP_MIN); return Math.round((base + m) * 100) / 100; }
const APP_URL = (process.env.SHOPIFY_APP_URL || process.env.APP_URL || "https://chelgy.app").trim();

function num(v) { const n = Number(v); return isFinite(n) ? n : NaN; }
function okUrl(u, f) { return (typeof u === "string" && /^https?:\/\//.test(u)) ? u : f; }

async function stripe(path, params) {
  const r = await fetch("https://api.stripe.com/v1/" + path, {
    method: "POST",
    headers: { Authorization: "Bearer " + STRIPE_KEY, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, j };
}

// Re-quote against Gelato with the member's real address + artwork.
async function gelatoQuote(productUid, quantity, rc, fileUrl) {
  const body = {
    orderReferenceId: "quote-" + Date.now(),
    currency: "USD",
    allowMultipleQuotes: false,
    recipient: {
      country: (rc.country || "US").toUpperCase(),
      firstName: rc.firstName || "Member", lastName: rc.lastName || "Member",
      addressLine1: rc.addressLine1 || "", city: rc.city || "", state: rc.state || "",
      postCode: rc.postCode || "", email: rc.email || "orders@chelgy.app", phone: rc.phone || "",
    },
    products: [{ itemReferenceId: "i1", productUid, files: [{ type: "default", url: fileUrl }], quantity }],
  };
  const r = await fetch("https://order.gelatoapis.com/v4/orders:quote", {
    method: "POST", headers: { "Content-Type": "application/json", "X-API-KEY": GELATO_KEY }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return null;
  const quotes = Array.isArray(j.quotes) ? j.quotes : [];
  if (!quotes.length) return null;
  const q = quotes[0];
  let productSum = 0;
  for (const p of (q.products || [])) { const v = num(p.price != null ? p.price : (p.priceInclVat != null ? p.priceInclVat : p.amount)); if (!isFinite(v)) return null; productSum += v; }
  let best = null;
  for (const m of (q.shipmentMethods || [])) { const v = num(m.price != null ? m.price : (m.priceInclVat != null ? m.priceInclVat : m.amount)); if (!isFinite(v)) continue; if (!best || v < best.price) best = { price: v, uid: m.shipmentMethodUid || "standard" }; }
  if (!best) return null;
  return { base: Math.round((productSum + best.price) * 100) / 100, shipmentMethodUid: best.uid };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    if (!STRIPE_KEY || !GELATO_KEY || !SERVICE) return res.status(500).json({ error: "Printing isn't set up yet." });
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const token = (req.headers.authorization || "").replace(/^Bearer /, "").trim();
    if (!token) return res.status(401).json({ error: "Please sign in again." });

    const productUid = String(body.productUid || "").trim();
    const productLabel = String(body.productLabel || "Print").slice(0, 120);
    const quantity = Math.max(1, Math.min(500, parseInt(body.quantity, 10) || 1));
    const designUrl = String(body.designUrl || "").trim();
    const designBackUrl = String(body.designBackUrl || "").trim();
    const rc = body.recipient || {};
    if (!productUid) return res.status(400).json({ error: "Pick a product first." });
    if (!/^https?:\/\//.test(designUrl)) return res.status(400).json({ error: "Add your design first." });
    if (!rc.firstName || !rc.lastName || !rc.addressLine1 || !rc.city || !rc.postCode || !rc.country) {
      return res.status(400).json({ error: "Please fill in the full shipping address." });
    }

    // who is the member?
    const ures = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: ANON, Authorization: "Bearer " + token } });
    const user = await ures.json().catch(() => ({}));
    if (!user || !user.id) return res.status(401).json({ error: "Please sign in again." });

    // price it server-side
    const q = await gelatoQuote(productUid, quantity, rc, designUrl);
    if (!q) return res.status(400).json({ error: "Couldn't price that right now — check the address and try again." });
    const chargeCents = Math.round(withMargin(q.base) * 100);

    // save a pending order the webhook will fulfil
    const ins = await fetch(SB_URL + "/rest/v1/print_orders", {
      method: "POST",
      headers: { apikey: SERVICE, Authorization: "Bearer " + SERVICE, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({
        user_id: user.id, email: user.email || rc.email || null,
        product_uid: productUid, product_label: productLabel, quantity,
        design_url: designUrl, design_back_url: designBackUrl || null,
        amount_cents: chargeCents, base_cents: Math.round(q.base * 100), currency: "usd",
        recipient: rc, shipment_method_uid: q.shipmentMethodUid, status: "pending",
      }),
    });
    const rows = await ins.json().catch(() => []);
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row || !row.id) return res.status(500).json({ error: "Couldn't start that order — please try again." });

    // Stripe Checkout (pays Chelgy)
    const params = {};
    params["mode"] = "payment";
    params["success_url"] = okUrl(body.success_url, APP_URL + "/?print_ordered=1");
    params["cancel_url"] = okUrl(body.cancel_url, APP_URL + "/");
    params["line_items[0][price_data][currency]"] = "usd";
    params["line_items[0][price_data][product_data][name]"] = productLabel + " × " + quantity + " (printed & shipped)";
    params["line_items[0][price_data][unit_amount]"] = String(chargeCents);
    params["line_items[0][quantity]"] = "1";
    params["customer_email"] = user.email || rc.email || "";
    params["metadata[type]"] = "print";
    params["metadata[print_order_id]"] = String(row.id);

    const session = await stripe("checkout/sessions", params);
    if (!session.ok || !session.j.url) return res.status(502).json({ error: (session.j && session.j.error && session.j.error.message) || "Couldn't start checkout." });

    // note the session on the row (handy for reconciliation)
    try { await fetch(SB_URL + "/rest/v1/print_orders?id=eq." + encodeURIComponent(row.id), { method: "PATCH", headers: { apikey: SERVICE, Authorization: "Bearer " + SERVICE, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ session_id: session.j.id || null }) }); } catch {}

    return res.status(200).json({ url: session.j.url });
  } catch (e) {
    return res.status(500).json({ error: "Server error." });
  }
}
