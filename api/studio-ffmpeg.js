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

import { ensurePods } from "./render-scale.js";

export const maxDuration = 60;

const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const RS_URL = (process.env.RENDER_SERVER_URL || "").trim().replace(/\/+$/, "");
const RS_SECRET = (process.env.RENDER_SECRET || "").trim();

const STUDIO_COST = 2000;    // flat — standard styles
const CINEMATIC_COST = 4000; // flat — cinematic
const PER_CLIP_COST = 250;   // each clip past the first — must match CREDIT_COSTS.editorClip in App.jsx
// The score is charged by /api/studio-music when it is generated, BEFORE the render
// starts — not here. That is on purpose: the customer is charged for the thing at
// the moment the thing is bought, so if the score fails it refunds on its own and
// the edit still runs. Rolling it into the render charge would mean one number
// covering two purchases with two different failure modes.
const MAX_CLIPS = 40;        // sanity bound; the real limit is upload time
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
      // Styles that cut from speech alone must never pay for a video decode, so this
      // is opt-in and travels no further than the render server when it's false.
      const wantActivity = body.activity === true;
      const duration = Number(body.duration) || 0;
      const uploadPath = userId + "/audio-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7) + ".mp3";
      try {
        const r = await fetch(RS_URL + "/audio", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-render-secret": RS_SECRET },
          body: JSON.stringify({ sourceUrl: src, uploadPath, activity: wantActivity, duration, userId })
        });
        const d = await r.json();
        if (!r.ok || !d || !d.jobId)
          return res.status(502).json({ error: (d && d.error) || "Couldn't read the audio from that video." });
        // The render server queued this for a pod rather than doing it itself, so a
        // worker has to exist. This is EARLIER than the planning warm-up — which is
        // the point: audio is the first step, so the pod is up and warm by the time
        // the render needs it, instead of the job waiting on a machine nobody started.
        if (d.queued) {
          try {
            const { ensurePods } = await import("./render-scale.js");
            await ensurePods(1, "audio job queued");
          } catch (e) {
            console.error("[audio] could not start a worker: " + ((e && e.message) || e));
          }
        }
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
      // A chunked job's state lives in Postgres, so status comes from there — no
      // render server in the polling path at all. If the row exists it's a chunked
      // job; if not, fall through to the old in-memory endpoint.
      try {
        const q = await fetch(SB_URL + "/rest/v1/render_jobs?id=eq." + encodeURIComponent(jid) +
                              "&select=status,progress,output_url,error,stage,edl", {
          headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC }
        });
        const rows = await q.json();
        if (Array.isArray(rows) && rows[0]) {
          const j = rows[0];
          if (j.status === "done" && j.output_url)
            return res.status(200).json({
              status: "done", url: j.output_url, progress: 100,
              // Audio jobs carry their activity track on the job row. Renders have no
              // activity and this is simply null for them, which is what the caller
              // already expects.
              activity: (j.edl && j.edl.activity) || null
            });
          if (j.status === "error") {
            const job = await lookupJob("ff:" + jid);
            if (job && job.user_id === userId && job.cost) {
              await refund(userId, job.cost, "refund:video-editor-ffmpeg");
              await clearJob("ff:" + jid);
            }
            return res.status(200).json({ status: "error", error: (j.error || "The render failed.") + " Your credits were refunded." });
          }
          return res.status(200).json({ status: "pending", progress: j.progress || 0, stage: j.stage || null });
        }
      } catch { /* not a chunked job, or a blip — try the legacy path */ }

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
        return res.status(200).json({
          status: "done", url: data.url, progress: 100,
          // Only ever present on an audio job that asked for it. Renders don't set it.
          activity: (data && data.activity) || null
        });

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
    // Multi-clip: `urls` is the array, one per clip in timeline order. A single
    // `url` still works — a one-clip edit is just the same thing with one entry.
    const urls = Array.isArray(body.urls) && body.urls.length
      ? body.urls.map(u => String(u || "").trim())
      : (body.url ? [String(body.url).trim()] : []);
    const keep = Array.isArray(body.keep) ? body.keep : [];
    const words = Array.isArray(body.words) ? body.words : [];
    const title = typeof body.title === "string" ? body.title.slice(0, 120) : "";
    const orientation = body.orientation === "landscape" ? "landscape" : "portrait";
    const style = ["vlog", "tutorial", "cinematic"].includes(body.style) ? body.style : "talkinghead";
    const footage = ["sony", "canon", "standard", "none"].includes(body.footage) ? body.footage : "standard";
    const look = body.look === "luxury" ? "luxury" : "wolf";
    const rawDuration = Number(body.rawDuration) || 0;

    // Scene cards and b-roll cues. Both arrive as { clip, s, ... } clip-local, the
    // same contract as words, so the render server never has to reason about a
    // merged timeline. Both are sanitised here rather than trusted: they originate
    // from a language model, and a bad label or a hostile URL should not reach ffmpeg.
    const chapters = (Array.isArray(body.chapters) ? body.chapters : [])
      .map(c => ({
        clip: Math.max(0, Math.floor(Number(c && c.clip) || 0)),
        s: Math.max(0, Number(c && c.s) || 0),
        label: String((c && c.label) || "").trim().slice(0, 40)
      }))
      .filter(c => c.label && c.clip < urls.length)
      .slice(0, 6);

    const broll = (Array.isArray(body.broll) ? body.broll : [])
      .map(b => ({
        clip: Math.max(0, Math.floor(Number(b && b.clip) || 0)),
        s: Math.max(0, Number(b && b.s) || 0),
        url: String((b && b.url) || "").trim(),
        dur: Math.min(4, Math.max(1.2, Number(b && b.dur) || 2.4))
      }))
      .filter(b => /^https?:\/\//.test(b.url) && b.clip < urls.length)
      .slice(0, 4);

    // Generated bridge shots. `after` indexes the kept segment they follow, `trim`
    // is how much of the returned clip is the input tail we already have.
    const transitions = (Array.isArray(body.transitions) ? body.transitions : [])
      .map(t => ({
        after: Math.max(0, Math.floor(Number(t && t.after) || 0)),
        trim: Math.max(0, Math.min(10, Number(t && t.trim) || 0)),
        url: String((t && t.url) || "").trim()
      }))
      .filter(t => /^https?:\/\//.test(t.url) && t.after < keep.length)
      .slice(0, 4);

    // The generated score. Arrives as a provider URL, the same as a bridge shot —
    // never a file, never a data URL. Validated here rather than trusted: this
    // string ends up as an ffmpeg input on the render box.
    const music = typeof body.music === "string" && /^https?:\/\//.test(body.music.trim())
      ? body.music.trim()
      : null;
    // Showcase product labels: [{ clip, s, label, pos }] — placed near each product.
    const showcase = Array.isArray(body.showcase) ? body.showcase : [];
    const narration = typeof body.narration === "string" && /^https?:\/\//.test(body.narration.trim()) ? body.narration.trim() : null;

    // Per-clip "what did you shoot in?" — a day can span two cameras.
    const clipFootage = (Array.isArray(body.clipFootage) ? body.clipFootage : [])
      .map(f => ["sony", "canon", "standard", "none"].includes(f) ? f : footage);

    if (!urls.length) return res.status(400).json({ error: "Missing video URL." });
    if (urls.length > MAX_CLIPS) return res.status(400).json({ error: "That's more than " + MAX_CLIPS + " clips. Remove a few and try again." });
    const badUrl = urls.findIndex(u => !/^https?:\/\//.test(u));
    if (badUrl >= 0) return res.status(400).json({ error: "Clip " + (badUrl + 1) + " didn't upload correctly. Remove it and try again." });
    if (!keep.length) return res.status(400).json({ error: "Nothing to edit — no segments were kept." });
    const badSeg = keep.findIndex(k => {
      const c = Number(k && k.clip);
      const i = Number.isFinite(c) ? Math.floor(c) : 0;
      return i < 0 || i >= urls.length;
    });
    if (badSeg >= 0) return res.status(400).json({ error: "The edit plan pointed at a clip that wasn't uploaded. Please try again." });

    const outSeconds = keep.reduce((a, k) => a + Math.max(0, (Number(k.e) || 0) - (Number(k.s) || 0)), 0);
    if (outSeconds < 1) return res.status(400).json({ error: "The edit came out too short." });
    if (outSeconds > MAX_OUT_SECONDS) return res.status(400).json({ error: "That edit is longer than we support right now." });

    // Cost scales with clip count: every extra clip is its own audio extraction,
    // its own transcription and its own set of cuts on the render box. This MUST
    // match the figure the app shows on the button or she gets charged something
    // she didn't agree to.
    const cost = (style === "cinematic" ? CINEMATIC_COST : STUDIO_COST)
      + Math.max(0, urls.length - 1) * PER_CLIP_COST;
    const paid = await spend(token, cost, "video-editor:ffmpeg");
    if (!paid.ok) return res.status(402).json({ error: paid.error });

    const uploadPath = userId + "/edit-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7) + ".mp4";

    let started;
    // CHUNKED_RENDER=1 sends the edit to the fan-out pipeline: the job is planned
    // into chunks and a worker pool renders them in parallel. Unset, it takes the
    // original single-server path. Same response shape either way, so the app
    // doesn't know or care which one ran — and a bad day is one env var to undo.
    if ((process.env.CHUNKED_RENDER || "").trim() === "1") {
      try {
        const r = await fetch(RS_URL + "/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-render-secret": RS_SECRET },
          body: JSON.stringify({
            userId, creditsCharged: cost,
            edl: {
              sources: urls, segments: keep, words, title, orientation,
              fps: 30, size: orientation === "portrait" ? { w: 1080, h: 1920 } : { w: 1920, h: 1080 },
              grade: { footage, look, clipFootage },
              chapters, broll, transitions, music, showcase, narration,
              captionStyle: style === "vlog" ? { fontScale: 0.040, marginScale: 0.20 } : {},
              uploadPath
            }
          })
        });
        const d = await r.json();
        if (!r.ok || !d || !d.jobId) {
          await refund(userId, cost, "refund:video-editor-plan");
          return res.status(502).json({ error: ((d && d.error) || "Render engine error") + " Your credits were refunded." });
        }
        started = { jobId: d.jobId };

        // Now — and only now — the real chunk count is known. Warm-up started one
        // pod when planning began; this brings the fleet up to match the work that
        // actually exists. A two-chunk edit gets two machines, not three.
        //
        // Deliberately not awaited into the response path beyond a best effort: a
        // scaler that's having a bad minute must never stop a render from starting.
        // The chunks sit in the queue and whatever pods exist will work through them.
        try {
          const want = Math.max(1, Number(d.chunks) || 1);
          await ensurePods(want, "render of job " + d.jobId + " (" + want + " chunks)");
        } catch (e) {
          console.error("[scale] skipped: " + ((e && e.message) || e));
        }
      } catch {
        await refund(userId, cost, "refund:video-editor-plan-unreachable");
        return res.status(502).json({ error: "Couldn't reach the render engine. Your credits were refunded." });
      }
    } else {
    try {
      const r = await fetch(RS_URL + "/render", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-render-secret": RS_SECRET },
        body: JSON.stringify({
          sources: urls,
          sourceUrl: urls[0],
          segments: keep,
          words,
          title,
          orientation,
          uploadPath,
          grade: { footage, look, clipFootage },
          chapters, broll, transitions, music, showcase, narration,
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
    }

    const id = "ff:" + started.jobId;
    await recordVideoJob(id, userId, cost);
    // Real compute cost is roughly $0.02-0.08 per finished minute on the render box.
    const estUsd = Math.round((0.05 * (outSeconds / 60)) * 10000) / 10000;
    await logCost(id, userId, "ffmpeg-" + style + "-" + footage + "-" + look + "-x" + urls.length, outSeconds, cost, estUsd);

    return res.status(200).json({ id, balance: paid.balance, charged: cost });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
