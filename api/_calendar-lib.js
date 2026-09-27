// api/_calendar-lib.js — calendar sync for the booking section.
//   Inbound:  read an owner's private calendar link (Google / Apple / Outlook .ics) and turn it
//             into busy time ranges that block booking slots.
//   (Writing .ics files lives in _booking-lib.js — it needs no parser.)
import ICAL from "ical.js";
import dns from "dns/promises";
import net from "net";
import { zonedToUtc, sb } from "./_booking-lib.js";

export const SYNC_PAST_DAYS = 1;
export const SYNC_AHEAD_DAYS = 180;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_OCCURRENCES = 3000;      // per recurring event
const MAX_INTERVALS = 8000;        // per feed

// ---------- safe fetch (the URL is user-supplied: never let it reach private networks) ----------
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:") && privateIp(v.slice(7));
}
export function normalizeFeedUrl(raw) {
  let u = String(raw || "").trim();
  if (/^webcals?:\/\//i.test(u)) u = "https://" + u.replace(/^webcals?:\/\//i, "");
  let p; try { p = new URL(u); } catch { return null; }
  if (p.protocol !== "https:" || p.username || p.password || net.isIP(p.hostname.replace(/^\[|\]$/g, "")) || !p.hostname.includes(".")) return null;
  return p.toString();
}
async function hostIsPublic(host) {
  try { const addrs = await dns.lookup(host, { all: true }); return addrs.length > 0 && addrs.every(a => !privateIp(a.address)); } catch { return false; }
}
export async function fetchIcs(rawUrl) {
  let url = normalizeFeedUrl(rawUrl);
  if (!url) return { error: "That doesn't look like a calendar link. It should start with https:// or webcal://" };
  for (let hop = 0; hop < 4; hop++) {
    const host = new URL(url).hostname;
    if (!(await hostIsPublic(host))) return { error: "That calendar link can't be reached." };
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 9000);
    let r;
    try { r = await fetch(url, { redirect: "manual", signal: ac.signal, headers: { "User-Agent": "Chelgy-Calendar/1.0", Accept: "text/calendar,*/*" } }); }
    catch { clearTimeout(timer); return { error: "Couldn't reach that calendar link." }; }
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      clearTimeout(timer);
      const next = normalizeFeedUrl(new URL(r.headers.get("location"), url).toString());
      if (!next) return { error: "That calendar link redirects somewhere unsafe." };
      url = next; continue;
    }
    if (!r.ok) { clearTimeout(timer); return { error: r.status === 404 || r.status === 403 || r.status === 401 ? "That calendar link isn't shared (or was reset). Copy it again." : "The calendar service returned an error (" + r.status + ")." }; }
    const reader = r.body && r.body.getReader ? r.body.getReader() : null;
    let text = "";
    try {
      if (reader) { const dec = new TextDecoder(); let n = 0; for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; if (n > MAX_BYTES) { ac.abort(); return { error: "That calendar is too large to sync." }; } text += dec.decode(value, { stream: true }); } text += dec.decode(); }
      else text = await r.text();
    } catch { return { error: "Couldn't read that calendar." }; }
    finally { clearTimeout(timer); }
    if (!/BEGIN:VCALENDAR/i.test(text)) return { error: "That link isn't a calendar file. Use the private/secret iCal (.ics) address." };
    return { text, url };
  }
  return { error: "Too many redirects." };
}

// ---------- inbound: .ics → busy [startMs, endMs] ranges ----------
function validTz(tz) { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0); return true; } catch { return false; } }
function pad(n) { return String(n).padStart(2, "0"); }
function timeToMs(t, fallbackTz) {
  // UTC or a timezone defined in the file → ical.js resolves it exactly.
  const tzid = t.zone && t.zone.tzid;
  if (tzid === "UTC" || (tzid && tzid !== "floating")) return t.toJSDate().getTime();
  // Floating (no zone) or an unknown TZID → treat as wall-clock time in the named zone if it's
  // a real IANA name, otherwise in the business's own time zone.
  const named = t.timezone && validTz(t.timezone) ? t.timezone : fallbackTz;
  return zonedToUtc(t.year + "-" + pad(t.month) + "-" + pad(t.day), pad(t.hour) + ":" + pad(t.minute), named) + t.second * 1000;
}
function dateToMs(t, tz) { return zonedToUtc(t.year + "-" + pad(t.month) + "-" + pad(t.day), "00:00", tz); }

