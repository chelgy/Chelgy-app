// api/booking-slots.js — open appointment times for a site's Calendar section.
// GET ?slug=<site>&section=<index>&service=<index>&from=YYYY-MM-DD&days=<n>
// Public (it's a published site). Only returns start times — never who booked.
import { loadCalendar, releaseStaleHolds, busyBetween, slotsForDate, localDate, addDays, zonedToUtc } from "./_booking-lib.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const q = req.query || {};
    const slug = String(q.slug || "").trim();
    if (!slug) return res.status(400).json({ error: "Missing site." });
    const cal = await loadCalendar(slug, q.section);
    if (cal.error) return res.status(cal.status || 400).json({ error: cal.error });
    const { cfg, site, sectionIndex } = cal;

    const services = cfg.services.map(s => ({ index: s.index, name: s.name, desc: s.desc, duration: s.duration, price: s.price, pay: s.pay, charge: s.charge, balance: s.balance }));
    const svcIdx = parseInt(q.service, 10);
    const service = cfg.services[svcIdx >= 0 ? svcIdx : 0];
    if (!service) return res.status(200).json({ tz: cfg.tz, section: sectionIndex, services, days: [] });

    const now = Date.now();
    const today = localDate(now, cfg.tz);
    let from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || "") ? q.from : today;
    if (from < today) from = today;
    const days = Math.min(62, Math.max(1, parseInt(q.days, 10) || 35));
    const last = addDays(from, days - 1);

    await releaseStaleHolds(site.id);
    const busy = await busyBetween(site.id, zonedToUtc(from, "00:00", cfg.tz) - 86400000, zonedToUtc(last, "23:59", cfg.tz) + 86400000);
    const out = [];
    for (let d = from; d <= last; d = addDays(d, 1)) {
      const slots = slotsForDate(cfg, service, d, busy, now);
      out.push({ date: d, slots: slots.map(ms => new Date(ms).toISOString()) });
    }
    return res.status(200).json({ tz: cfg.tz, section: sectionIndex, service: service.index, services, days: out });
  } catch (e) {
    return res.status(500).json({ error: "Couldn't load times. Please try again." });
  }
}
