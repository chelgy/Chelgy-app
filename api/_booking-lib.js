// api/_booking-lib.js — shared logic for the Calendar / booking section.
// (Files starting with "_" are not exposed as endpoints by Vercel; they're imported.)
//
// Everything that decides money or availability is computed HERE, on the server, from the
// site's saved data. The browser only ever sends "which service, which time, who you are".
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, STRIPE_SECRET_KEY,
//      RESEND_API_KEY (same as domain reminders), REMINDER_FROM (sender; BOOKING_FROM overrides)

import crypto from "crypto";

export const SB_URL = (process.env.SUPABASE_URL || "").trim();
export const SB_SVC = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
export const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
export const STRIPE_KEY = (process.env.STRIPE_SECRET_KEY || "").trim();

export const HOLD_MINUTES = 30;          // Stripe Checkout's minimum session lifetime
export const HOLD_GRACE_MINUTES = 5;     // extra time before an unpaid hold is released
export const MAX_PENDING_PER_IP = 3;     // stops one visitor from holding every slot
export const MAX_FREE_PER_IP_PER_DAY = 5;

// ---------------- fees ----------------
// Chelgy keeps 5%, but never less than Stripe's own cost (2.9% + 30¢) plus 30¢, so a small
// deposit can never cost Chelgy money. Never more than the payment itself.
export function feeFor(cents) {
  const a = Math.max(0, Math.round(cents || 0));
  if (!a) return 0;
  const pct = Math.round(a * 0.05);
  const floor = Math.round(a * 0.029) + 60;
  return Math.min(a, Math.max(pct, floor));
}

export function cents(v) {
  const n = parseFloat(String(v == null ? "" : v).replace(/[^0-9.]/g, ""));
  return isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

// ---------------- config ----------------
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
function clampInt(v, lo, hi, dflt) { const n = parseInt(v, 10); return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; }
function ranges(list) {
  return (Array.isArray(list) ? list : [])
    .filter(r => Array.isArray(r) && HHMM.test(r[0] || "") && HHMM.test(r[1] || "") && r[0] < r[1])
    .map(r => [r[0], r[1]]);
}
export function validTz(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0); return true; } catch { return false; }
}
// Turns whatever is saved in the calendar section into a safe, complete config.
export function normalizeCalendar(sec) {
  const s = sec || {};
  const hours = {};
  DAYS.forEach(d => { hours[d] = ranges(s.hours && s.hours[d]); });
  const services = (Array.isArray(s.services) ? s.services : []).map((v, i) => {
    const price = cents(v && v.price);
    let pay = ["none", "full", "deposit"].includes(v && v.pay) ? v.pay : (price ? "full" : "none");
    if (!price) pay = "none";
    let deposit = 0;
    if (pay === "deposit") {
      deposit = (v.depositType === "percent")
        ? Math.round(price * Math.min(100, Math.max(1, parseFloat(v.deposit) || 0)) / 100)
        : cents(v.deposit);
      deposit = Math.min(price, deposit);
      if (deposit < 100) pay = price >= 100 ? "full" : "none"; // Stripe can't charge under $1 sensibly
      if (deposit >= price) pay = "full";
    }
    const charge = pay === "full" ? price : pay === "deposit" ? deposit : 0;
    return {
      index: i,
      name: String((v && v.name) || "Appointment").slice(0, 120),
      desc: String((v && v.desc) || "").slice(0, 400),
      duration: clampInt(v && v.duration, 5, 12 * 60, 60),
      price, pay, deposit: pay === "deposit" ? deposit : 0, charge,
      balance: pay === "deposit" ? price - deposit : 0,
    };
  });
  const dates = {};
  (Array.isArray(s.dates) ? s.dates : []).forEach(x => {
    if (x && /^\d{4}-\d{2}-\d{2}$/.test(x.date || "")) dates[x.date] = x.closed ? [] : ranges(x.ranges);
  });
  (Array.isArray(s.blocked) ? s.blocked : []).forEach(d => { if (/^\d{4}-\d{2}-\d{2}$/.test(d || "")) dates[d] = []; });
  return {
    tz: validTz(s.tz) ? s.tz : "America/New_York",
    services,
    hours,
    dates,                                          // per-date override: [] = closed, ranges = open these hours
    interval: clampInt(s.interval, 5, 240, 30),     // minutes between start times
    buffer: clampInt(s.buffer, 0, 240, 0),          // minutes blocked after each appointment
    notice: clampInt(s.notice, 0, 24 * 30, 12),     // hours of notice required
    horizon: clampInt(s.horizon, 1, 365, 60),       // days ahead customers can book
  };
}