export function parseBusy(text, businessTz, nowMs) {
  const now = nowMs || Date.now();
  const winStart = now - SYNC_PAST_DAYS * 86400000, winEnd = now + SYNC_AHEAD_DAYS * 86400000;
  let root;
  try { root = new ICAL.Component(ICAL.parse(text)); } catch { return { error: "That calendar file couldn't be read." }; }
  root.getAllSubcomponents("vtimezone").forEach(tz => { try { ICAL.TimezoneService.register(tz); } catch { } });
  const vevents = root.getAllSubcomponents("vevent");
  // group modified single occurrences (RECURRENCE-ID) with their series
  const overrides = {}, masters = [];
  vevents.forEach(v => { const uid = v.getFirstPropertyValue("uid") || ""; if (v.hasProperty("recurrence-id")) (overrides[uid] = overrides[uid] || []).push(v); else masters.push(v); });
  const busy = [];
  const push = (s, e) => { if (e > s && e > winStart && s < winEnd && busy.length < MAX_INTERVALS) busy.push([s, e]); };
  const blocks = comp => {
    const transp = String(comp.getFirstPropertyValue("transp") || "").toUpperCase();
    const status = String(comp.getFirstPropertyValue("status") || "").toUpperCase();
    return transp !== "TRANSPARENT" && status !== "CANCELLED";
  };
  const span = (start, end) => {
    if (start.isDate) { const s = dateToMs(start, businessTz); const e = end ? dateToMs(end, businessTz) : s + 86400000; return [s, Math.max(e, s + 86400000)]; }
    const s = timeToMs(start, businessTz); const e = end ? timeToMs(end, businessTz) : s; return [s, e];
  };
  for (const v of masters) {
    let ev;
    try { ev = new ICAL.Event(v, { strictExceptions: false, exceptions: overrides[v.getFirstPropertyValue("uid") || ""] || [] }); } catch { continue; }
    try {
      if (!ev.isRecurring()) { if (blocks(v)) { const [s, e] = span(ev.startDate, ev.endDate); push(s, e); } continue; }
      const it = ev.iterator(); let next, n = 0;
      while ((next = it.next()) && n++ < MAX_OCCURRENCES) {
        const d = ev.getOccurrenceDetails(next);
        const [s, e] = span(d.startDate, d.endDate);
        if (s >= winEnd) break;
        const comp = d.item && d.item.component ? d.item.component : v;
        if (blocks(comp)) push(s, e);
      }
    } catch { /* one malformed event shouldn't break the whole calendar */ }
  }
  // Overrides whose series is missing from the file (Google exports these) still block time.
  Object.keys(overrides).forEach(uid => {
    if (masters.some(m => (m.getFirstPropertyValue("uid") || "") === uid)) return;
    overrides[uid].forEach(v => { try { const ev = new ICAL.Event(v); if (blocks(v)) { const [s, e] = span(ev.startDate, ev.endDate); push(s, e); } } catch { } });
  });
  busy.sort((a, b) => a[0] - b[0]);
  // merge overlaps to keep storage small
  const merged = [];
  busy.forEach(r => { const last = merged[merged.length - 1]; if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push([r[0], r[1]]); });
  return { busy: merged, events: vevents.length };
}

// Re-read one connected calendar and store its busy times (or the error to show the owner).
export async function refreshFeed(feed, tz) {
  const got = await fetchIcs(feed.url);
  const parsed = got.error ? got : parseBusy(got.text, tz);
  const fields = parsed.error ? { last_error: parsed.error, last_synced: new Date().toISOString() }
    : { busy: parsed.busy, last_error: null, last_synced: new Date().toISOString() };
  await sb("calendar_feeds?id=eq." + encodeURIComponent(feed.id), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(fields) });
  return parsed;
}
