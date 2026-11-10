// Chelgy — rendering on the customer's own Mac.
//
// The Chelgy Render app on a Mac talks ONLY to this endpoint. It never holds a
// Supabase key: it holds a device token that can do exactly five things — check in,
// take a job routed to it, report progress, get a one-time upload link for that
// job's finished file, and say "done" or "I couldn't". Everything else (who owns
// what, where files go, credits, the pods) stays on this side.
//
// POST { action, ... }
//   Mac, not yet linked:   link_start { name } · link_poll { code, poll }
//   Browser (logged in):   link_peek { code } · link_confirm { code } · devices · remove_device { id }
//   Mac, linked:           header  x-chelgy-device: <token>
//                          claim { enabled, caps, version } · extend { job, progress, stage }
//                          upload_url { job } · done { job } · fail { job, error }
// GET  (Vercel cron, Bearer CRON_SECRET): hand stalled local jobs back to the pods.
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET, BUCKET (default sites)

import crypto from "node:crypto";
import { ensurePods, podsMuted } from "./render-scale.js";

export const maxDuration = 60;

const SB_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const BUCKET = (process.env.BUCKET || "sites").trim();
const APP_URL = (process.env.APP_URL || "https://chelgy.app").trim().replace(/\/+$/, "");
const LEASE_SECONDS = 120;   // the Mac extends every ~30s while it works
// A browser tab gets far longer. Switching apps on a phone freezes the page, and the
// render carries on when she comes back — so leaving for a few minutes must not cost
// her the render. Past this, the job is given up on (refunded, or the pods if on).
const BROWSER_LEASE_SECONDS = 1800;
const leaseFor = (device) => (device && device.kind === "browser" ? BROWSER_LEASE_SECONDS : LEASE_SECONDS);

// Credits back for a render that didn't happen, and the editor's own record of the
// charge removed so its poll doesn't refund a second time.
async function refundJob(jobId, userId, credits) {
  if (!userId || !(Number(credits) > 0)) return;
  try {
    await fetch(SB_URL + "/rest/v1/rpc/add_credits", {
      method: "POST",
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json" },
      body: JSON.stringify({ p_user: userId, p_amount: Number(credits), p_reason: "refund:video-editor-device" })
    });
    await fetch(SB_URL + "/rest/v1/video_jobs?id=eq." + encodeURIComponent("ff:" + jobId), {
      method: "DELETE", headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, Prefer: "return=minimal" }
    });
  } catch (e) { console.error("[local] refund failed for job " + jobId + ": " + ((e && e.message) || e)); }
}

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function rpc(fn, args) {
  const r = await fetch(SB_URL + "/rest/v1/rpc/" + fn, {
    method: "POST",
    headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json" },
    body: JSON.stringify(args || {})
  });
  const t = await r.text();
  if (!r.ok) throw new Error(fn + " " + r.status + " " + t.slice(0, 200));
  return t ? JSON.parse(t) : null;
}

async function getUser(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, Authorization: "Bearer " + token } });
    const u = await r.json();
    return r.ok && u && u.id ? u : null;
  } catch { return null; }
}

// The link page is a plain page outside the app, so its saved login may have expired.
// It sends the refresh token too; we renew here and hand the new session back so the
// page can save it (Supabase rotates refresh tokens — the old one is dead after this).
async function refreshLogin(refreshToken) {
  if (!refreshToken) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/token?grant_type=refresh_token", {
      method: "POST", headers: { apikey: SB_ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken })
    });
    const d = await r.json();
    return r.ok && d && d.access_token && d.user ? d : null;
  } catch { return null; }
}

// Short, unambiguous, easy to compare by eye: "K7QM-2XPA".
function newCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += A[crypto.randomInt(A.length)];
  return s.slice(0, 4) + "-" + s.slice(4);
}
const cleanCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(.{4})(.{4})$/, "$1-$2");

// Same guard as the cloud join: raw uploads live at "<user-uuid>/<kind>-<stamp>.<ext>",
// and nothing outside that shape is ever deleted, whatever the edl says.
const INPUT_SAFE = /^[0-9a-fA-F-]{36}\/(edit|clips|editor|narration|proxy|frame|shot)-[A-Za-z0-9._-]+$/;
function inputPathsFrom(edl) {
  const urls = [];
  if (edl && Array.isArray(edl.sources)) urls.push(...edl.sources);
  if (edl && typeof edl.narration === "string") urls.push(edl.narration);
  const marker = "/storage/v1/object/public/" + BUCKET + "/";
  const out = [];
  for (const u of urls) {
    const s = String(u || "");
    const i = s.indexOf(marker);
    if (i === -1 || !s.startsWith(SB_URL)) continue;
    out.push(decodeURIComponent(s.slice(i + marker.length).split("?")[0]));
  }
  return [...new Set(out)].filter((p) => INPUT_SAFE.test(p));
}

const outputKey = (jobId) => "renders/" + jobId + "/local.mp4";
const publicUrl = (key) => SB_URL + "/storage/v1/object/public/" + BUCKET + "/" + key;

