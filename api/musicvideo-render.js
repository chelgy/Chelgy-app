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
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
//      RENDER_SERVER_URL, RENDER_SECRET

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

    if (!RS_URL || !RS_SECRET)
      return res.status(500).json({ error: "Render engine is not configured." });

    const songUrl = String(body.songUrl || "").trim();
    const pace = PACES.includes(String(body.pace)) ? String(body.pace) : "normal";
    const orientation = body.orientation === "landscape" ? "landscape" : "portrait";
    const title = String(body.title || "").slice(0, 120);
    // Grade choices are forwarded, not interpreted. The render server validates them
    // against the lists ffmpeg actually knows; duplicating that check here would give
    // two places to update and one of them would eventually be wrong.
    const footage = String(body.footage || "standard");
    const look = String(body.look || "wolf");

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

    cost = MUSICVIDEO_COST + Math.max(0, clips.length - 1) * PER_CLIP_COST;
    const paid = await spend(token, cost, "musicvideo");
    if (!paid.ok) return res.status(402).json({ error: paid.error });
    charged = true;

    let started;
    try {
      const r = await fetch(RS_URL + "/musicvideo", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-render-secret": RS_SECRET },
        body: JSON.stringify({
          userId, songUrl, clips, pace, orientation, title,
          footage, look, creditsCharged: cost,
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
