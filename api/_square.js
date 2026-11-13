// api/_square.js — everything Square, shared by the Square endpoints and the checkout
// endpoints that can take a payment through it.
//
// HOW SQUARE FITS NEXT TO STRIPE
// A member connects their own Square account (OAuth, like "Connect Stripe"). Their
// tokens live in square_accounts, readable only with the service-role key. When a
// shopper pays, the sale goes straight to the member's Square account, and Chelgy's
// 5% is taken as Square's app fee (the same 5% the Stripe path keeps).
//
// Which one a checkout uses: Stripe when that's all they have, Square when that's all
// they have, and when both are connected, whichever they picked ("Use Square for
// checkout" — square_accounts.preferred).
//
// Env: SQUARE_APP_ID, SQUARE_APP_SECRET, SQUARE_WEBHOOK_SIGNATURE_KEY,
//      SQUARE_ENV ("production", or "sandbox" while testing), SUPABASE_URL,
//      SUPABASE_SERVICE_ROLE_KEY, SHOPIFY_APP_URL / APP_URL
import crypto from "node:crypto";

export const SQ_APP_ID = (process.env.SQUARE_APP_ID || "").trim();
const SQ_SECRET = (process.env.SQUARE_APP_SECRET || "").trim();
export const SQ_SANDBOX = (process.env.SQUARE_ENV || "production").trim().toLowerCase() === "sandbox";
export const SQ_BASE = SQ_SANDBOX ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
const SQ_VERSION = "2026-09-16";
export const APP_URL = (process.env.SHOPIFY_APP_URL || process.env.APP_URL || "https://chelgy.app").trim().replace(/\/+$/, "");
export const SQ_REDIRECT = APP_URL + "/api/square-callback";
const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_SVC = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const SVC = { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC };

export const squareConfigured = () => !!(SQ_APP_ID && SQ_SECRET);

// What Chelgy asks to be allowed to do on a member's Square account: take payments
// (with Chelgy's fee on top, which is what ADDITIONAL_RECIPIENTS is), make the order
// each payment belongs to, and read their business name and locations.
export const SQ_SCOPES = ["MERCHANT_PROFILE_READ", "PAYMENTS_READ", "PAYMENTS_WRITE",
  "PAYMENTS_WRITE_ADDITIONAL_RECIPIENTS", "ORDERS_READ", "ORDERS_WRITE", "CUSTOMERS_READ", "CUSTOMERS_WRITE"];

// ── the OAuth "state": who started the connection, signed so it can't be forged ──
export function signState(userId) {
  const body = userId + "." + Date.now().toString(36) + "." + crypto.randomBytes(6).toString("base64url");
  const mac = crypto.createHmac("sha256", SQ_SECRET).update(body).digest("base64url");
  return body + "." + mac;
}
export function readState(state) {
  try {
    const parts = String(state || "").split(".");
    if (parts.length !== 4) return null;
    const body = parts.slice(0, 3).join(".");
    const want = crypto.createHmac("sha256", SQ_SECRET).update(body).digest("base64url");
    if (want.length !== parts[3].length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(parts[3]))) return null;
    if (Date.now() - parseInt(parts[1], 36) > 60 * 60 * 1000) return null;   // an hour to finish
    return parts[0];
  } catch { return null; }
}

