// api/booking-feed.js — private calendar feed of an owner's bookings.
// GET ?t=<secret token>  →  text/calendar (subscribe in Google / Apple / Outlook)
// The token comes from api/calendar-connect.js (action feed_link) and can be reset there.
import { sb, icsCalendar, money } from "./_booking-lib.js";

export default async function handler(req, res) {
  const t = String((req.query && req.query.t) || "").replace(/\.ics$/i, "");
  if (!/^[a-f0-9]{40}$/.test(t)) return res.status(404).end();
  const q = await sb("booking_feed_tokens?select=owner_id&token=eq." + t + "&limit=1");
  const owner = Array.isArray(q.j) && q.j[0] && q.j[0].owner_id;
  if (!owner) return res.status(404).end();
  const since = new Date(Date.now() - 60 * 86400000).toISOString();
  const b = await sb("bookings?select=id,start_at,end_at,service_name,customer_name,customer_email,customer_phone,notes,balance_due_cents,amount_paid_cents,currency,created_at" +
    "&owner_id=eq." + encodeURIComponent(owner) + "&status=in.(confirmed,completed)&start_at=gte." + encodeURIComponent(since) + "&order=start_at.asc&limit=3000");
  const rows = Array.isArray(b.j) ? b.j : [];
  const ics = icsCalendar("Chelgy bookings", rows.map(x => ({
    uid: x.id + "@chelgy.app", stamp: Date.parse(x.created_at) || Date.now(), start: Date.parse(x.start_at), end: Date.parse(x.end_at),
    summary: x.customer_name + " — " + x.service_name,
    description: [x.customer_email, x.customer_phone, x.notes ? "Notes: " + x.notes : "", x.amount_paid_cents ? "Paid: " + money(x.amount_paid_cents, x.currency) : "", x.balance_due_cents ? "Balance due: " + money(x.balance_due_cents, x.currency) : ""].filter(Boolean).join("\n"),
  })));
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", 'inline; filename="chelgy-bookings.ics"');
  res.setHeader("Cache-Control", "private, max-age=300");
  return res.status(200).send(ics);
}
