// api/booking-checkout.js — book an appointment from a site's Calendar section.
// POST { slug, section, service, start (ISO), name, email, phone, notes, success_url, cancel_url }
//   Free service  → booking is confirmed immediately, emails sent.
//   Paid service  → slot is HELD (pending) and the customer goes to Stripe Checkout.
//                   The webhook confirms it when payment lands; an abandoned checkout
//                   releases the hold (Stripe "expired" event, the release link, or time).
// POST { action:"release", booking_id, token } → customer backed out of Stripe; free the slot now.
//
// Double booking is prevented by the database itself (bookings_no_overlap constraint),
// so even two simultaneous requests for the same time can't both succeed.
import crypto from "crypto";
import { loadCalendar, releaseStaleHolds, busyBetween, slotsForDate, localDate, formatWhen, connectedAccount, feeFor,
  sb, stripe, sendBookingEmails, ipHash, okUrl, body as readBody, HOLD_MINUTES, HOLD_GRACE_MINUTES,
  MAX_PENDING_PER_IP, MAX_FREE_PER_IP_PER_DAY, STRIPE_KEY } from "./_booking-lib.js";

const APP_URL = (process.env.SHOPIFY_APP_URL || process.env.APP_URL || "https://chelgy.app").trim();
const releaseToken = id => crypto.createHmac("sha256", STRIPE_KEY || "chelgy").update("release:" + id).digest("hex").slice(0, 32);
const withParam = (u, k, v) => u + (u.includes("?") ? "&" : "?") + k + "=" + encodeURIComponent(v);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const b = readBody(req);

    // ── customer backed out of Stripe → release their hold right away ──
    if (b.action === "release") {
      const id = String(b.booking_id || "");
      const tok = String(b.token || "");
      if (!id || tok.length !== 32 || !crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(releaseToken(id)))) return res.status(400).json({ error: "Invalid link." });
      const q = await sb("bookings?select=id,status,session_id&id=eq." + encodeURIComponent(id) + "&limit=1");
      const row = Array.isArray(q.j) && q.j[0];
      if (row && row.status === "pending") {
        if (row.session_id) await stripe("checkout/sessions/" + encodeURIComponent(row.session_id) + "/expire", {});
        await sb("bookings?id=eq." + encodeURIComponent(id) + "&status=eq.pending", { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "expired" }) });
      }
      return res.status(200).json({ ok: true });
    }

    // ── validate the request ──
    const slug = String(b.slug || "").trim();
    const name = String(b.name || "").trim().slice(0, 120);
    const email = String(b.email || "").trim().toLowerCase().slice(0, 200);
    const phone = String(b.phone || "").trim().slice(0, 40);
    const notes = String(b.notes || "").trim().slice(0, 1000);
    const startMs = Date.parse(b.start || "");
    if (!slug || !isFinite(startMs)) return res.status(400).json({ error: "Please pick a time." });
    if (!name) return res.status(400).json({ error: "Please enter your name." });
    if (!EMAIL.test(email)) return res.status(400).json({ error: "Please enter a valid email." });

    const cal = await loadCalendar(slug, b.section);
    if (cal.error) return res.status(cal.status || 400).json({ error: cal.error });
    const { cfg, site, sectionIndex, brand } = cal;
    const service = cfg.services[parseInt(b.service, 10)];
    if (!service) return res.status(400).json({ error: "Please pick a service." });

    // The time must be one we'd actually offer right now (server-side, from saved settings).
    await releaseStaleHolds(site.id);
    const date = localDate(startMs, cfg.tz);
    const busy = await busyBetween(site.id, startMs - 86400000, startMs + 2 * 86400000);
    if (!slotsForDate(cfg, service, date, busy, Date.now()).includes(startMs)) {
      return res.status(409).json({ error: "That time was just taken or isn't available. Please pick another.", code: "slot_taken" });
    }

    // Anti-hoarding: one visitor can't hold every slot.
    const ip = ipHash(req);
    const paid = service.charge > 0;
    if (paid) {
      const since = new Date(Date.now() - (HOLD_MINUTES + HOLD_GRACE_MINUTES) * 60000).toISOString();
      const c = await sb("bookings?select=id&site_id=eq." + encodeURIComponent(site.id) + "&ip_hash=eq." + ip + "&status=eq.pending&created_at=gt." + encodeURIComponent(since));
      if (Array.isArray(c.j) && c.j.length >= MAX_PENDING_PER_IP) return res.status(429).json({ error: "You have a few bookings waiting for payment. Finish or cancel one first." });
    } else {
      const since = new Date(Date.now() - 86400000).toISOString();
      const c = await sb("bookings?select=id&site_id=eq." + encodeURIComponent(site.id) + "&ip_hash=eq." + ip + "&created_at=gt." + encodeURIComponent(since));
      if (Array.isArray(c.j) && c.j.length >= MAX_FREE_PER_IP_PER_DAY) return res.status(429).json({ error: "Too many bookings from this device today. Please contact the business directly." });
    }

    let account = null;
    if (paid) {
      account = await connectedAccount(site.user_id);
      if (!account) return res.status(400).json({ error: "This business isn't set up to take payments yet. Please contact them directly." });
    }

    // ── create the booking row (the database refuses overlaps) ──
    const endMs = startMs + service.duration * 60000;
    const holdUntil = Date.now() + (HOLD_MINUTES + 1) * 60000;
    const row = {
      site_id: String(site.id), owner_id: site.user_id, section_index: sectionIndex, service_index: service.index,
      service_name: service.name, duration_min: service.duration,
      start_at: new Date(startMs).toISOString(), end_at: new Date(endMs).toISOString(), block_end: new Date(endMs + cfg.buffer * 60000).toISOString(),
      tz: cfg.tz, customer_name: name, customer_email: email, customer_phone: phone || null, notes: notes || null,
      status: paid ? "pending" : "confirmed", pay_mode: service.pay, price_cents: service.price,
      balance_due_cents: paid ? service.price - service.charge : service.price, fee_cents: paid ? feeFor(service.charge) : 0,
      ip_hash: ip, expires_at: paid ? new Date(holdUntil).toISOString() : null, confirmed_at: paid ? null : new Date().toISOString(),
    };
    const ins = await sb("bookings", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
    const booking = Array.isArray(ins.j) && ins.j[0];
    if (!ins.ok || !booking) {
      const conflict = ins.status === 409 || (ins.j && (ins.j.code === "23P01" || ins.j.code === "23505"));
      return res.status(conflict ? 409 : 500).json({ error: conflict ? "That time was just taken. Please pick another." : "Couldn't save your booking. Please try again.", code: conflict ? "slot_taken" : undefined });
    }

    const siteUrl = site.custom_domain ? "https://" + site.custom_domain : APP_URL + "/?site=" + encodeURIComponent(site.slug);
    const successBase = okUrl(b.success_url, siteUrl);
    const cancelBase = okUrl(b.cancel_url, siteUrl);

    if (!paid) {
      await sendBookingEmails(booking, brand.name);
      return res.status(200).json({ ok: true, confirmed: true, booking_id: booking.id, when: formatWhen(startMs, cfg.tz) });
    }

    // ── paid: Stripe Checkout (destination charge to the business, Chelgy keeps its fee) ──
    const p = {
      mode: "payment",
      "payment_method_types[0]": "card",
      customer_email: email,
      success_url: withParam(successBase, "booked", booking.id),
      cancel_url: withParam(withParam(cancelBase, "booking_release", booking.id), "t", releaseToken(booking.id)),
      expires_at: String(Math.floor(Date.now() / 1000) + HOLD_MINUTES * 60 + 30),
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(service.charge),
      "line_items[0][price_data][product_data][name]": (service.pay === "deposit" ? "Deposit — " : "") + service.name,
      "line_items[0][price_data][product_data][description]": formatWhen(startMs, cfg.tz) + (brand.name ? " · " + brand.name : ""),
      "payment_intent_data[application_fee_amount]": String(row.fee_cents),
      "payment_intent_data[transfer_data][destination]": account,
      "payment_intent_data[metadata][booking_id]": booking.id,
      "metadata[type]": "booking",
      "metadata[booking_id]": booking.id,
    };
    if (service.pay === "deposit") {
      // Save the card so the owner can collect the balance later with one click.
      p.customer_creation = "always";
      p["payment_intent_data[setup_future_usage]"] = "off_session";
    }
    const session = await stripe("checkout/sessions", p);
    if (!session.ok || !session.j.url) {
      await sb("bookings?id=eq." + encodeURIComponent(booking.id), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "failed" }) });
      return res.status(502).json({ error: (session.j && session.j.error && session.j.error.message) || "Couldn't start checkout. Please try again." });
    }
    await sb("bookings?id=eq." + encodeURIComponent(booking.id), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ session_id: session.j.id }) });
    return res.status(200).json({ ok: true, url: session.j.url, booking_id: booking.id });
  } catch (e) {
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
}