async function handBack(jobId, deviceId, reason) {
  const n = await rpc("release_local_render_job", { p_job: jobId, p_device: deviceId, p_reason: reason });
  if (n) {
    try { await ensurePods(n, "local render handed back (" + reason + ") job " + jobId); }
    catch (e) { console.error("[local] couldn't start pods: " + ((e && e.message) || e)); }
  }
  return n;
}

export async function rescueStalled(jobId) {
  const cloud = !podsMuted();
  const rows = await rpc("rescue_local_render_jobs", jobId ? { p_job: jobId, p_cloud: cloud } : { p_cloud: cloud });
  for (const r of rows || []) {
    if (r.failed) {
      console.log("[local] job " + r.job_id + " given up (pods muted), refunding");
      await refundJob(r.job_id, r.user_id, r.credits);
      continue;
    }
    console.log("[local] job " + r.job_id + " handed back to the pods (" + r.chunks + " chunks)");
    try { await ensurePods(r.chunks, "local job " + r.job_id + " rescued"); }
    catch (e) { console.error("[local] couldn't start pods: " + ((e && e.message) || e)); }
  }
  return (rows || []).length;
}

export default async function handler(req, res) {
  try {
    if (!SB_URL || !SB_SVC) return res.status(500).json({ error: "Not configured." });

    // ── Cron: the safety net for closed laptops and quit apps ──
    if (req.method === "GET") {
      // Vercel sends the CRON_SECRET when one is set. Without one, only Vercel's cron
      // agent is accepted — and all this can do is tidy up stalled jobs anyway.
      const auth = (req.headers.authorization || "").trim();
      const secret = (process.env.CRON_SECRET || "").trim();
      const fromCron = secret ? auth === "Bearer " + secret : /vercel-cron/i.test(String(req.headers["user-agent"] || ""));
      if (!fromCron) return res.status(401).json({ error: "Unauthorized" });
      const rescued = await rescueStalled(null);
      return res.status(200).json({ ok: true, rescued });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const action = String(body.action || "");

    // ── Linking, from the Mac ──
    if (action === "link_start") {
      const poll = crypto.randomBytes(24).toString("base64url");
      let code = null;
      for (let i = 0; i < 4 && !code; i++) {
        const c = newCode();
        try { await rpc("create_render_device_link", { p_code: c, p_poll_hash: sha(poll), p_name: String(body.name || "Mac").slice(0, 60) }); code = c; }
        catch (e) { if (!/23505|duplicate/i.test(String(e.message))) throw e; }
      }
      if (!code) return res.status(503).json({ error: "Try again in a moment." });
      return res.status(200).json({ code, poll, url: APP_URL + "/render-mac.html?code=" + encodeURIComponent(code), expires_in: 600 });
    }
    if (action === "link_poll") {
      const r = await rpc("take_render_device_token", { p_code: cleanCode(body.code), p_poll_hash: sha(body.poll || "") });
      return res.status(200).json(r || { status: "expired" });
    }

    // ── Linking + managing, from the browser ──
    if (action === "link_peek") {
      const r = await rpc("peek_render_device_link", { p_code: cleanCode(body.code) });
      return r ? res.status(200).json(r) : res.status(404).json({ error: "That code has expired. Start again from the Chelgy Render app." });
    }
    if (["link_confirm", "devices", "remove_device"].includes(action)) {
      const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
      let user = await getUser(bearer);
      let session = null;
      if (!user && body.refresh_token) {
        session = await refreshLogin(String(body.refresh_token));
        user = session && session.user;
      }
      if (!user) return res.status(401).json({ error: "Please log in to Chelgy first." });
      const renewed = session ? { access_token: session.access_token, refresh_token: session.refresh_token } : undefined;

      if (action === "devices") {
        return res.status(200).json({ devices: await rpc("list_render_devices", { p_user: user.id }), session: renewed });
      }
      if (action === "remove_device") {
        if (!UUID.test(String(body.id || ""))) return res.status(400).json({ error: "Missing device." });
        const ok = await rpc("revoke_render_device", { p_user: user.id, p_device: body.id });
        if (ok) await rescueStalled(null).catch(() => {});
        return res.status(ok ? 200 : 404).json({ ok: !!ok, session: renewed });
      }
      const token = crypto.randomBytes(32).toString("base64url");
      const r = await rpc("confirm_render_device_link", {
        p_code: cleanCode(body.code), p_user: user.id, p_token: token, p_token_hash: sha(token)
      });
      if (r && r.ok) return res.status(200).json({ ok: true, name: r.name, email: user.email, session: renewed });
      const msg = r && r.error === "taken"
        ? "That code was already used by another account."
        : "That code has expired. Start again from the Chelgy Render app.";
      return res.status(400).json({ error: msg, session: renewed });
    }

    // ── Everything below is a linked Mac ──
    // Header normally. In the body only for a closing browser tab's last word
    // (navigator.sendBeacon can't set headers).
    const devToken = String(req.headers["x-chelgy-device"] || (action === "fail" && body.device_token) || "").trim();
    const device = devToken ? await rpc("render_device_by_token", { p_token_hash: sha(devToken) }) : null;
    if (!device || !device.id) return res.status(401).json({ error: "unlinked" });

    if (action === "claim") {
      // Capabilities are small by design. If a Mac ever sends something huge, keep the
      // plain top-level facts (ok, encoder, chip...) rather than cutting the JSON in half.
      let caps = body.caps && typeof body.caps === "object" && !Array.isArray(body.caps) ? body.caps : null;
      if (caps && JSON.stringify(caps).length > 2000) {
        const small = {};
        for (const [k, v] of Object.entries(caps).slice(0, 40))
          if (v === null || ["boolean", "number"].includes(typeof v)) small[k.slice(0, 40)] = v;
          else if (typeof v === "string") small[k.slice(0, 40)] = v.slice(0, 40);
        caps = small;
      }
      const enabled = typeof body.enabled === "boolean" ? body.enabled : null;
      await rpc("render_device_heartbeat", {
        p_device: device.id, p_enabled: enabled,
        p_caps: caps,
        p_version: body.version ? String(body.version) : null
      });
      // Switched off in the menu: anything already waiting for this Mac goes to the pods
      // now, rather than after the 45-second wait.
      if (enabled === false) { await rescueStalled(null).catch(() => {}); return res.status(200).json({ job: null, name: device.name }); }
      const job = await rpc("claim_local_render_job", { p_device: device.id, p_lease_seconds: leaseFor(device) });
      return res.status(200).json({ job: job || null, name: device.name, lease: leaseFor(device) });
    }

    const jobId = String(body.job || "");
    if (!UUID.test(jobId)) return res.status(400).json({ error: "Missing job." });

    if (action === "extend") {
      const p = Number(body.progress);
      const ok = await rpc("extend_local_render_job", {
        p_device: device.id, p_job: jobId, p_lease_seconds: leaseFor(device),
        p_progress: Number.isFinite(p) ? Math.round(p) : null,
        p_stage: typeof body.stage === "string" ? body.stage.slice(0, 80) : null
      });
      return res.status(200).json({ ok: !!ok });
    }

    if (action === "upload_url") {
      // Holding the job is the permission. Extending also proves it in one step.
      const ok = await rpc("extend_local_render_job", {
        p_device: device.id, p_job: jobId, p_lease_seconds: leaseFor(device), p_progress: null, p_stage: "Uploading"
      });
      if (!ok) return res.status(409).json({ error: "not yours" });
      const key = outputKey(jobId);
      const r = await fetch(SB_URL + "/storage/v1/object/upload/sign/" + BUCKET + "/" + key, {
        method: "POST",
        headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json", "x-upsert": "true" },
        body: "{}"
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d || !d.url) return res.status(502).json({ error: "Couldn't prepare the upload." });
      return res.status(200).json({ url: SB_URL + "/storage/v1" + d.url, key });
    }

    if (action === "done") {
      // Trust the file, not the message: it has to actually be there.
      const url = publicUrl(outputKey(jobId));
      let size = 0;
      try {
        const h = await fetch(url, { method: "HEAD" });
        size = h.ok ? Number(h.headers.get("content-length")) || 0 : 0;
      } catch {}
      if (size < 1000) return res.status(409).json({ error: "The finished file isn't there yet." });
      const fin = await rpc("finish_local_render_job", { p_device: device.id, p_job: jobId, p_output_url: url });
      if (!fin) return res.status(409).json({ error: "not yours" });

      // Same bookkeeping the cloud join does: a cost line (zero — her Mac paid for it)
      // and removal of the raw uploads now that the finished file exists.
      try {
        const segs = fin.edl && Array.isArray(fin.edl.segments) ? fin.edl.segments : [];
        await fetch(SB_URL + "/rest/v1/cost_log", {
          method: "POST",
          headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({
            id: "render:" + jobId, user_id: fin.user_id || null, tool: "video_editor", model: "render-local",
            duration: Math.round(segs.reduce((t, s) => t + Math.max(0, (Number(s.e) || 0) - (Number(s.s) || 0)), 0)) || null,
            credits_charged: Number(fin.credits_charged) || 0, est_usd: 0
          })
        });
      } catch {}
      for (const p of inputPathsFrom(fin.edl)) {
        try {
          await fetch(SB_URL + "/storage/v1/object/" + BUCKET + "/" + p,
                      { method: "DELETE", headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC } });
        } catch {}
      }
      return res.status(200).json({ ok: true, url });
    }

    if (action === "fail") {
      const reason = "Device: " + String(body.error || "failed").slice(0, 250);
      if (podsMuted()) {
        // No pods to hand it to. Fail it and give the credits back.
        const f = await rpc("fail_local_render_job", { p_job: jobId, p_device: device.id, p_reason: reason });
        if (f) await refundJob(jobId, f.user_id, f.credits_charged);
        return res.status(200).json({ ok: true, handed_back: false, refunded: !!f });
      }
      const n = await handBack(jobId, device.id, reason);
      return res.status(200).json({ ok: true, handed_back: !!n });
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    console.error("[local] " + ((e && e.message) || e));
    return res.status(500).json({ error: "Server error." });
  }
}
