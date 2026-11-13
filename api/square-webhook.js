// api/square-webhook.js — Square tells us a payment went through. The Square
// counterpart of the store/booking/invoice parts of api/stripe-webhook.js.
//
// Square calls this for every payment on every connected member's account. We check
// the request is genuinely from Square (signature), find whose account it was
// (merchant_id), read the order the payment belongs to with THEIR token, and act on
// the metadata our checkout put on it:
//   type "store"            -> record the sale in store_orders (like a Stripe store sale)
//   type "booking"          -> confirm the held slot
//   type "booking_balance"  -> record the balance as paid
//   type "invoice"          -> mark the Business Manager invoice paid
// Everything is keyed on the Square order id, so a webhook Square sends twice changes
// nothing the second time.
//
// Set up in the Square app's Webhooks page: URL https://chelgy.app/api/square-webhook,
// events payment.created and payment.updated.
//
// Env: SQUARE_WEBHOOK_SIGNATURE_KEY, SQUARE_WEBHOOK_URL (optional, if not the above),
//      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SQUARE_* (api/_square.js)
import { APP_URL, verifySquare, squareAccountByMerchant, squareToken, sq } from "./_square.js";
import { squareBookingPaid, squareBookingBalancePaid, squareInvoicePaid } from "./_square-pay.js";

export const config = { api: { bodyParser: false } };

const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_SVC = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const SVC = { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC };

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function addressLine(a) {
  if (!a) return null;
  const s = [a.address_line_1, a.address_line_2, a.locality, a.administrative_district_level_1, a.postal_code, a.country].filter(Boolean).join(", ");
  return s || null;
}

async function recordStoreOrder(payment, order, meta) {
  let items = [];
  try { items = JSON.parse(meta.items || "[]"); } catch {}
  if (!items.length && Array.isArray(order.line_items))
    items = order.line_items.map((l) => ({ n: String(l.name || "Item").slice(0, 40), q: parseInt(l.quantity, 10) || 1 }));
  const ship = payment.shipping_address || null;
  const name = ship ? [ship.first_name, ship.last_name].filter(Boolean).join(" ") : "";
  const row = {
    owner_id: meta.owner_id,
    session_id: "sq:" + order.id,
    customer_email: payment.buyer_email_address || null,
    amount_total: payment.total_money ? payment.total_money.amount : (payment.amount_money ? payment.amount_money.amount : null),
    currency: String((payment.total_money && payment.total_money.currency) || "USD").toLowerCase(),
    application_fee: meta.fee ? parseInt(meta.fee, 10) : (payment.app_fee_money ? payment.app_fee_money.amount : null),
    items,
    shipping_name: name || null,
    shipping_address: addressLine(ship),
    status: "paid",
  };
  await fetch(SB_URL + "/rest/v1/store_orders", {
    method: "POST",
    headers: { ...SVC, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(row),
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  let raw;
  try { raw = await readRaw(req); } catch { return res.status(400).json({ error: "no body" }); }
  const url = (process.env.SQUARE_WEBHOOK_URL || (APP_URL + "/api/square-webhook")).trim();
  if (!verifySquare(raw, req.headers["x-square-hmacsha256-signature"], url)) return res.status(400).json({ error: "Invalid signature" });

  let event;
  try { event = JSON.parse(raw); } catch { return res.status(400).json({ error: "bad json" }); }

  try {
    const type = String(event.type || "");
    const payment = event.data && event.data.object && event.data.object.payment;
    if ((type === "payment.created" || type === "payment.updated") && payment && payment.status === "COMPLETED" && payment.order_id) {
      const acct = await squareAccountByMerchant(event.merchant_id || payment.merchant_id || "");
      const token = acct ? await squareToken(acct) : null;
      if (token) {
        const o = await sq("/v2/orders/" + encodeURIComponent(payment.order_id), { token });
        const order = o.ok && o.j.order;
        const meta = (order && order.metadata) || {};
        // Only orders our own checkouts made, and only for the member they belong to.
        if (order && meta.owner_id && meta.owner_id === acct.user_id) {
          if (meta.type === "store") await recordStoreOrder(payment, order, meta);
          else if (meta.type === "booking" && meta.booking_id) await squareBookingPaid(payment, order, meta, acct, token);
          else if (meta.type === "booking_balance" && meta.booking_id) await squareBookingBalancePaid(payment, order, meta, acct);
          else if (meta.type === "invoice" && meta.invoice_id) await squareInvoicePaid(payment, order, meta, acct);
        }
      }
    }
  } catch (e) {
    // Answer 500 so Square tries again later; everything above is safe to repeat.
    console.error("[square-webhook] " + ((e && e.message) || e));
    return res.status(500).json({ error: "retry" });
  }
  return res.status(200).json({ received: true });
}
