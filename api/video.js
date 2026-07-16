// Chelgy back room — starts a video job on WaveSpeed.
// Your key lives in Vercel as WAVESPEED_API_KEY, never in public code.
// Quality tiers:
//   480p / 720p  -> WAN 2.2      (fast, economical)          | 5/10s   | "size"
//   1080p        -> WAN 2.7      (premium)                   | 5/10/15 | "resolution" + "aspect_ratio"
//   veolite      -> Veo 3.1 Lite  (cheap tier, 720p+audio)   | 4/6/8s  | DIRECT to Google
//   veofast      -> Veo 3.1 Fast  (sharper, 720p+audio)      | 4/6/8s  | DIRECT to Google
//   veo          -> Veo 3.1       (cinematic 1080p+audio)    | 4/6/8s  | DIRECT to Google
//
// NOTE: All Veo tiers now call Google's Gemini API DIRECTLY (no WaveSpeed markup).
// Google job ids are stored with a "g:" prefix so video-result.js knows to poll Google.
//
// AUDIO: On the Gemini API (generativelanguage.googleapis.com), Veo 3.1 generates
// native audio AUTOMATICALLY — driven by the prompt. There is NO "generateAudio"
// parameter here; that flag only exists on Vertex AI, and sending it to the Gemini
// API returns: "generateAudio isn't supported by this model." Likewise the Gemini
// API doesn't take "sampleCount" (it returns a single video). So we send only the
// parameters this endpoint accepts: aspectRatio, resolution, durationSeconds.
// To get spoken dialogue, put the line in the prompt (e.g. she says: "welcome").
//
//   kling4k      -> Kling 3.0 4K (true 4K cinematic)         | 5/10/15 | "duration" + "aspect_ratio" + "sound"
//   seedance4k   -> Seedance 2.0 (4K multi-shot, native A/V) | 5/10/15 | "resolution":"4K" + "aspect_ratio"
//
// Credits are deducted server-side BEFORE the job starts; the job is recorded
// so a later failure (caught in video-result.js) can be refunded automatically.
// Env: WAVESPEED_API_KEY, GEMINI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

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
// ── COST LOG ────────────────────────────────────────────────────────────────
// Records the REAL (calibrated) provider cost next to the credits we charged, so
// margins are visible per tool/model. These per-second USD figures are the best
// current estimate — recalibrate them against your WaveSpeed/Google dashboard.
function realUsd(quality, duration) {
  const d = Number(duration) || 0;
  const perSec = {
    veolite: 0.05, veofast: 0.10, veo: 0.40,   // Google Veo 3.1 direct
    kling4k: 0.42,                              // Kling 3.0 4K
    seedance480: 0.12, seedance720: 0.24, seedance1080: 0.36, seedance4k: 0.60 // Seedance 2.0 (4K = estimate)
  }[quality];
  if (perSec != null) return Math.round(perSec * d * 10000) / 10000;
  const base5 = quality === "1080p" ? 0.75 : quality === "720p" ? 0.30 : 0.15; // WAN 2.x per 5s
  return Math.round((base5 * d / 5) * 10000) / 10000;
}
async function logCost(id, userId, tool, model, duration, credits, estUsd) {
  try {
    await fetch(SB_URL + "/rest/v1/cost_log", {
      method: "POST",
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ id: String(id), user_id: userId, tool: tool || "video", model, duration: Number(duration) || null, credits_charged: credits, est_usd: estUsd })
    });
  } catch {}
}
function videoCost(quality, duration, wantAudio) {
  const d = Number(duration);
  // Google direct pricing (per second, 720p with audio):
  //   Lite $0.05  -> 150 credits/s   |  Fast $0.10 -> 300  |  Standard $0.40 -> 1250
  if (quality === "veolite") return 150 * d;
  if (quality === "veofast") return 300 * d;
  if (quality === "veo") return 1250 * d; // Gemini-API Veo audio is always native — always charge the audio rate
  if (quality === "kling4k") return 1300 * d;
  if (quality === "seedance480") return 300 * d;
  if (quality === "seedance720") return 600 * d;
  if (quality === "seedance1080") return 900 * d;
  if (quality === "seedance4k") return 1800 * d;
  const base = quality === "1080p" ? 2500 : quality === "720p" ? 1000 : 500;
  return Math.round(base * d / 5);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const prompt = body.prompt;
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    const key = (process.env.WAVESPEED_API_KEY || "").trim();
    const GKEY = (process.env.GEMINI_API_KEY || "").trim();
    const isVeo = ["veolite", "veofast", "veo"].includes(body.quality);
    if (isVeo && !GKEY) return res.status(500).json({ error: "Video service is not configured." });
    if (!isVeo && !key) return res.status(500).json({ error: "Video service is not configured." });

    const orientation = ["landscape", "portrait", "square"].includes(body.orientation) ? body.orientation : "landscape";
    const quality = ["480p", "720p", "1080p", "veolite", "veofast", "veo", "kling4k", "seedance480", "seedance720", "seedance1080", "seedance4k"].includes(body.quality) ? body.quality : "480p";
    const tool = typeof body.tool === "string" ? body.tool.slice(0, 40) : "video";
    // Vestigial: Gemini-API Veo audio is always native and can't be disabled, and
    // the "veo" tier is always charged the audio rate above. Kept only so an older
    // client sending {audio:false} doesn't break; it no longer changes anything.
    const wantAudio = body.audio !== false;

    const DUR = {
      "480p": [5, 10], "720p": [5, 10], "1080p": [5, 10, 15],
      "veolite": [4, 6, 8], "veofast": [4, 6, 8], "veo": [4, 6, 8],
      "kling4k": [5, 10, 15],
      "seedance480": [5, 10, 15], "seedance720": [5, 10, 15], "seedance1080": [5, 10, 15], "seedance4k": [5, 10, 15]
    };
    const allowed = DUR[quality];
    let duration = allowed.includes(Number(body.duration)) ? Number(body.duration) : allowed[0];

    // ── Auth + server-decided cost (computed here, never trusted from client) ──
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again to generate." });
    const cost = videoCost(quality, duration, wantAudio);

    const SIZES = {
      "480p": { landscape: "832*480", portrait: "480*832", square: "480*480" },
      "720p": { landscape: "1280*720", portrait: "720*1280", square: "720*720" }
    };
    const ASPECTS = { landscape: "16:9", portrait: "9:16", square: "1:1" };
    const VEO_ASPECT = orientation === "portrait" ? "9:16" : "16:9"; // Veo: 16:9 / 9:16 only

    const image = body.image;
    let imageUrl = null;

    // ── Veo tiers go DIRECT to Google (no WaveSpeed) ──────────────────────
    if (isVeo) {
      const GOOGLE_MODEL = {
        veolite: "veo-3.1-lite-generate-preview",
        veofast: "veo-3.1-fast-generate-preview",
        veo:     "veo-3.1-generate-preview",
      }[quality];
      const resolution = quality === "veo" ? "1080p" : "720p";

      // Google accepts the image inline as base64 (no separate upload step).
      const instance = { prompt };
      if (image && /^data:.*;base64,/.test(image)) {
        const m = image.match(/^data:(.*?);base64,(.*)$/);
        instance.image = { bytesBase64Encoded: (m && m[2]) || "", mimeType: (m && m[1]) || "image/png" };
      } else if (image && /^https?:\/\//.test(image)) {
        // Fetch the remote image and inline it.
        try {
          const ir = await fetch(image);
          const buf = Buffer.from(await ir.arrayBuffer());
          instance.image = { bytesBase64Encoded: buf.toString("base64"), mimeType: ir.headers.get("content-type") || "image/png" };
        } catch { /* proceed as text-to-video */ }
      }

      // Deduct credits before starting.
      const paidG = await spend(token, cost, "video:" + quality + ":" + duration + "s");
      if (!paidG.ok) return res.status(402).json({ error: paidG.error });

      const gr = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + GOOGLE_MODEL + ":predictLongRunning",
        {
          method: "POST",
          headers: { "x-goog-api-key": GKEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            instances: [instance],
            // Gemini API accepts ONLY these Veo parameters. Audio is native/automatic
            // here (no generateAudio flag), and it returns a single video (no
            // sampleCount). Sending either of those makes Google reject the request.
            parameters: {
              aspectRatio: VEO_ASPECT,
              resolution: resolution,
              durationSeconds: duration, // MUST be a number here (the API rejects a string)
            },
          }),
        }
      );
      const gdata = await gr.json();
      if (!gr.ok) {
        await refund(userId, cost, "refund:video-submit");
        const msg = (gdata && gdata.error && gdata.error.message) || "Video service error";
        return res.status(gr.status).json({ error: msg + " Your credits were refunded." });
      }
      const opName = gdata && gdata.name; // e.g. "models/veo-.../operations/abc123"
      if (!opName) {
        await refund(userId, cost, "refund:video-noid");
        return res.status(502).json({ error: "No job id returned. Your credits were refunded." });
      }
      const gid = "g:" + opName;            // "g:" tells video-result.js to poll Google
      await recordVideoJob(gid, userId, cost);
      await logCost(gid, userId, tool, quality, duration, cost, realUsd(quality, duration));
      return res.status(200).json({ id: gid, balance: paidG.balance });
    }
    // ── everything below here is WaveSpeed ────────────────────────────────

    if (image && /^https?:\/\//.test(image)) {
      imageUrl = image;
    } else if (image && /^data:.*;base64,/.test(image)) {
      const m = image.match(/^data:(.*?);base64,(.*)$/);
      const mime = (m && m[1]) || "image/png";
      const b64 = (m && m[2]) || "";
      const bytes = Buffer.from(b64, "base64");
      const ext = (mime.split("/")[1] || "png").split("+")[0];
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: mime }), "upload." + ext);

      const up = await fetch("https://api.wavespeed.ai/api/v3/media/upload/binary", {
        method: "POST",
        headers: { "Authorization": "Bearer " + key },
        body: form
      });
      const upData = await up.json();
      if (!up.ok) {
        return res.status(up.status).json({ error: (upData && upData.message) || "Couldn't upload your photo." });
      }
      imageUrl = upData && upData.data && upData.data.download_url;
      if (!imageUrl) return res.status(502).json({ error: "Photo upload returned no URL." });
    }

    let modelPath, input;
    if (quality.indexOf("seedance") === 0) {
      // Seedance 2.0 (native audio included; duration is a string). Resolution is
      // chosen by the tier: seedance480 → 480p, 720 → 720p, 1080 → 1080p, else 4k.
      const seedRes = quality === "seedance480" ? "480p" : quality === "seedance720" ? "720p" : quality === "seedance1080" ? "1080p" : "4k";
      if (imageUrl) {
        modelPath = "bytedance/seedance-2.0/image-to-video";
        input = { prompt, image: imageUrl, resolution: seedRes, aspect_ratio: ASPECTS[orientation], duration: String(duration) };
      } else {
        modelPath = "bytedance/seedance-2.0/text-to-video";
        input = { prompt, resolution: seedRes, aspect_ratio: ASPECTS[orientation], duration: String(duration) };
      }
    } else if (quality === "kling4k") {
      // 4K Ultra — Kling 3.0 4K (sound included, doesn't change price)
      if (imageUrl) {
        modelPath = "kwaivgi/kling-v3.0-4k/image-to-video";
        input = { prompt, image: imageUrl, duration: duration, sound: true, cfg_scale: 0.5 };
      } else {
        modelPath = "kwaivgi/kling-v3.0-4k/text-to-video";
        input = { prompt, duration: duration, aspect_ratio: ASPECTS[orientation], sound: true, cfg_scale: 0.5 };
      }
    } else if (quality === "1080p") {
      // Premium — WAN 2.7
      if (imageUrl) {
        modelPath = "alibaba/wan-2.7/image-to-video";
        input = { prompt, image: imageUrl, resolution: "1080p", duration: duration, seed: -1 };
      } else {
        modelPath = "alibaba/wan-2.7/text-to-video";
        input = { prompt, resolution: "1080p", aspect_ratio: ASPECTS[orientation], duration: duration, seed: -1 };
      }
    } else {
      // Standard / HD — WAN 2.2
      if (imageUrl) {
        modelPath = quality === "720p" ? "wavespeed-ai/wan-2.2/i2v-720p" : "wavespeed-ai/wan-2.2/i2v-480p";
        input = { prompt, image: imageUrl, duration: duration, seed: -1 };
      } else {
        modelPath = quality === "720p" ? "wavespeed-ai/wan-2.2/t2v-720p-ultra-fast" : "wavespeed-ai/wan-2.2/t2v-480p-ultra-fast";
        input = { prompt, size: SIZES[quality][orientation], duration: duration, seed: -1 };
      }
    }

    // ── Deduct credits before starting the job ──
    const paid = await spend(token, cost, "video:" + quality + ":" + duration + "s");
    if (!paid.ok) return res.status(402).json({ error: paid.error });

    const r = await fetch("https://api.wavespeed.ai/api/v3/" + modelPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + key
      },
      body: JSON.stringify(input)
    });

    const data = await r.json();
    if (!r.ok) {
      await refund(userId, cost, "refund:video-submit");
      return res.status(r.status).json({ error: ((data && data.message) || "Video service error") + " Your credits were refunded." });
    }
    const id = data && data.data && data.data.id;
    if (!id) {
      await refund(userId, cost, "refund:video-noid");
      return res.status(502).json({ error: "No prediction id returned. Your credits were refunded." });
    }
    await recordVideoJob(id, userId, cost); // so a later failure can be refunded
    await logCost(id, userId, tool, quality, duration, cost, realUsd(quality, duration));
    return res.status(200).json({ id, balance: paid.balance });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
