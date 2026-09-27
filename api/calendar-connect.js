// api/calendar-connect.js — the owner connects calendars to their booking section (signed in).
// POST { action, ... }  Authorization: Bearer <user access token>
//   list      { site_id }                       connected calendars for this site
//   add       { site_id, url, label? }          check the link works, then connect it
//   remove    { id }
//   sync      { site_id }                       refresh now
//   feed_link { reset? }                        private subscribe link for all your bookings
import crypto from "crypto";
import { sb, getUser, normalizeCalendar, body as readBody } from "./_booking-lib.js";
import { fetchIcs, parseBusy, normalizeFeedUrl, refreshFeed } from "./_calendar-lib.js";

const APP_URL = (process.env.SHOPIFY_APP_URL || process.env.APP_URL || "https://chelgy.app").trim().replace(/\/+$/, "");
const MAX_FEEDS_PER_SITE = 5;
const mask = u => { try { const p = new URL(u); return p.hostname + "/…" + p.pathname.slice(-6); } catch { return "calendar"; } };
const guessLabel = u => { const h = (() => { try { return new URL(u).hostname; } catch { return ""; } })();
  return /google/.test(h) ? "Google Calendar" : /icloud|apple/.test(h) ? "Apple Calendar" : /outlook|office|live\.com|microsoft/.test(h) ? "Outlook" : "Calendar"; };

async function ownSite(userId, siteId) {
  const q = await sb("websites?select=id,data&id=eq." + encodeURIComponent(siteId || "x") + "&user_id=eq." + encodeURIComponent(userId) + "&limit=1");
  return Array.isArray(q.j) && q.j[0] ? q.j[0] : null;
}
function siteTz(site) {
  const sec = ((site.data && site.data.sections) || []).find(x => x && x.type === "calendar");
  return normalizeCalendar(sec || {}).tz;
}
const view = f => ({ id: f.id, label: f.label, where: mask(f.url), last_synced: f.last_synced, error: f.last_error, busy_count: Array.isArray(f.busy) ? f.busy.length : 0 });

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const b = readBody(req);
    const token = (b.access_token || (req.headers.authorization || "").replace(/^Bearer\s+/i, "")).trim();
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: "Please log in again." });

    if (b.action === "feed_link") {
      let tok = null;
      if (!b.reset) { const q = await sb("booking_feed_tokens?select=token&owner_id=eq." + encodeURIComponent(user.id) + "&limit=1"); tok = Array.isArray(q.j) && q.j[0] && q.j[0].token; }
      if (!tok) {
        tok = crypto.randomBytes(20).toString("hex");
        const up = await sb("booking_feed_tokens", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ owner_id: user.id, token: tok, created_at: new Date().toISOString() }) });
        if (!up.ok) return res.status(500).json({ error: "Couldn't create your link. Try again." });
      }
      const https = APP_URL + "/api/booking-feed?t=" + tok;
      const webcal = https.replace(/^https?:\/\//, "webcal://");
      return res.status(200).json({ url: https, webcal, google: "https://calendar.google.com/calendar/r?cid=" + encodeURIComponent(webcal) });
    }

    if (b.action === "remove") {
      await sb("calendar_feeds?id=eq." + encodeURIComponent(b.id || "x") + "&owner_id=eq." + encodeURIComponent(user.id), { method: "DELETE", headers: { Prefer: "return=minimal" } });
      return res.status(200).json({ ok: true });
    }

    const site = await ownSite(user.id, b.site_id);
    if (!site) return res.status(404).json({ error: "Site not found." });
    const siteId = String(site.id);
    const list = async () => { const q = await sb("calendar_feeds?select=*&site_id=eq." + encodeURIComponent(siteId) + "&owner_id=eq." + encodeURIComponent(user.id) + "&order=created_at.asc"); return Array.isArray(q.j) ? q.j : []; };

    if (b.action === "list") return res.status(200).json({ feeds: (await list()).map(view) });

    if (b.action === "add") {
      const url = normalizeFeedUrl(b.url);
      if (!url) return res.status(400).json({ error: "Paste the private calendar link — it starts with https:// or webcal://" });
      const existing = await list();
      if (existing.some(f => f.url === url)) return res.status(400).json({ error: "That calendar is already connected." });
      if (existing.length >= MAX_FEEDS_PER_SITE) return res.status(400).json({ error: "You can connect up to " + MAX_FEEDS_PER_SITE + " calendars." });
      const got = await fetchIcs(url);
      if (got.error) return res.status(400).json({ error: got.error });
      const parsed = parseBusy(got.text, siteTz(site));
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      const ins = await sb("calendar_feeds", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({
        owner_id: user.id, site_id: siteId, url, label: String(b.label || guessLabel(url)).slice(0, 60), busy: parsed.busy, last_synced: new Date().toISOString(), last_error: null }) });
      if (!ins.ok) return res.status(500).json({ error: "Couldn't save that calendar. Try again." });
      return res.status(200).json({ ok: true, feeds: (await list()).map(view) });
    }

    if (b.action === "sync") {
      const tz = siteTz(site);
      for (const f of await list()) await refreshFeed(f, tz);
      return res.status(200).json({ ok: true, feeds: (await list()).map(view) });
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    return res.status(500).json({ error: "Server error." });
  }
}
