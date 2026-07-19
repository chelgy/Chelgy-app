// Chelgy AI Video Editor — ffmpeg render engine bridge.
//
// Hands edit jobs to the Chelgy render server (Render.com, ffmpeg + real 3D LUTs)
// instead of Creatomate. This is the engine that can apply true Kodak 2383 print
// emulation and camera log conversions (Sony S-Log3 / Canon C-Log2-3), which the
// old render service physically could not do.
//
// POST body:
//   action: "start" (default) | "status" | "cancel"
//   start:  { url, keep:[{s,e}], title, words, orientation, footage, look, rawDuration }
//   status: { id }
//
// footage: "sony" | "canon" | "standard" | "none"   (which LUT chain to run)
// look:    "wolf" | "luxury"                         (which film-look LUT)
//
// Env (Vercel): RENDER_SERVER_URL, RENDER_SECRET,
//               SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

export const maxDuration = 60;

const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const RS_URL = (process.env.RENDER_SERVER_URL || "").trim().replace(/\/+$/, "");
const RS_SECRET = (process.env.RENDER_SECRET || "").trim();

const STUDIO_COST = 2000;    // flat — standard styles
const CINEMATIC_COST = 4000; // flat — cinematic
const MAX_OUT_SECONDS = 900;

async function getUserId(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, Authorization: "Bearer " + token } });
    const u = await r.json();
    return r.ok && u && u.id ? u.id : null;
  } catch { return null; }
}
async function spend(token, amount, reason) {
  try {
    const r = await fetch(SB_URL + "/rest/v1/rpc/spend_credits", {
      method: "POST",
      headers: { apikey: SB_ANON, Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ p_amount: amount, p_reason: reason })
    });
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
      body: JSON.stringify({ p_user: userId, p_amount: amount, p_reason: reason })
    });
  } catch {}
}
async function recordVideoJob(id, userId, cost) {
  try {
    await fetch(SB_URL + "/rest/v1/video_jobs", {
      method: "POST",
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ id: String(id), user_id: userId, cost })
    });
  } catch {}
}
async function lookupJob(id) {
  try {
    const r = await fetch(SB_URL + "/rest/v1/video_jobs?id=eq." + encodeURIComponent(id) + "&select=user_id,cost", {
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC }
    });
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch { return null; }
}
async function clearJob(id) {
  try {
    await fetch(SB_URL + "/rest/v1/video_jobs?id=eq." + encodeURIComponent(id), {
      method: "DELETE",
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, Prefer: "return=minimal" }
    });
  } catch {}
}
async function logCost(id, userId, tool, duration, credits, estUsd) {
  try {
    await fetch(SB_URL + "/rest/v1/cost_log", {
      method: "POST",
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ id: String(id), user_id: userId, tool: "video_editor", model: tool, duration: Math.round(duration) || null, credits_charged: credits, est_usd: estUsd })
    });
  } catch {}
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    if (!RS_URL || !RS_SECRET)
      return res.status(500).json({ error: "The render engine isn't configured yet." });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const action = body.action || "start";
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again." });

    // ── AUDIO: pull just the audio track out of the video for transcription.
    // Free (it's part of the edit) and it makes transcription independent of how
    // large the footage is — a 3GB video becomes a ~2MB audio file.
    if (action === "audio") {
      const src = body.url;
      if (!src || !/^https?:\/\//.test(src)) return res.status(400).json({ error: "Missing video URL." });
      const uploadPath = userId + "/audio-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7) + ".mp3";
      try {
        const r = await fetch(RS_URL + "/audio", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-render-secret": RS_SECRET },
          body: JSON.stringify({ sourceUrl: src, uploadPath })
        });
        const d = await r.json();
        if (!r.ok || !d || !d.jobId)
          return res.status(502).json({ error: (d && d.error) || "Couldn't read the audio from that video." });
        return res.status(200).json({ id: "ff:" + d.jobId });
      } catch {
        return res.status(502).json({ error: "Couldn't reach the render engine." });
      }
    }

    // ── STATUS: poll the render server, refund on failure ──
    if (action === "status") {
      const jid = String(body.id || "").replace(/^ff:/, "").trim();
      if (!jid) return res.status(400).json({ error: "Missing job id." });
      let data;
      try {
        const r = await fetch(RS_URL + "/render/" + encodeURIComponent(jid), {
          headers: { "x-render-secret": RS_SECRET }
        });
        data = await r.json();
        if (!r.ok) return res.status(200).json({ status: "pending" }); // transient — keep polling
      } catch {
        return res.status(200).json({ status: "pending" }); // network blip — keep polling
      }

      if (data && data.status === "done" && data.url)
        return res.status(200).json({ status: "done", url: data.url, progress: 100 });

      if (data && data.status === "error") {
        const job = await lookupJob("ff:" + jid);
        if (job && job.user_id === userId && job.cost) {
          await refund(userId, job.cost, "refund:video-editor-ffmpeg");
          await clearJob("ff:" + jid);
        }
        return res.status(200).json({ status: "error", error: (data.error || "The render failed.") + " Your credits were refunded." });
      }

      return res.status(200).json({
        status: (data && data.status) || "pending",
        progress: (data && data.progress) || 0
      });
    }

    // ── START: charge, then hand the job to the render server ──
    const url = body.url;
    const keep = Array.isArray(body.keep) ? body.keep : [];
    const words = Array.isArray(body.words) ? body.words : [];
    const title = typeof body.title === "string" ? body.title.slice(0, 120) : "";
    const orientation = body.orientation === "landscape" ? "landscape" : "portrait";
    const style = ["vlog", "tutorial", "cinematic"].includes(body.style) ? body.style : "talkinghead";
    const footage = ["sony", "canon", "standard", "none"].includes(body.footage) ? body.footage : "standard";
    const look = body.look === "luxury" ? "luxury" : "wolf";
    const rawDuration = Number(body.rawDuration) || 0;

    if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: "Missing video URL." });
    if (!keep.length) return res.status(400).json({ error: "Nothing to edit — no segments were kept." });

    const outSeconds = keep.reduce((a, k) => a + Math.max(0, (Number(k.e) || 0) - (Number(k.s) || 0)), 0);
    if (outSeconds < 1) return res.status(400).json({ error: "The edit came out too short." });
    if (outSeconds > MAX_OUT_SECONDS) return res.status(400).json({ error: "That edit is longer than we support right now." });

    const cost = style === "cinematic" ? CINEMATIC_COST : STUDIO_COST;
    const paid = await spend(token, cost, "video-editor:ffmpeg");
    if (!paid.ok) return res.status(402).json({ error: paid.error });

    const uploadPath = userId + "/edit-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7) + ".mp4";

    let started;
    try {
      const r = await fetch(RS_URL + "/render", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-render-secret": RS_SECRET },
        body: JSON.stringify({
          sourceUrl: url,
          segments: keep,
          words,
          title,
          orientation,
          uploadPath,
          grade: { footage, look },
          captionStyle: style === "vlog" ? { fontScale: 0.040, marginScale: 0.20 } : {}
        })
      });
      started = await r.json();
      if (!r.ok || !started || !started.jobId) {
        await refund(userId, cost, "refund:video-editor-ffmpeg-start");
        const msg = (started && started.error) || ("Render engine error " + r.status);
        return res.status(502).json({ error: msg + " Your credits were refunded." });
      }
    } catch (e) {
      await refund(userId, cost, "refund:video-editor-ffmpeg-unreachable");
      return res.status(502).json({ error: "Couldn't reach the render engine. Your credits were refunded." });
    }

    const id = "ff:" + started.jobId;
    await recordVideoJob(id, userId, cost);
    // Real compute cost is roughly $0.02-0.08 per finished minute on the render box.
    const estUsd = Math.round((0.05 * (outSeconds / 60)) * 10000) / 10000;
    await logCost(id, userId, "ffmpeg-" + style + "-" + footage + "-" + look, outSeconds, cost, estUsd);

    return res.status(200).json({ id, balance: paid.balance, charged: cost });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
