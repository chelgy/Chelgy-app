// api/booking-manage.js — the business owner's booking actions (signed in).
// POST { action, ... }  Authorization: Bearer <user access token>
//   list            { site_id?, scope?: "upcoming"|"past"|"all" }
//   cancel          { booking_id, refund: true|false }   refund = give back everything paid
//   complete        { booking_id }
//   charge_balance  { booking_id }  charge the card saved at booking; if the bank needs the
//                                   customer (or no card is saved), email them a pay link instead
//   send_balance_link { booking_id }
import { sb, getUser, stripe, refundIntent, feeFor, connectedAccount, sendEmail, emailHtml, money, formatWhen, ownerEmail, body as readBody } from "./_booking-lib.js";

const APP_URL = (process.env.SHOPIFY_APP_URL || process.env.APP_URL || "https://chelgy.app").trim();
const COLS = "id,site_id,section_index,service_index,service_name,duration_min,start_at,end_at,tz,customer_name,customer_email,customer_phone,notes,status,pay_mode,currency,price_cents,amount_paid_cents,balance_due_cents,refunded_cents,payment_method,created_at,confirmed_at,completed_at,cancelled_at";

async function mine(userId, id) {
  const q = await sb("bookings?select=*&id=eq." + encodeURIComponent(id || "x") + "&owner_id=eq." + encodeURIComponent(userId) + "&limit=1");
  return Array.isArray(q.j) && q.j[0] ? q.j[0] : null;
}
async function patch(id, fields) {
  return sb("bookings?id=eq." + encodeURIComponent(id), { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(fields) });
}
async function siteInfo(siteId) {
  const q = await sb("websites?select=slug,custom_domain,data&id=eq." + encodeURIComponent(siteId) + "&limit=1");
  const s = Array.isArray(q.j) && q.j[0];
  return { name: (s && s.data && s.data.brand && s.data.brand.name) || "", url: s ? (s.custom_domain ? "https://" + s.custom_domain : APP_URL + "/?site=" + encodeURIComponent(s.slug)) : APP_URL };
}

