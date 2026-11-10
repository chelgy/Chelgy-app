// api/musicvideo-render.js — start a music video.
//
// Charges, then hands the job to the render server, which does the analysis and turns
// it into an ordinary chunked render. The id comes back as "ff:<jobId>", which is the
// same shape api/studio-status.js already polls and the same shape pollVideo in the
// app already speaks — so nothing downstream needed teaching about a new kind of job.
//
// PRICING: THE SAME AS A VLOG, DELIBERATELY AND TEMPORARILY.
//
// 2000 flat plus 250 for every clip past the first, matching STUDIO_COST and
// PER_CLIP_COST in api/studio-ffmpeg.js. That is not a measured number for this
// feature — it is the closest existing one, chosen so the tab can ship before a real
// render has ever been timed.
//
// What it will need to be replaced with: a figure derived from an actual run, using
// the house formula credits ≈ (L4 $/hr) × (minutes per run) × 50. The costs here are
// not the same shape as a vlog's: there is no transcription at all, which is a saving,
// and there is one full audio decode of every clip for alignment, which is not. Whether
// those cancel is a measurement, not a guess. Retime after the first real music video,
// alongside songConvert, which is sitting at an interim 150 for the same reason.
//
// ON THE CUSTOMER'S DEVICE when the app sends the cut it planned there (device +
// segments): planned and charged here, rendered in her browser, no render server.
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
//      RENDER_SERVER_URL, RENDER_SECRET

import { podsMuted } from "./render-scale.js";
import { registerBrowserDevice, planHere } from "./_lib/local-lane.js";

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const RS_URL  = (process.env.RENDER_SERVER_URL || "").trim().replace(/\/+$/, "");
const RS_SECRET = (process.env.RENDER_SECRET || "").trim();

// MUST match CREDIT_COSTS.musicvideo / CREDIT_COSTS.editorClip in App.jsx. The app
// shows a figure on the button before anyone commits; if these drift, someone is
// charged something they didn't agree to.
const MUSICVIDEO_COST = 2000;
const PER_CLIP_COST = 250;

const MAX_CLIPS = 40;
// The longest song the analysis reads (musicvideo-route.js MAX_SONG_SEC), and the most
// cuts a plan may carry — far above what any song produces at the fastest pace.
const MAX_SONG_SEC = 600;
const MAX_SEGMENTS = 1500;
const LOCAL_MAX_SECONDS = 1200;
const FOOTAGE_IDS = ["standard", "sony", "canon", "none"];
const LOOK_IDS = ["wolf", "luxury", "kodak6", "kodak7", "movie3", "movie5", "screen2", "screen3", "timeless"];

// ON THE DEVICE. The app hears the song and the clips, lines them up and plans the cut
// with the render server's own code (align-clip.js, musicvideo-plan.js), and sends the
// cut here. Checked, not trusted: every segment must point at an uploaded clip and be a
// sane length. Returns the segments, or null when anything is off (then the pods, or a
// refusal when they're muted).
function deviceSegments(raw, clipCount) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_SEGMENTS) return null;
  const out = [];
  let total = 0;
  for (const x of raw) {
    const clip = Number(x && x.clip), s = Number(x && x.s), e = Number(x && x.e);
    if (!Number.isInteger(clip) || clip < 0 || clip >= clipCount) return null;
    if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e <= s || e - s > MAX_SONG_SEC) return null;
    total += e - s;
    out.push({ clip, s, e });
  }
  return total >= 1 && total <= MAX_SONG_SEC + 1 ? { segments: out, seconds: total } : null;
}
const PACES = ["calm", "normal", "fast"];

async function getUser(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", {
      headers: { apikey: SB_ANON, Authorization: "Bearer " + token } });
    const u = await r.json();
    return r.ok && u && u.id ? u : null;
  } catch { return null; }
}

async function spend(token, amount, reason) {
  try {
    const r = await fetch(SB_URL + "/rest/v1/rpc/spend_credits", {
      method: "POST",
      headers: { apikey: SB_ANON, Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ p_amount: amount, p_reason: reason }) });
    const d = await r.json();
    if (!r.ok) return { ok: false, error: (d && d.message) || "Could not deduct credits." };
    return { ok: true, balance: typeof d === "number" ? d : null };
  } catch { return { ok: false, error: "Credit service unreachable." }; }
}

async function refund(userId, amount, reason) {
  try {
    await fetch(SB_URL + "/rest/v1/rpc/add_credits", {
      method: "POST",
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json" },
      body: JSON.stringify({ p_user: userId, p_amount: amount, p_reason: reason }) });
  } catch {}
}