// ---------------- time zones ----------------
function tzOffsetMs(ms, tz) {
  const p = {};
  new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - (ms - (ms % 1000));
}
// Local wall-clock time in `tz` → UTC milliseconds (DST-safe).
export function zonedToUtc(dateStr, hhmm, tz) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - tzOffsetMs(guess, tz);
  const o2 = tzOffsetMs(t, tz);
  t = guess - o2;
  return t;
}
// UTC ms → local "YYYY-MM-DD" in tz
export function localDate(ms, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function dow(dateStr) { const [y, m, d] = dateStr.split("-").map(Number); return DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]; }
function hm(mins) { return String(Math.floor(mins / 60)).padStart(2, "0") + ":" + String(mins % 60).padStart(2, "0"); }
function mins(hhmm) { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; }
export function formatWhen(ms, tz) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(ms));
}

// ---------------- availability ----------------
// Open start times (UTC ms) for one service on one local date.
//   busy: [{start:ms, blockEnd:ms}] existing active bookings on this site
export function slotsForDate(cfg, service, dateStr, busy, nowMs) {
  const today = localDate(nowMs, cfg.tz);
  if (dateStr < today || dateStr > addDays(today, cfg.horizon)) return [];
  const open = Object.prototype.hasOwnProperty.call(cfg.dates, dateStr) ? cfg.dates[dateStr] : cfg.hours[dow(dateStr)];
  const earliest = nowMs + cfg.notice * 3600000;
  const out = [];
  (open || []).forEach(([a, b]) => {
    for (let m = mins(a); m + service.duration <= mins(b); m += cfg.interval) {
      const start = zonedToUtc(dateStr, hm(m), cfg.tz);
      const end = start + service.duration * 60000;
      const blockEnd = end + cfg.buffer * 60000;
      if (start < earliest) continue;
      if (busy.some(x => start < x.blockEnd && blockEnd > x.start)) continue;
      out.push(start);
    }
  });
  return [...new Set(out)].sort((x, y) => x - y);
}

// ---------------- Supabase ----------------
export function svcHeaders(extra) { return { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, ...(extra || {}) }; }
export async function sb(path, opts) {
  const r = await fetch(SB_URL + "/rest/v1/" + path, { ...(opts || {}), headers: svcHeaders({ "Content-Type": "application/json", ...((opts && opts.headers) || {}) }) });
  const text = await r.text();
  let j = null; try { j = text ? JSON.parse(text) : null; } catch { j = text; }
  return { ok: r.ok, status: r.status, j };
}
export async function getUser(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, Authorization: "Bearer " + token } });
    const u = await r.json();
    return r.ok && u && u.id ? u : null;
  } catch { return null; }
}
export async function ownerEmail(userId) {
  try {
    const r = await fetch(SB_URL + "/auth/v1/admin/users/" + encodeURIComponent(userId), { headers: svcHeaders() });
    const u = await r.json();
    return (u && (u.email || (u.user && u.user.email))) || null;
  } catch { return null; }
}
// Loads a published site + one of its calendar sections.
export async function loadCalendar(slug, sectionIndex) {
  const q = await sb("websites?select=id,user_id,slug,custom_domain,data&slug=eq." + encodeURIComponent(slug) + "&limit=1");
  const site = Array.isArray(q.j) && q.j[0];
  if (!site) return { error: "Site not found.", status: 404 };
  const secs = (site.data && Array.isArray(site.data.sections)) ? site.data.sections : [];
  let idx = parseInt(sectionIndex, 10);
  if (!(idx >= 0 && secs[idx] && secs[idx].type === "calendar")) idx = secs.findIndex(x => x && x.type === "calendar");
  if (idx < 0) return { error: "This site doesn't take bookings.", status: 404 };
  return { site, sectionIndex: idx, section: secs[idx], cfg: normalizeCalendar(secs[idx]), brand: (site.data && site.data.brand) || {} };
}
// Releases unpaid holds whose checkout window has passed.
export async function releaseStaleHolds(siteId) {
  const cutoff = new Date(Date.now() - HOLD_GRACE_MINUTES * 60000).toISOString();
  await sb("bookings?site_id=eq." + encodeURIComponent(siteId) + "&status=eq.pending&expires_at=lt." + encodeURIComponent(cutoff), {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "expired" }),
  });
}
export async function busyBetween(siteId, fromMs, toMs) {
  const q = await sb("bookings?select=start_at,block_end,status,expires_at&site_id=eq." + encodeURIComponent(siteId) +
    "&status=in.(pending,confirmed)&start_at=lt." + encodeURIComponent(new Date(toMs).toISOString()) +
    "&block_end=gt." + encodeURIComponent(new Date(fromMs).toISOString()));
  const graceMs = HOLD_GRACE_MINUTES * 60000;
  return (Array.isArray(q.j) ? q.j : [])
    .filter(b => b.status === "confirmed" || !b.expires_at || Date.parse(b.expires_at) + graceMs > Date.now())
    .map(b => ({ start: Date.parse(b.start_at), blockEnd: Date.parse(b.block_end) }));
}
export async function connectedAccount(userId) {
  const q = await sb("stripe_accounts?select=account_id,charges_enabled&user_id=eq." + encodeURIComponent(userId) + "&limit=1");
  const a = Array.isArray(q.j) && q.j[0];
  return a && a.account_id && a.charges_enabled ? a.account_id : null;
}

