// api/invoice-checkout.js — create a Stripe Checkout link to pay a Business Manager invoice.
//
// A member sends their client a "Pay now" link for an invoice. The charge is a
// DESTINATION CHARGE to the member's own connected Stripe account (same setup as
// the store). The amount is recomputed SERVER-SIDE from the saved invoice, so the
// client can't tamper with it. Reuses the same env + stripe_accounts table as
// api/stripe-checkout.js — no new configuration needed.
//
// Env: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SHOPIFY_APP_URL / APP_URL

const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_SVC = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const STRIPE_KEY = (process.env.STRIPE_SECRET_KEY || "").trim();
const APP_URL = (process.env.SHOPIFY_APP_URL || process.env.APP_URL || "https://chelgy.app").trim();

// Chelgy's cut of each invoice paid through the app, in basis points.
// 0 = the member keeps 100%. Set to 500 to take 5% (like the store), etc.
const INVOICE_FEE_BPS = 0;

async function stripe(path, params) {
  const r = await fetch("https://api.stripe.com/v1/" + path, {
    method: "POST",
    headers: { Authorization: "Bearer " + STRIPE_KEY, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, j };
}
function okUrl(u, fallback) {
  return (typeof u === "string" && /^https?:\/\//.test(u)) ? u : fallback;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    if (!STRIPE_KEY) return res.status(500).json({ error: "Payments aren't configured yet." });
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const token = String(body.access_token || "").trim();
    const invoiceId = String(body.invoice_id || "").trim();
    if (!token || !invoiceId) return res.status(400).json({ error: "Missing details." });

    // 1) resolve the member from their access token
    const uq = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_SVC, Authorization: "Bearer " + token } });
    const u = await uq.json().catch(() => ({}));
    const ownerId = u && u.id;
    if (!ownerId) return res.status(401).json({ error: "Please sign in again." });

    const svc = { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC };

    // 2) load the invoice and confirm it belongs to this member
    const iq = await fetch(SB_URL + "/rest/v1/bm_invoices?select=*&id=eq." + encodeURIComponent(invoiceId) + "&user_id=eq." + ownerId, { headers: svc });
    const irows = await iq.json();
    const inv = Array.isArray(irows) && irows[0];
    if (!inv) return res.status(404).json({ error: "Invoice not found." });

    // 3) is the member set up to take payments? (same table as the store)
    const aq = await fetch(SB_URL + "/rest/v1/stripe_accounts?select=account_id,charges_enabled&user_id=eq." + ownerId, { headers: svc });
    const arows = await aq.json();
    const acct = Array.isArray(arows) && arows[0];
    if (!acct || !acct.account_id || !acct.charges_enabled) return res.status(400).json({ error: "Connect your Stripe account first to accept payments." });

    // 4) recompute the amount from the saved invoice (never trust the client)
    const items = Array.isArray(inv.items) ? inv.items : [];
    let subtotal = 0;
    for (const it of items) { subtotal += (Number(it && it.qty) || 0) * (Number(it && it.price) || 0); }
    const total = subtotal + subtotal * ((Number(inv.tax) || 0) / 100);
    const cents = Math.round(total * 100);
    if (cents <= 0) return res.status(400).json({ error: "This invoice has no payable amount." });
    const currency = String(inv.currency || "usd").toLowerCase();

    // 5) one-line Checkout session, destination charge to the member's account
    const params = {};
    params["mode"] = "payment";
    params["success_url"] = okUrl(body.success_url, APP_URL + "/?inv_paid=" + invoiceId);
    params["cancel_url"] = okUrl(body.cancel_url, APP_URL + "/");
    params["line_items[0][price_data][currency]"] = currency;
    params["line_items[0][price_data][product_data][name]"] = ("Invoice " + (inv.number || "") + (inv.client_name ? " · " + inv.client_name : "")).slice(0, 120);
    params["line_items[0][price_data][unit_amount]"] = String(cents);
    params["line_items[0][quantity]"] = "1";
    params["payment_intent_data[transfer_data][destination]"] = acct.account_id;
    const fee = Math.round(cents * INVOICE_FEE_BPS / 10000);
    if (fee > 0) params["payment_intent_data[application_fee_amount]"] = String(fee);
    params["metadata[type]"] = "invoice";
    params["metadata[invoice_id]"] = invoiceId;
    params["metadata[owner_id]"] = ownerId;

    const session = await stripe("checkout/sessions", params);
    if (!session.ok || !session.j.url) return res.status(502).json({ error: (session.j && session.j.error && session.j.error.message) || "Couldn't start checkout." });
    return res.status(200).json({ url: session.j.url });
  } catch (e) {
    return res.status(500).json({ error: "Server error." });
  }
}