// Recorded under the SAME "ff:" id the app polls with.
//
// api/studio-status.js refunds a failed render by looking the id up in video_jobs. If
// this row is missing or keyed differently, a music video that fails analysis takes
// the customer's credits with it and nothing ever gives them back.
async function recordVideoJob(id, userId, cost) {
  try {
    await fetch(SB_URL + "/rest/v1/video_jobs", {
      method: "POST",
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC,
                 "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ id: String(id), user_id: userId, cost }) });
  } catch {}
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let userId = null, cost = 0, charged = false;
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const token = (body.access_token ||
      (req.headers.authorization || "").replace(/^Bearer\s+/i, "")).trim();
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: "Please log in again." });
    userId = user.id;

    const songUrl = String(body.songUrl || "").trim();
    const pace = PACES.includes(String(body.pace)) ? String(body.pace) : "normal";
    const orientation = body.orientation === "landscape" ? "landscape" : "portrait";
    const title = String(body.title || "").slice(0, 120);
    // Grade choices are forwarded, not interpreted. The render server validates them
    // against the lists ffmpeg actually knows; duplicating that check here would give
    // two places to update and one of them would eventually be wrong.
    const footage = String(body.footage || "standard");
    const look = String(body.look || "wolf");
    const effects = body.effects === true;

    // klass and singing come from api/musicvideo-classify.js. Anything missing or
    // unrecognised defaults to "locked", which is the class that cannot be moved —
    // the same safe direction the classifier itself falls back in. A clip we know
    // nothing about is pinned; it is never granted permission to be repositioned.
    const clips = (Array.isArray(body.clips) ? body.clips : []).slice(0, MAX_CLIPS)
      .map((c) => ({
        url: String((c && c.url) || "").trim(),
        klass: ["locked", "shift", "free"].includes(c && c.klass) ? c.klass : "locked",
        singing: (c && c.singing) === true,
      }));

    if (!/^https?:\/\//.test(songUrl))
      return res.status(400).json({ error: "Upload the song you filmed to." });
    if (!clips.length)
      return res.status(400).json({ error: "Upload at least one clip of footage." });
    const bad = clips.findIndex((c) => !/^https?:\/\//.test(c.url));
    if (bad >= 0)
      return res.status(400).json({ error: "Clip " + (bad + 1) + " didn't upload correctly. Remove it and try again." });

    // Planned on the device? Then it renders there too, and the render server isn't
    // needed at all.
    const dev = body.device && typeof body.device === "object" ? body.device : null;
    const cut = deviceSegments(body.segments, clips.length);
    const devMax = Math.min(LOCAL_MAX_SECONDS, Number(dev && dev.maxSeconds) || LOCAL_MAX_SECONDS);
    const deviceCan = (process.env.LOCAL_RENDER || "1").trim() !== "0" &&
      !!(dev && dev.ok === true && cut && cut.seconds <= devMax);

    // PODS MUTED (PODS=off): the device is the only renderer, so anything it can't do is
    // refused here, before the charge.
    if (podsMuted() && !deviceCan) {
      const why = !(dev && dev.ok === true)
          ? "Music videos render right here on your device, and this browser can't do that yet. Open Chelgy in Safari on a Mac, or on your iPhone or iPad."
        : !cut
          ? "Your device couldn't match this footage to the song. Check the song is the same file you played while filming, and try again."
          : "This song is too long for this device to render. Use a Mac, or trim the song.";
      return res.status(400).json({ error: why + " You haven't been charged.", device: true });
    }
    if (!deviceCan && (!RS_URL || !RS_SECRET))
      return res.status(500).json({ error: "Render engine is not configured." });

    cost = MUSICVIDEO_COST + Math.max(0, clips.length - 1) * PER_CLIP_COST;
    const paid = await spend(token, cost, "musicvideo");
    if (!paid.ok) return res.status(402).json({ error: paid.error });
    charged = true;

    if (deviceCan) {
      const browser = await registerBrowserDevice(userId, dev);
      if (!browser) {
        await refund(userId, cost, "refund:musicvideo-no-device");
        return res.status(503).json({ error: "Couldn't set this device up to render. Please try again. Your credits were refunded." });
      }
      // musicvideo-route.js toRenderEdl, with the cut the device planned. Sources are the
      // clips in upload order (the device's segments index into that list).
      const warnings = (Array.isArray(body.warnings) ? body.warnings : []).slice(0, 12).map((w) => String(w).slice(0, 300));
      let stats = {};
      try { if (body.stats && typeof body.stats === "object" && JSON.stringify(body.stats).length <= 4000) stats = body.stats; } catch {}
      const edl = {
        sources: clips.map((c) => c.url),
        segments: cut.segments,
        music: songUrl,
        // Never beat-snapped: the in-point IS the lip sync (see musicvideo-route.js).
        style: effects ? "musicvideofx" : "musicvideo",
        orientation, fps: 30,
        size: orientation === "landscape" ? { w: 1920, h: 1080 } : { w: 1080, h: 1920 },
        grade: { footage: FOOTAGE_IDS.includes(footage) ? footage : "standard", look: LOOK_IDS.includes(look) ? look : "wolf" },
        words: [], title: "", subtitle: "", captionStyle: {},
        chapters: [], broll: [], transitions: [], sfx: [],
        bpmHint: 0,
        uploadPath: userId + "/musicvideo-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7) + ".mp4",
        cleanupPaths: [],
        warnings, stats,
        localOk: true, localDevice: browser.id,
      };
      let planned;
      try { planned = await planHere({ userId, edl, creditsCharged: cost }, null); }
      catch (e) {
        console.error("[musicvideo] planning here failed: " + ((e && e.message) || e));
        await refund(userId, cost, "refund:musicvideo-plan");
        return res.status(502).json({ error: "Couldn't set up the render. Your credits were refunded." });
      }
      const id = "ff:" + planned.jobId;
      await recordVideoJob(id, userId, cost);
      // The database routes it to this tab when the row is written. If it somehow
      // didn't land here (and the pods are muted), nothing would ever render it.
      let lane = "cloud";
      try {
        const lr = await fetch(SB_URL + "/rest/v1/render_jobs?id=eq." + encodeURIComponent(planned.jobId) + "&select=lane", {
          headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC } });
        const rows = lr.ok ? await lr.json() : null;
        if (Array.isArray(rows) && rows[0] && rows[0].lane === "local") lane = "local";
      } catch {}
      if (lane !== "local") {
        if (podsMuted()) {
          try {
            await fetch(SB_URL + "/rest/v1/render_jobs?id=eq." + encodeURIComponent(planned.jobId), {
              method: "PATCH",
              headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json", Prefer: "return=minimal" },
              body: JSON.stringify({ status: "error", error: "no device took it", finished_at: new Date().toISOString() }) });
          } catch {}
          await refund(userId, cost, "refund:musicvideo-no-device");
          return res.status(503).json({ error: "Your device didn't pick up the render. Please try again, and keep Chelgy open. Your credits were refunded." });
        }
        try {
          const { ensurePods } = await import("./render-scale.js");
          await ensurePods(Math.max(1, Number(planned.chunks) || 1), "music video " + planned.jobId);
        } catch (e) { console.error("[musicvideo] pods skipped: " + ((e && e.message) || e)); }
        return res.status(200).json({ id, jobId: planned.jobId, cost, status: "processing" });
      }
      return res.status(200).json({ id, jobId: planned.jobId, cost, status: "processing",
                                    local: { token: browser.token, job: planned.jobId } });
    }

    let started;
    try {
      const r = await fetch(RS_URL + "/musicvideo", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-render-secret": RS_SECRET },
        body: JSON.stringify({
          userId, songUrl, clips, pace, orientation, title,
          footage, look, effects, creditsCharged: cost,
        }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d || !d.jobId) {
        await refund(userId, cost, "refund:musicvideo-queue");
        return res.status(502).json({
          error: ((d && d.error) || "Render engine error.") + " Your credits were refunded." });
      }
      started = d;
    } catch {
      await refund(userId, cost, "refund:musicvideo-unreachable");
      return res.status(502).json({ error: "Couldn't reach the render engine. Your credits were refunded." });
    }

    const id = "ff:" + started.jobId;
    await recordVideoJob(id, userId, cost);

    // ONE POD, WARMED NOW — and this is knowingly less than the job will want.
    //
    // The video editor scales the fleet to the chunk count, because planning happens
    // inside its request and the number is known before it answers. Here the chunk
    // count does not exist yet: alignment runs for minutes after this response, and
    // only then is the render planned. Asking for pods against a number nobody has
    // would be inventing one.
    //
    // So one pod is warmed to meet the chunks whenever they arrive, and it works
    // through them in sequence. A long song therefore renders slower than the same
    // work would through the editor. The fix is for the render server to scale the
    // fleet itself at the moment it writes the chunk rows — the one place the real
    // number exists — which means render-scale.js moving out of api/ to somewhere
    // both halves can reach. Worth doing before this is busy; not worth blocking on.
    try {
      const { ensurePods } = await import("./render-scale.js");
      await ensurePods(1, "music video " + started.jobId + " queued", { additive: true });
    } catch (e) {
      console.error("[musicvideo] pod warm-up skipped: " + ((e && e.message) || e));
    }

    return res.status(200).json({ id, jobId: started.jobId, cost, status: "processing" });
  } catch (e) {
    // Any throw after the charge and before a job id would otherwise keep the money
    // and produce nothing.
    if (charged && userId) await refund(userId, cost, "refund:musicvideo-error");
    return res.status(500).json({ error: "Server error. Your credits were refunded." });
  }
}