// ---------------- Stripe ----------------
export async function stripe(path, params, method) {
  const m = method || (params ? "POST" : "GET");
  const url = "https://api.stripe.com/v1/" + path + (m === "GET" && params ? "?" + new URLSearchParams(params).toString() : "");
  const r = await fetch(url, {
    method: m,
    headers: { Authorization: "Bearer " + STRIPE_KEY, "Content-Type": "application/x-www-form-urlencoded" },
    body: m === "GET" ? undefined : new URLSearchParams(params || {}).toString(),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, j };
}
export async function refundIntent(pi, amount) {
  if (!pi) return { ok: false };
  const p = { payment_intent: pi, reverse_transfer: "true", refund_application_fee: "false" };
  if (amount) p.amount = String(amount);
  return stripe("refunds", p);
}

// ---------------- email ----------------
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
export function money(c, cur) { return new Intl.NumberFormat("en-US", { style: "currency", currency: (cur || "usd").toUpperCase() }).format((c || 0) / 100); }
export function emailHtml(title, rows, foot) {
  const tr = rows.filter(r => r && r[1] != null && r[1] !== "").map(r =>
    `<tr><td style="padding:8px 0;color:#7a7266;font-size:13px;width:140px;vertical-align:top">${esc(r[0])}</td><td style="padding:8px 0;color:#171512;font-size:15px">${esc(r[1])}</td></tr>`).join("");
  return `<!doctype html><html><body style="margin:0;background:#f6f2ea;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:32px 20px"><div style="background:#fff;border-radius:10px;padding:28px">
<h1 style="font-size:20px;font-weight:600;color:#171512;margin:0 0 18px">${esc(title)}</h1>
<table style="width:100%;border-collapse:collapse">${tr}</table>
${foot ? `<p style="font-size:14px;line-height:1.6;color:#3d3830;margin:20px 0 0">${foot}</p>` : ""}
</div><p style="text-align:center;font-size:11px;color:#9a9286;margin-top:16px">Booked with Chelgy</p></div></body></html>`;
}
export async function sendEmail({ to, subject, html, replyTo }) {
  // Same Resend key + sender as the domain-reminder emails (BOOKING_FROM can override the sender).
  const from = (process.env.BOOKING_FROM || process.env.REMINDER_FROM || "Chelgy <onboarding@resend.dev>").trim();
  const resend = (process.env.RESEND_API_KEY || "").trim();
  const sendgrid = (process.env.SENDGRID_API_KEY || "").trim();
  if (!to) return false;
  try {
    if (resend) {
      const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + resend, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, html, ...(replyTo ? { reply_to: replyTo } : {}) }) });
      return r.ok;
    }
    if (sendgrid) {
      const m = from.match(/^(.*)<(.+)>$/);
      const r = await fetch("https://api.sendgrid.com/v3/mail/send", { method: "POST", headers: { Authorization: "Bearer " + sendgrid, "Content-Type": "application/json" },
        body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: m ? { email: m[2].trim(), name: m[1].trim() } : { email: from }, subject,
          content: [{ type: "text/html", value: html }], ...(replyTo ? { reply_to: { email: replyTo } } : {}) }) });
      return r.ok;
    }
  } catch { }
  return false;
}
// Customer confirmation + owner notification for a confirmed booking row.
export async function sendBookingEmails(b, brandName) {
  const when = formatWhen(Date.parse(b.start_at), b.tz);
  const biz = brandName || "your appointment";
  const rows = [["Service", b.service_name], ["When", when], ["Length", b.duration_min + " minutes"],
    b.amount_paid_cents ? ["Paid", money(b.amount_paid_cents, b.currency)] : null,
    b.balance_due_cents ? ["Balance due", money(b.balance_due_cents, b.currency)] : null];
  const oEmail = await ownerEmail(b.owner_id);
  await sendEmail({ to: b.customer_email, replyTo: oEmail || undefined, subject: "You're booked: " + b.service_name + " — " + (brandName || "Confirmed"),
    html: emailHtml("You're booked with " + biz, rows, b.balance_due_cents ? "The remaining balance is collected at or after your appointment. Reply to this email if you need to change anything." : "Reply to this email if you need to change anything.") });
  if (oEmail) await sendEmail({ to: oEmail, replyTo: b.customer_email, subject: "New booking: " + b.customer_name + " — " + b.service_name,
    html: emailHtml("New booking", [["Customer", b.customer_name], ["Email", b.customer_email], ["Phone", b.customer_phone], ...rows, ["Notes", b.notes]], "Manage it in your Chelgy dashboard → Website → Bookings.") });
}

export function ipHash(req) {
  const ip = String((req.headers["x-forwarded-for"] || "").split(",")[0] || req.socket && req.socket.remoteAddress || "").trim();
  return crypto.createHash("sha256").update("chelgy-bk:" + ip).digest("hex").slice(0, 32);
}
export function okUrl(u, f) { return (typeof u === "string" && /^https?:\/\//.test(u)) ? u : f; }
export function body(req) { return typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}); }
