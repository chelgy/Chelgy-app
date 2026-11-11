// Chelgy — start and poll a commercial assembly on the render server.
//
// A thin proxy, the same shape and for the same reason as studio-join.js: the render
// secret must never reach the browser bundle. Everything of substance — cutting forty
// shots out of ten generations, the grade, the captions, the mix — happens on the
// render server. This checks who is asking and forwards it.
//
// NOT THE PLANNER. api/studio-edl.js writes the plan; this renders one. And not the
// old api/studio-commercial.js either, which writes shot prompts for Seedance and is a
// different tool with a confusingly similar name.
//
// TWO VERBS, ONE ENDPOINT, because that is the convention pollVideo() already follows:
// a body carrying `plan` starts a job, a body carrying `taskId` asks how it is going.
//
//   POST { plan, voUrl, musicUrl, words }  ->  { taskId: "cx:<uuid>" }
//   POST { taskId: "cx:<uuid>" }           ->  { status, progress, stage, url }
//
// The "cx:" prefix is what routes the poll back here from pollVideo. ff: is our own
// render engine, cm: is the old commercial join, omni: is the image pipeline.
//
// NO CREDITS ARE CHARGED HERE. The sources were paid for one at a time as they were
// generated, and assembling files that already exist and are already paid for is not a
// second product. Same call as the join.
//
// SOURCES MUST ARRIVE WITH URLS. Generation stays on the client, reusing the Seedance
// path and pollVideo that already work, rather than a second WaveSpeed client written
// from scratch on this side. The render server rejects a plan whose sources have no
// url, with a message saying so.
//
// FACELESS VIDEOS NOW GO TOGETHER ON THE CUSTOMER'S DEVICE. A start that carries
// { faceless: true, device } is planned here into chunk specs for the browser engine
// and handed to her tab ({ taskId: "ff:<job>", local }). No render server involved;
// "ff:" polls through api/studio-ffmpeg.js like every other device render.
//
// Env (Vercel): RENDER_SERVER_URL, RENDER_SECRET, SUPABASE_URL, SUPABASE_ANON_KEY,
//               SUPABASE_SERVICE_ROLE_KEY

import { registerBrowserDevice, planFaceless, saveJob, copyToStorage } from "./_lib/local-lane.js";

export const maxDuration = 60;

const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const RS_URL = (process.env.RENDER_SERVER_URL || "").trim().replace(/\/+$/, "");
const RS_SECRET = (process.env.RENDER_SECRET || "").trim();

async function getUserId(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, Authorization: "Bearer " + token } });
    const u = await r.json();
    return r.ok && u && u.id ? u.id : null;
  } catch { return null; }
}

