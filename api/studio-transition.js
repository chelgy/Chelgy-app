// Chelgy AI Video Editor — frame-aware TRANSITIONS.
//
// At a genuine scene change, generates a short bridge shot that visually connects
// the outgoing shot to the incoming one — grocery aisles into aisles, a downtown
// street into a drone move over that city.
//
// Runs on ByteDance Seedance 2.0 VIDEO-EXTEND, not image-to-video. That matters:
// video-extend continues from the actual TAIL of the outgoing shot, so it inherits
// real camera movement, lighting and motion instead of guessing from one frozen
// frame — and `last_image` pins where it has to land. Both ends anchored. With only
// the first frame anchored the bridge drifts and then hard-cuts into the next shot,
// which is exactly what makes AI transitions look cheap.
//
// Three actions, because the work spans two machines and a 60s function limit:
//   boundary  → ask the render server for the tail clip + both boundary frames
//               (only it has the footage). Returns a job id to poll.
//   status    → poll that job.
//   start     → both frames to Gemini for a bridge brief, then submit to Seedance.
//               Returns a WaveSpeed prediction id that video-result.js already polls.
//
// IMPORTANT: video-extend returns the INPUT CLIP AND THE NEW SEGMENT CONCATENATED.
// Feed it a 2s tail and you get ~6s back, not 4. `trimStart` in the response tells
// the render server how much to cut off the front before splicing it in.
//
// Env: WAVESPEED_API_KEY, GEMINI_API_KEY, RENDER_SERVER_URL, RENDER_SECRET,
//      SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

export const maxDuration = 60;

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const RS_URL  = (process.env.RENDER_SERVER_URL || "").trim().replace(/\/+$/, "");
const RS_SECRET = (process.env.RENDER_SECRET || "").trim();

const TAIL_SECONDS = 2;    // how much of the outgoing shot Seedance continues from
const MIN_DURATION = 4;    // Seedance clamps the new segment to 4-15s
const MAX_DURATION = 8;

// Per-second credit rates for VIDEO-EXTEND specifically. These are NOT the
// image-to-video rates in video.js — extend is billed differently. WaveSpeed's
// published cost for the new segment is $0.12/s at 480p, $0.24/s at 720p and
// $0.60/s at 1080p. At the ~2x markup used elsewhere in Chelgy (see omni.js:
// 2500 credits ≈ $2 against $1 of real cost), that lands here:
//
//   480p   $0.12/s real -> $0.24 ->  300 credits/s
//   720p   $0.24/s real -> $0.48 ->  600 credits/s
//   1080p  $0.60/s real -> $1.20 -> 1500 credits/s
//
// NOTE the 1080p figure. video.js prices image-to-video at 900/s from an estimated
// $0.36/s. Extend genuinely costs $0.60/s, so reusing 900 here would sell it at a
// loss on every single transition.
const EXTEND_RATE = { "480p": 300, "720p": 600, "1080p": 1500 };
const REAL_USD    = { "480p": 0.12, "720p": 0.24, "1080p": 0.60 };

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
async function logCost(id, userId, model, duration, credits, estUsd) {
  try {
    await fetch(SB_URL + "/rest/v1/cost_log", {
      method: "POST",
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ id: String(id), user_id: userId, tool: "video_editor", model, duration, credits_charged: credits, est_usd: estUsd })
    });
  } catch {}
}

// Fetch an image and inline it for Gemini.
async function inlineImage(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("Couldn't read a boundary frame.");
  const buf = Buffer.from(await r.arrayBuffer());
  return { mimeType: r.headers.get("content-type") || "image/jpeg", data: buf.toString("base64") };
}

