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
// Env (Vercel): RENDER_SERVER_URL, RENDER_SECRET, SUPABASE_URL, SUPABASE_ANON_KEY

export const maxDuration = 60;

const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
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
    if (!RS_URL || !RS_SECRET) return res.status(500).json({ error: "The render server is not configured." });

    const body = req.body || {};

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