const isUrl = (v) => typeof v === "string" && /^https?:\/\//.test(v);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please sign in again." });
    const body = req.body || {};

    // ---- start, on this device (faceless) ----------------------------------
    if (body.faceless === true && !body.taskId) {
      const dev = body.device && typeof body.device === "object" ? body.device : null;
      if (!dev || dev.ok !== true) {
        return res.status(400).json({ error: "Faceless videos are put together right here on your device, and this browser can't do that yet. Open Chelgy in Safari on a Mac, or on your iPhone or iPad." });
      }
      let built;
      try {
        const musicUrl = isUrl(body.musicUrl)
          ? await copyToStorage(body.musicUrl, userId + "/faceless/score-" + Date.now() + ".audio")
          : null;
        built = planFaceless({ plan: body.plan || {}, words: body.words, orientation: body.orientation, voUrl: body.voUrl, musicUrl });
      } catch (e) {
        return res.status(400).json({ error: String((e && e.message) || e) });
      }
      const devMax = Math.min(1200, Number(dev.maxSeconds) || 1200);
      if (built.seconds > devMax) return res.status(400).json({ error: "This video is too long for this device to put together. Use a Mac, or shorten the script." });
      const browser = await registerBrowserDevice(userId, dev);
      if (!browser) return res.status(503).json({ error: "Couldn't set this device up to put the video together. Please try again." });
      const edl = { ...built.edl,
        uploadPath: userId + "/faceless-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7) + ".mp4",
        localOk: true, localDevice: browser.id };
      let saved;
      try { saved = await saveJob({ userId, edl, creditsCharged: 0 }, built.specs); }
      catch (e) {
        console.error("[faceless] couldn't save the job: " + ((e && e.message) || e));
        return res.status(502).json({ error: "Couldn't set up the video. Please try again." });
      }
      // The database routes it to this tab as the row is written. If it didn't land
      // here, nothing else will ever pick a faceless job up, so say so now.
      let lane = "cloud";
      try {
        const lr = await fetch(SB_URL + "/rest/v1/render_jobs?id=eq." + encodeURIComponent(saved.jobId) + "&select=lane", {
          headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC } });
        const rows = lr.ok ? await lr.json() : null;
        if (Array.isArray(rows) && rows[0] && rows[0].lane === "local") lane = "local";
      } catch {}
      if (lane !== "local") {
        try {
          await fetch(SB_URL + "/rest/v1/render_jobs?id=eq." + encodeURIComponent(saved.jobId), {
            method: "PATCH",
            headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json", Prefer: "return=minimal" },
            body: JSON.stringify({ status: "error", error: "no device took it", finished_at: new Date().toISOString() }) });
        } catch {}
        return res.status(503).json({ error: "Your device didn't pick up the video. Please try again, and keep Chelgy open." });
      }
      return res.status(200).json({ taskId: "ff:" + saved.jobId, local: { token: browser.token, job: saved.jobId }, seconds: built.seconds });
    }

    if (!RS_URL || !RS_SECRET) return res.status(500).json({ error: "The render server is not configured." });

    // ---- poll ------------------------------------------------------------
    if (typeof body.taskId === "string" && body.taskId) {
      const jobId = body.taskId.replace(/^cx:/, "");
      // Only the id, and only in the shape the render server issued. Without this a
      // crafted taskId walks the render server's routes with our secret attached.
      if (!/^[a-zA-Z0-9-]{8,64}$/.test(jobId)) {
        return res.status(400).json({ error: "That job id doesn't look right." });
      }

      const r = await fetch(RS_URL + "/commercial/" + jobId, {
        headers: { "x-render-secret": RS_SECRET },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        return res.status(r.status).json({ error: (d && d.error) || "Couldn't check that job." });
      }

      // Reshaped into what pollVideo expects. The render server speaks
      // queued/rendering/done/error; the app understands pending/done.
      if (d.status === "error") {
        return res.status(200).json({ status: "error", error: d.error || "The commercial failed to render." });
      }
      if (d.status === "done" && d.url) {
        return res.status(200).json({
          status: "done", url: d.url, progress: 100,
          seconds: d.seconds || null, clips: d.clips || null,
          // Warnings are advisory — a heavy crop that will soften, that sort of
          // thing. Worth showing, never worth failing over.
          warnings: Array.isArray(d.warnings) ? d.warnings : [],
        });
      }
      return res.status(200).json({
        status: "pending",
        progress: Number(d.progress) || 0,
        stage: d.stage || null,
      });
    }

    // ---- start -----------------------------------------------------------
    const plan = body.plan;
    if (!plan || typeof plan !== "object") return res.status(400).json({ error: "No plan sent." });
    if (!Array.isArray(plan.sources) || !plan.sources.length) return res.status(400).json({ error: "That plan has no shots to render." });
    if (!Array.isArray(plan.timeline) || !plan.timeline.length) return res.status(400).json({ error: "That plan has no timeline." });

    // Caught here so the person gets a sentence rather than a 400 from two services
    // away. The render server checks this too, and should — this is the friendly
    // copy, that is the guard.
    const missing = plan.sources.filter((s) => !isUrl(s && s.url));
    if (missing.length) {
      return res.status(400).json({
        error: `${missing.length} of ${plan.sources.length} shots haven't finished generating yet.`,
      });
    }

    // Namespaced by user so two people rendering at once cannot land on the same
    // object, and so a stray path from the client cannot write outside their folder.
    const uploadPath = "renders/" + userId + "/commercial-" + Date.now() + ".mp4";

    const r = await fetch(RS_URL + "/commercial", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-render-secret": RS_SECRET },
      body: JSON.stringify({
        plan,
        uploadPath,
        // ffmpeg opens a URL as happily as a path, so the generated voiceover and
        // score go over as the URLs they were uploaded to. Named voPath/musicPath
        // on the far side because that is what assembleCommercial calls them.
        voPath: isUrl(body.voUrl) ? body.voUrl : null,
        musicPath: isUrl(body.musicUrl) ? body.musicUrl : null,
        // Word timings must already be on the OUTPUT timeline. commercial.js builds
        // one caption track for the whole ad and slices it per shot, so anything
        // still in source time lands on the wrong shot.
        words: Array.isArray(body.words) ? body.words : null,
        // Sound design. Times are already on the finished ad's clock — the planner
        // wrote the timeline, so unlike the video editor nothing needs remapping.
        ambience: isUrl(body.ambienceUrl) ? body.ambienceUrl : null,
        sfx: (Array.isArray(body.sfx) ? body.sfx : [])
          .filter((x) => x && Number.isFinite(Number(x.at)) && isUrl(x.url))
          .slice(0, 8)
          .map((x) => ({ at: Math.max(0, Number(x.at)), path: x.url })),
      }),
    });

    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: (d && d.error) || "Couldn't start that render." });
    if (!d || !d.jobId) return res.status(502).json({ error: "The render server didn't return a job." });

    return res.status(200).json({ taskId: "cx:" + d.jobId });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || "Commercial render failed." });
  }
}
