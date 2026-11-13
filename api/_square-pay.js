// api/_square-pay.js — bookings and invoices paid through Square: what the Stripe
// webhook's confirmBooking / payBookingBalance / markInvoicePaid do, for a Square
// payment, plus refunds and pulling a payment link back.
//
// Square ids are stored in the same columns Stripe's use, prefixed "sq:" so every
// path can tell them apart:
//   bookings.session_id      "sq:<order id>:<payment link id>"
//   bookings.payment_intent  "sq:<payment id>"      (the deposit or full payment)
//   bookings.balance_intent  "sq:<payment id>"      (the balance)
import crypto from "node:crypto";
import { sb, sendBookingEmails, sendEmail, emailHtml, money, formatWhen, ownerEmail } from "./_booking-lib.js";
import { sq, sqError, squareAccount, squareToken } from "./_square.js";

export const isSquareId = (v) => typeof v === "string" && v.indexOf("sq:") === 0;
const payId = (v) => String(v || "").slice(3);
const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_SVC = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

// Square never lets the developer's fee be more than 90% of the payment.
export const squareFee = (fee, amount) => Math.max(0, Math.min(Math.round(fee || 0), Math.floor((amount || 0) * 0.9)));

async function bookingRow(id) {
  const q = await sb("bookings?select=*&id=eq." + encodeURIComponent(id || "x") + "&limit=1");
  return Array.isArray(q.j) && q.j[0] ? q.j[0] : null;
}
async function brandName(siteId) {
  const q = await sb("websites?select=data&id=eq." + encodeURIComponent(siteId) + "&limit=1");
  const w = Array.isArray(q.j) && q.j[0];
  return (w && w.data && w.data.brand && w.data.brand.name) || "";
}
const paidCents = (payment) => (payment.total_money ? payment.total_money.amount : (payment.amount_money ? payment.amount_money.amount : 0)) || 0;

// Give back everything still unrefunded on one Square payment. The seller covers it and
// Chelgy keeps its fee, the same as the Stripe path (refund_application_fee: false).
export async function squareRefund(acct, paymentRef, reason) {
  const token = await squareToken(acct);
  if (!token) return { ok: false, error: "Square needs reconnecting." };
  const p = await sq("/v2/payments/" + encodeURIComponent(payId(paymentRef)), { token });
  const pay = p.ok && p.j.payment;
  if (!pay) return { ok: false, error: sqError(p, "Couldn't find that Square payment.") };
  const total = paidCents(pay), done = (pay.refunded_money && pay.refunded_money.amount) || 0;
  const left = total - done;
  if (left <= 0) return { ok: true, amount: 0, already: true };
  const r = await sq("/v2/refunds", { token, method: "POST", body: {
    idempotency_key: crypto.createHash("sha256").update("refund:" + pay.id + ":" + done).digest("hex").slice(0, 45),
    payment_id: pay.id, amount_money: { amount: left, currency: (pay.total_money || pay.amount_money).currency },
    ...(reason ? { reason: String(reason).slice(0, 192) } : {}),
  } });
  if (!r.ok) return { ok: false, error: sqError(r, "Square refund failed.") };
  return { ok: true, amount: left };
}

// A booking hold the customer backed out of: take its payment link down so it can't be
// paid after the time has gone to someone else.
export async function squareDropLink(ownerId, sessionId) {
  try {
    const linkId = String(sessionId || "").split(":")[2];
    if (!linkId) return;
    const acct = await squareAccount(ownerId);
    const token = acct ? await squareToken(acct) : null;
    if (token) await sq("/v2/online-checkout/payment-links/" + encodeURIComponent(linkId), { token, method: "DELETE" });
  } catch {}
}

// Payment landed → confirm the held slot (confirmBooking, for Square). Idempotent. If
// the hold lapsed and someone else took the time, refund in full and tell the customer.
export async function squareBookingPaid(payment, order, meta, acct) {
  const row = await bookingRow(meta.booking_id);
  if (!row || row.owner_id !== acct.user_id) return;
  const ref = "sq:" + payment.id;
  if (["confirmed", "completed", "cancelled"].includes(row.status) && row.payment_intent === ref) return;
  const up = await sb("bookings?id=eq." + encodeURIComponent(row.id) + "&status=in.(pending,expired)", {
    method: "PATCH", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status: "confirmed", confirmed_at: new Date().toISOString(), expires_at: null,
      session_id: row.session_id && isSquareId(row.session_id) ? row.session_id : "sq:" + order.id,
      amount_paid_cents: paidCents(payment) || row.amount_paid_cents, payment_intent: ref,
      stripe_customer: null, payment_method: null }),
  });
  const done = up.ok && Array.isArray(up.j) && up.j[0];
  if (done) { await sendBookingEmails(done, await brandName(done.site_id)); return; }
  const now = await bookingRow(row.id);
  if (now && now.status === "confirmed") return;
  // The time is gone → refund in full (the customer got nothing).
  await squareRefund(acct, ref, "That time was no longer available");
  await sb("bookings?id=eq." + encodeURIComponent(row.id), { method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status: "failed", payment_intent: ref, refunded_cents: paidCents(payment) }) });
  const nm = await brandName(row.site_id), oe = await ownerEmail(row.owner_id);
  await sendEmail({ to: row.customer_email, replyTo: oe || undefined, subject: "That time was no longer available — you've been refunded",
    html: emailHtml("Sorry — that time was taken", [["Service", row.service_name], ["Time", formatWhen(Date.parse(row.start_at), row.tz)], ["Refunded", money(paidCents(payment), row.currency)]],
      "Your payment took longer than the hold on that time, and someone else booked it in the meantime. You've been fully refunded" + (nm ? " — please book another time with " + nm : "") + ".") });
}

// Balance paid through the emailed Square link (payBookingBalance, for Square).
export async function squareBookingBalancePaid(payment, order, meta, acct) {
  const row = await bookingRow(meta.booking_id);
  if (!row || row.owner_id !== acct.user_id) return;
  const ref = "sq:" + payment.id;
  if (row.balance_intent === ref) return;
  const amt = paidCents(payment);
  await sb("bookings?id=eq." + encodeURIComponent(row.id), { method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ amount_paid_cents: (row.amount_paid_cents || 0) + amt, balance_due_cents: Math.max(0, (row.balance_due_cents || 0) - amt), balance_intent: ref }) });
  const nm = await brandName(row.site_id), oe = await ownerEmail(row.owner_id);
  await sendEmail({ to: row.customer_email, replyTo: oe || undefined, subject: "Receipt — " + row.service_name + (nm ? " — " + nm : ""),
    html: emailHtml("Payment received", [["Service", row.service_name], ["When", formatWhen(Date.parse(row.start_at), row.tz)], ["Paid", money(amt, row.currency)]], "Thank you!") });
  if (oe) await sendEmail({ to: oe, subject: "Balance paid: " + row.customer_name + " — " + money(amt, row.currency),
    html: emailHtml("Balance paid", [["Customer", row.customer_name], ["Service", row.service_name], ["Amount", money(amt, row.currency)]]) });
}

// A Business Manager invoice paid through Square → mark it paid (markInvoicePaid).
export async function squareInvoicePaid(payment, order, meta, acct) {
  await fetch(SB_URL + "/rest/v1/bm_invoices?id=eq." + encodeURIComponent(meta.invoice_id) + "&user_id=eq." + encodeURIComponent(acct.user_id), {
    method: "PATCH",
    headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ status: "paid", paid_at: new Date().toISOString() }),
  });
}