// Look at BOTH frames and write the shot that connects them.
//
// The brief is deliberately told not to ask for a colour grade. The render server
// puts the finished bridge through the same film-look LUT as the footage, so a
// pre-graded clip would end up double-graded — the same discipline as shooting log.
async function bridgeBrief(GKEY, fromImg, toImg) {
  const prompt =
    "You are a cinematographer planning ONE short bridge shot between two shots in a video.\n" +
    "The FIRST image is the last frame of the outgoing shot. The SECOND image is the first frame of the shot it must land on.\n\n" +
    "Write a single camera instruction describing how the camera moves from the first image to the second — a continuous move, " +
    "not a cut. Reference what is actually visible: if both show a supermarket aisle, travel down the aisle. If one is a street and " +
    "the other is a wide city view, rise and pull back over the rooftops. Keep the same location, time of day, weather and lighting.\n\n" +
    "Rules:\n" +
    "- 25 words maximum, one sentence, present tense.\n" +
    "- Describe CAMERA MOVEMENT and what passes through frame. No story, no dialogue, no people appearing who are not already there.\n" +
    "- Do NOT describe colour grading, film stock, or a 'cinematic look'. The grade is applied afterwards.\n" +
    "- No text, captions or titles in the shot.\n\n" +
    "Respond with ONLY the sentence.";
  try {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
      { method: "POST", headers: { "x-goog-api-key": GKEY, "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [
          { inlineData: fromImg }, { inlineData: toImg }, { text: prompt }
        ] }], generationConfig: { temperature: 0.4 } }) }
    );
    const d = await r.json();
    let text = "";
    try { text = d.candidates[0].content.parts[0].text; } catch {}
    text = String(text || "").replace(/["\n\r]+/g, " ").trim().slice(0, 300);
    return text || null;
  } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const action = body.action || "start";
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again." });

    if (!RS_URL || !RS_SECRET)
      return res.status(500).json({ error: "The render engine isn't configured yet." });

    // ── BOUNDARY: ask the render server for the tail clip and both frames ──
    if (action === "boundary") {
      const outUrl = String(body.outUrl || ""), inUrl = String(body.inUrl || "");
      if (!/^https?:\/\//.test(outUrl) || !/^https?:\/\//.test(inUrl))
        return res.status(400).json({ error: "Missing clip URLs for that transition." });
      const prefix = userId + "/tr-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
      try {
        const r = await fetch(RS_URL + "/boundary", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-render-secret": RS_SECRET },
          body: JSON.stringify({
            outUrl, inUrl,
            outEnd: Number(body.outEnd) || 0,
            inStart: Number(body.inStart) || 0,
            tail: TAIL_SECONDS,
            uploadPrefix: prefix
          })
        });
        const d = await r.json();
        if (!r.ok || !d || !d.jobId)
          return res.status(502).json({ error: (d && d.error) || "Couldn't read that cut point." });
        return res.status(200).json({ id: d.jobId });
      } catch {
        return res.status(502).json({ error: "Couldn't reach the render engine." });
      }
    }

    // ── STATUS: poll the boundary job ──
    if (action === "status") {
      const jid = String(body.id || "").trim();
      if (!jid) return res.status(400).json({ error: "Missing job id." });
      try {
        const r = await fetch(RS_URL + "/render/" + encodeURIComponent(jid), {
          headers: { "x-render-secret": RS_SECRET }
        });
        const d = await r.json();
        if (!r.ok) return res.status(200).json({ status: "pending" });
        if (d && d.status === "done")
          return res.status(200).json({ status: "done", video: d.video, from: d.from, to: d.to, paths: d.paths || [] });
        if (d && d.status === "error")
          return res.status(200).json({ status: "error", error: d.error || "Couldn't read that cut point." });
        return res.status(200).json({ status: "pending", progress: (d && d.progress) || 0 });
      } catch {
        return res.status(200).json({ status: "pending" });
      }
    }

    // ── START: write the brief, then generate the bridge ──
    const video = String(body.video || "");
    const from  = String(body.from  || "");
    const to    = String(body.to    || "");
    if (!/^https?:\/\//.test(video) || !/^https?:\/\//.test(to))
      return res.status(400).json({ error: "That transition is missing its boundary clip." });

    const resolution = ["480p", "720p", "1080p"].includes(body.resolution) ? body.resolution : "1080p";
    let duration = Number(body.duration);
    if (!Number.isFinite(duration)) duration = MIN_DURATION;
    duration = Math.max(MIN_DURATION, Math.min(MAX_DURATION, Math.round(duration)));

    const key = (process.env.WAVESPEED_API_KEY || "").trim();
    const GKEY = (process.env.GEMINI_API_KEY || "").trim();
    if (!key) return res.status(500).json({ error: "The video engine isn't configured." });

    // Write the brief BEFORE charging — a failure here costs nothing.
    let prompt = null;
    if (GKEY && /^https?:\/\//.test(from)) {
      try {
        const [a, b] = await Promise.all([inlineImage(from), inlineImage(to)]);
        prompt = await bridgeBrief(GKEY, a, b);
      } catch { prompt = null; }
    }
    // A generic continuation is far better than no transition, but it's a fallback,
    // not the plan — the whole point is that the model looked at both frames.
    if (!prompt) prompt = "The camera continues moving forward through the scene in one smooth take, arriving at a new view of the same place.";

    const cost = Math.round((EXTEND_RATE[resolution] || EXTEND_RATE["1080p"]) * duration);
    const paid = await spend(token, cost, "video-editor:transition:" + resolution + ":" + duration + "s");
    if (!paid.ok) return res.status(402).json({ error: paid.error });

    let data;
    try {
      const r = await fetch("https://api.wavespeed.ai/api/v3/bytedance/seedance-2.0/video-extend", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body: JSON.stringify({
          video,
          prompt,
          last_image: to,          // the frame the bridge has to land on
          resolution,
          duration,
          enable_web_search: false
        })
      });
      data = await r.json();
      if (!r.ok) {
        await refund(userId, cost, "refund:transition-submit");
        return res.status(r.status).json({ error: ((data && data.message) || "Transition engine error") + " Your credits were refunded." });
      }
    } catch {
      await refund(userId, cost, "refund:transition-unreachable");
      return res.status(502).json({ error: "Couldn't reach the transition engine. Your credits were refunded." });
    }

    const id = data && data.data && data.data.id;
    if (!id) {
      await refund(userId, cost, "refund:transition-noid");
      return res.status(502).json({ error: "No prediction id returned. Your credits were refunded." });
    }

    await recordVideoJob(id, userId, cost);   // so video-result.js can refund a failure
    await logCost(id, userId, "seedance-extend-" + resolution, duration, cost, (REAL_USD[resolution] || 0.6) * duration);

    // trimStart is the contract with the render server: video-extend hands back the
    // input tail AND the new segment joined together, so the first TAIL_SECONDS are
    // footage we already have and must be cut off before splicing.
    return res.status(200).json({ id, trimStart: TAIL_SECONDS, prompt, charged: cost, balance: paid.balance });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