async function balanceLink(b, account) {
  const site = await siteInfo(b.site_id);
  const s = await stripe("checkout/sessions", {
    mode: "payment", "payment_method_types[0]": "card", customer_email: b.customer_email,
    success_url: site.url + (site.url.includes("?") ? "&" : "?") + "balance_paid=" + b.id,
    cancel_url: site.url,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": b.currency || "usd",
    "line_items[0][price_data][unit_amount]": String(b.balance_due_cents),
    "line_items[0][price_data][product_data][name]": "Balance — " + b.service_name,
    "line_items[0][price_data][product_data][description]": formatWhen(Date.parse(b.start_at), b.tz) + (site.name ? " · " + site.name : ""),
    "payment_intent_data[application_fee_amount]": String(feeFor(b.balance_due_cents)),
    "payment_intent_data[transfer_data][destination]": account,
    "payment_intent_data[metadata][booking_id]": b.id,
    "metadata[type]": "booking_balance", "metadata[booking_id]": b.id,
  });
  if (!s.ok || !s.j.url) return null;
  await patch(b.id, { balance_session_id: s.j.id });
  const oEmail = await ownerEmail(b.owner_id);
  await sendEmail({ to: b.customer_email, replyTo: oEmail || undefined, subject: "Balance for your " + b.service_name + (site.name ? " — " + site.name : ""),
    html: emailHtml("Your remaining balance", [["Service", b.service_name], ["When", formatWhen(Date.parse(b.start_at), b.tz)], ["Balance due", money(b.balance_due_cents, b.currency)]],
      `<a href="${s.j.url}" style="display:inline-block;background:#171512;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px">Pay ${money(b.balance_due_cents, b.currency)}</a>`) });
  return s.j.url;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const b = readBody(req);
    const token = (b.access_token || (req.headers.authorization || "").replace(/^Bearer\s+/i, "")).trim();
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: "Please log in again." });

    if (b.action === "list") {
      let url = "bookings?select=" + COLS + "&owner_id=eq." + encodeURIComponent(user.id) + "&status=in.(confirmed,completed,cancelled)";
      if (b.site_id) url += "&site_id=eq." + encodeURIComponent(b.site_id);
      const now = new Date(Date.now() - 3 * 3600000).toISOString();
      if (b.scope === "upcoming") url += "&start_at=gte." + encodeURIComponent(now) + "&order=start_at.asc";
      else if (b.scope === "past") url += "&start_at=lt." + encodeURIComponent(now) + "&order=start_at.desc";
      else url += "&order=start_at.desc";
      const q = await sb(url + "&limit=500");
      return res.status(200).json({ bookings: Array.isArray(q.j) ? q.j.map(x => ({ ...x, has_card: !!x.payment_method, payment_method: undefined })) : [] });
    }

    const bk = await mine(user.id, b.booking_id);
    if (!bk) return res.status(404).json({ error: "Booking not found." });

    if (b.action === "complete") {
      if (bk.status !== "confirmed") return res.status(400).json({ error: "Only confirmed bookings can be marked done." });
      const r = await patch(bk.id, { status: "completed", completed_at: new Date().toISOString() });
      return res.status(200).json({ ok: true, booking: r.j && r.j[0] });
    }

    if (b.action === "cancel") {
      if (!["confirmed", "completed"].includes(bk.status)) return res.status(400).json({ error: "This booking can't be cancelled." });
      let refunded = 0;
      if (b.refund) {
        // Refund everything paid (deposit/full + any balance). Chelgy's fee is kept, since Stripe keeps its own.
        for (const pi of [bk.payment_intent, bk.balance_intent].filter(Boolean)) {
          const r = await refundIntent(pi);
          if (r.ok && r.j && typeof r.j.amount === "number") refunded += r.j.amount;
          else if (!(r.j && r.j.error && /already been refunded/i.test(r.j.error.message || ""))) return res.status(502).json({ error: (r.j && r.j.error && r.j.error.message) || "Refund failed — nothing was cancelled. Try again." });
        }
      }
      const r = await patch(bk.id, { status: "cancelled", cancelled_at: new Date().toISOString(), refunded_cents: (bk.refunded_cents || 0) + refunded, balance_due_cents: 0 });
      const site = await siteInfo(bk.site_id);
      await sendEmail({ to: bk.customer_email, replyTo: user.email || undefined, subject: "Your booking was cancelled" + (site.name ? " — " + site.name : ""),
        html: emailHtml("Your booking was cancelled", [["Service", bk.service_name], ["Was", formatWhen(Date.parse(bk.start_at), bk.tz)], refunded ? ["Refunded", money(refunded, bk.currency)] : null],
          refunded ? "Refunds usually reach your card in 5–10 business days." : "Reply to this email if you have questions.") });
      return res.status(200).json({ ok: true, refunded_cents: refunded, booking: r.j && r.j[0] });
    }

    if (b.action === "charge_balance" || b.action === "send_balance_link") {
      if (!["confirmed", "completed"].includes(bk.status)) return res.status(400).json({ error: "This booking isn't active." });
      if (!(bk.balance_due_cents > 0)) return res.status(400).json({ error: "Nothing left to pay." });
      if (bk.balance_due_cents < 50) return res.status(400).json({ error: "The balance is too small to charge by card." });
      const account = await connectedAccount(user.id);
      if (!account) return res.status(400).json({ error: "Connect Stripe first (Website → Orders) to collect payments." });

      if (b.action === "charge_balance" && bk.stripe_customer && bk.payment_method) {
        const pi = await stripe("payment_intents", {
          amount: String(bk.balance_due_cents), currency: bk.currency || "usd",
          customer: bk.stripe_customer, payment_method: bk.payment_method, off_session: "true", confirm: "true",
          application_fee_amount: String(feeFor(bk.balance_due_cents)), "transfer_data[destination]": account,
          description: "Balance — " + bk.service_name, "metadata[booking_id]": bk.id, "metadata[type]": "booking_balance",
        });
        if (pi.ok && pi.j.status === "succeeded") {
          const r = await patch(bk.id, { amount_paid_cents: (bk.amount_paid_cents || 0) + bk.balance_due_cents, balance_due_cents: 0, balance_intent: pi.j.id });
          const site = await siteInfo(bk.site_id);
          await sendEmail({ to: bk.customer_email, replyTo: user.email || undefined, subject: "Receipt — " + bk.service_name + (site.name ? " — " + site.name : ""),
            html: emailHtml("Payment received", [["Service", bk.service_name], ["When", formatWhen(Date.parse(bk.start_at), bk.tz)], ["Charged", money(bk.balance_due_cents, bk.currency)], ["Total paid", money((bk.amount_paid_cents || 0) + bk.balance_due_cents, bk.currency)]], "Thank you!") });
          return res.status(200).json({ ok: true, charged_cents: bk.balance_due_cents, booking: r.j && r.j[0] });
        }
        // Bank wants the customer to approve, or the card was declined → fall through to a pay link.
      }
      const url = await balanceLink(bk, account);
      if (!url) return res.status(502).json({ error: "Couldn't create a payment link. Try again." });
      return res.status(200).json({ ok: true, link_sent: true, url });
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    return res.status(500).json({ error: "Server error." });
  }
}
