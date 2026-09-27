// api/calendar-sync.js — Vercel cron (every 10 min): re-read every connected calendar so
// the owner's busy times keep blocking booking slots. Oldest-synced first, time-boxed.
import { sb, normalizeCalendar } from "./_booking-lib.js";
import { refreshFeed } from "./_calendar-lib.js";

const STALE_MINUTES = 8, BATCH = 150, CONCURRENCY = 6, TIME_BUDGET_MS = 45000;

export default async function handler(req, res) {
  const secret = (process.env.CRON_SECRET || "").trim();
  if (!secret || (req.headers.authorization || "") !== "Bearer " + secret) return res.status(401).json({ error: "unauthorized" });
  const t0 = Date.now();
  const cutoff = new Date(Date.now() - STALE_MINUTES * 60000).toISOString();
  const q = await sb("calendar_feeds?select=id,site_id,url,last_synced&or=(last_synced.is.null,last_synced.lt." + encodeURIComponent(cutoff) + ")&order=last_synced.asc.nullsfirst&limit=" + BATCH);
  const feeds = Array.isArray(q.j) ? q.j : [];
  const tzCache = {};
  const tzFor = async siteId => {
    if (!(siteId in tzCache)) {
      const w = await sb("websites?select=data&id=eq." + encodeURIComponent(siteId) + "&limit=1");
      const d = Array.isArray(w.j) && w.j[0] && w.j[0].data;
      tzCache[siteId] = normalizeCalendar(((d && d.sections) || []).find(x => x && x.type === "calendar") || {}).tz;
    }
    return tzCache[siteId];
  };
  let done = 0, failed = 0, i = 0;
  const worker = async () => { while (i < feeds.length && Date.now() - t0 < TIME_BUDGET_MS) { const f = feeds[i++]; try { const r = await refreshFeed(f, await tzFor(f.site_id)); if (r.error) failed++; else done++; } catch { failed++; } } };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return res.status(200).json({ checked: done + failed, ok: done, failed, remaining: feeds.length - done - failed });
}
