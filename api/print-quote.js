// api/print-quote.js — live price for a print-on-demand product via Gelato,
// with Chelgy's margin added. Used to show the member a total before they pay.
//
// Body: { productUid, quantity, recipient: { country, city?, state?, postCode?, addressLine1? } }
// Returns: { ok, currency, amount (member price, dollars), baseCents, shipmentMethodUid }
//
// Env: GELATO_API_KEY  (required)
//      PRINT_MARKUP_PCT (opt, default 50)  PRINT_MARKUP_MIN_USD (opt, default 3)

const GELATO_KEY = (process.env.GELATO_API_KEY || "").trim();
const MARKUP_PCT = (parseFloat(process.env.PRINT_MARKUP_PCT || "50") || 50) / 100;
const MARKUP_MIN = parseFloat(process.env.PRINT_MARKUP_MIN_USD || "3") || 3;
function withMargin(base) { const m = Math.max(base * MARKUP_PCT, MARKUP_MIN); return Math.round((base + m) * 100) / 100; }

// Pricing doesn't depend on the real artwork, so a sample file is fine for a quote.
const SAMPLE_FILE = "https://cdn-origin.gelato-api-dashboard.ie.live.gelato.tech/docs/sample-print-files/logo.png";

function num(v) { const n = Number(v); return isFinite(n) ? n : NaN; }

// Given a Gelato quote response, return { base, shipmentMethodUid } for the
// cheapest shipping option, or null if it can't be read.
function readQuote(j) {
  const quotes = (j && Array.isArray(j.quotes)) ? j.quotes : [];
  if (!quotes.length) return null;
  const q = quotes[0];
  const products = Array.isArray(q.products) ? q.products : [];
  let productSum = 0;
  for (const p of products) {
    const price = num(p.price != null ? p.price : (p.priceInclVat != null ? p.priceInclVat : p.amount));
    if (!isFinite(price)) return null;
    productSum += price;
  }
  const methods = Array.isArray(q.shipmentMethods) ? q.shipmentMethods : [];
  let best = null;
  for (const m of methods) {
    const price = num(m.price != null ? m.price : (m.priceInclVat != null ? m.priceInclVat : m.amount));
    if (!isFinite(price)) continue;
    if (!best || price < best.price) best = { price, uid: m.shipmentMethodUid || "standard" };
  }
  if (!best) return null;
  return { base: Math.round((productSum + best.price) * 100) / 100, shipmentMethodUid: best.uid };
}

export async function quoteGelato(productUid, quantity, recipient) {
  const rc = recipient || {};
  const body = {
    orderReferenceId: "quote-" + Date.now(),
    currency: "USD",
    allowMultipleQuotes: false,
    recipient: {
      country: (rc.country || "US").toUpperCase(),
      firstName: rc.firstName || "Chelgy",
      lastName: rc.lastName || "Member",
      addressLine1: rc.addressLine1 || "1 Main St",
      city: rc.city || "New York",
      state: rc.state || "",
      postCode: rc.postCode || "10001",
      email: rc.email || "orders@chelgy.app",
      phone: rc.phone || "",
    },
    products: [
      { itemReferenceId: "i1", productUid, files: [{ type: "default", url: SAMPLE_FILE }], quantity: quantity },
    ],
  };
  const r = await fetch("https://order.gelatoapis.com/v4/orders:quote", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": GELATO_KEY },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { error: (j && j.message) || "Couldn't price that right now." };
  const parsed = readQuote(j);
  if (!parsed) return { error: "Couldn't price that right now." };
  return parsed;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    if (!GELATO_KEY) return res.status(500).json({ error: "Printing isn't set up yet." });
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const productUid = String(body.productUid || "").trim();
    const quantity = Math.max(1, Math.min(500, parseInt(body.quantity, 10) || 1));
    if (!productUid) return res.status(400).json({ error: "Pick a product first." });

    const q = await quoteGelato(productUid, quantity, body.recipient || {});
    if (q.error) return res.status(400).json({ error: q.error });
    return res.status(200).json({
      ok: true,
      currency: "USD",
      amount: withMargin(q.base),
      baseCents: Math.round(q.base * 100),
      shipmentMethodUid: q.shipmentMethodUid,
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error." });
  }
}