// ── Square's API ──
export async function sq(path, { token, method = "GET", body } = {}) {
  try {
    const r = await fetch(SQ_BASE + path, {
      method,
      headers: { Authorization: "Bearer " + token, "Square-Version": SQ_VERSION, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, j };
  } catch (e) { return { ok: false, status: 0, j: { errors: [{ detail: String((e && e.message) || e) }] } }; }
}
export const sqError = (r, fallback) =>
  (r && r.j && Array.isArray(r.j.errors) && r.j.errors[0] && (r.j.errors[0].detail || r.j.errors[0].code)) || fallback;

export async function exchangeToken(params) {
  const r = await fetch(SQ_BASE + "/oauth2/token", {
    method: "POST",
    headers: { "Square-Version": SQ_VERSION, "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: SQ_APP_ID, client_secret: SQ_SECRET, ...params }),
  });
  const j = await r.json().catch(() => ({}));
  return r.ok && j.access_token ? j : null;
}

// ── the member's account row ──
export async function squareAccount(userId) {
  try {
    const r = await fetch(SB_URL + "/rest/v1/square_accounts?select=*&user_id=eq." + encodeURIComponent(userId) + "&limit=1", { headers: SVC });
    const rows = r.ok ? await r.json() : [];
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch { return null; }
}
export async function squareAccountByMerchant(merchantId) {
  try {
    const r = await fetch(SB_URL + "/rest/v1/square_accounts?select=*&merchant_id=eq." + encodeURIComponent(merchantId) + "&limit=1", { headers: SVC });
    const rows = r.ok ? await r.json() : [];
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch { return null; }
}
export async function saveSquareAccount(row) {
  const r = await fetch(SB_URL + "/rest/v1/square_accounts", {
    method: "POST",
    headers: { ...SVC, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ ...row, updated_at: new Date().toISOString() }),
  });
  return r.ok;
}
export async function patchSquareAccount(userId, fields) {
  try {
    await fetch(SB_URL + "/rest/v1/square_accounts?user_id=eq." + encodeURIComponent(userId), {
      method: "PATCH",
      headers: { ...SVC, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
    });
  } catch {}
}

// A usable access token. Square's last 30 days; the refresh token doesn't expire, so a
// token near its end is swapped for a fresh one here, on the way to being used.
export async function squareToken(acct) {
  if (!acct || !acct.access_token) return null;
  const exp = Date.parse(acct.expires_at || "") || 0;
  if (exp && exp - Date.now() > 3 * 24 * 3600 * 1000) return acct.access_token;
  if (!acct.refresh_token) return acct.access_token;
  const t = await exchangeToken({ grant_type: "refresh_token", refresh_token: acct.refresh_token });
  if (!t) return exp > Date.now() ? acct.access_token : null;
  await patchSquareAccount(acct.user_id, { access_token: t.access_token, refresh_token: t.refresh_token || acct.refresh_token, expires_at: t.expires_at || null });
  return t.access_token;
}

// The location payments go to: the main one that can take cards.
export async function pickLocation(token) {
  const r = await sq("/v2/locations", { token });
  const locs = (r.ok && Array.isArray(r.j.locations)) ? r.j.locations : [];
  const usable = locs.filter((l) => l.status === "ACTIVE" && (!Array.isArray(l.capabilities) || l.capabilities.includes("CREDIT_CARD_PROCESSING")));
  const loc = usable.find((l) => l.type === "PHYSICAL") || usable[0] || locs[0] || null;
  return loc ? { id: loc.id, name: loc.business_name || loc.name || "", currency: loc.currency || "USD", country: loc.country || "US" } : null;
}

// Should this member's checkout go through Square? Returns the ready account or null.
export async function squareForCheckout(userId, stripeReady) {
  if (!squareConfigured()) return null;
  const acct = await squareAccount(userId);
  if (!acct || !acct.charges_enabled || !acct.location_id) return null;
  if (stripeReady && !acct.preferred) return null;
  return acct;
}

// ONE PAYMENT LINK: a Square-hosted checkout page for `lines`, paid to the member,
// with Chelgy's fee on top. `meta` rides on the order (Square keeps up to 10 short
// strings) and is how the webhook knows what was paid for.
//   lines: [{ name, cents, qty }]
export async function squarePaymentLink(acct, { lines, feeCents = 0, meta = {}, redirectUrl, email, askShipping = false, note }) {
  const token = await squareToken(acct);
  if (!token) return { error: "This Square account needs reconnecting." };
  const currency = String(acct.currency || "USD").toUpperCase();
  const metadata = {};
  for (const [k, v] of Object.entries(meta).slice(0, 10)) if (v != null && v !== "") metadata[String(k).slice(0, 60)] = String(v).slice(0, 255);
  const body = {
    idempotency_key: crypto.randomUUID(),
    order: {
      location_id: acct.location_id,
      line_items: lines.map((l) => ({ name: String(l.name || "Item").slice(0, 500), quantity: String(Math.max(1, l.qty || 1)),
                                      base_price_money: { amount: Math.round(l.cents), currency } })),
      metadata,
      ...(note ? { ticket_name: String(note).slice(0, 30) } : {}),
    },
    checkout_options: {
      ...(redirectUrl ? { redirect_url: String(redirectUrl).slice(0, 2048) } : {}),
      ...(askShipping ? { ask_for_shipping_address: true } : {}),
      ...(feeCents > 0 ? { app_fee_money: { amount: Math.round(feeCents), currency } } : {}),
    },
    ...(email ? { pre_populated_data: { buyer_email: String(email).slice(0, 255) } } : {}),
  };
  const r = await sq("/v2/online-checkout/payment-links", { token, method: "POST", body });
  const link = r.ok && r.j.payment_link;
  if (!link || !link.url) return { error: sqError(r, "Couldn't start the Square checkout.") };
  return { url: link.long_url || link.url, orderId: link.order_id || null, linkId: link.id || null };
}

// A webhook from Square is genuinely from Square: base64 HMAC-SHA256 of the
// notification URL followed by the raw body, keyed with the subscription's signature key.
export function verifySquare(raw, sig, url) {
  const key = (process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || "").trim();
  if (!key || !sig) return false;
  const want = crypto.createHmac("sha256", key).update(url + raw).digest("base64");
  const a = Buffer.from(want), b = Buffer.from(String(sig));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
