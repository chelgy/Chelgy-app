// Chelgy back room — starts a video job on WaveSpeed.
// Your key lives in Vercel as WAVESPEED_API_KEY, never in public code.
// Quality tiers:
//   480p / 720p  -> WAN 2.2      (fast, economical)          | 5/10s   | "size"
//   1080p        -> WAN 2.7      (premium)                   | 5/10/15 | "resolution" + "aspect_ratio"
//   veo          -> Veo 3.1      (Hollywood-grade + audio)   | 4/6/8s  | "resolution" + "aspect_ratio" + "generate_audio"
//   kling4k      -> Kling 3.0 4K (true 4K cinematic)         | 5/10/15 | "duration" + "aspect_ratio" + "sound"
//   seedance4k   -> Seedance 2.0 (4K multi-shot, native A/V) | 5/10/15 | "resolution":"4K" + "aspect_ratio"
//
// Credits are deducted server-side BEFORE the job starts; the job is recorded
// so a later failure (caught in video-result.js) can be refunded automatically.
// Env: WAVESPEED_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

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
function videoCost(quality, duration, wantAudio) {
  const d = Number(duration);
  if (quality === "veo") return (wantAudio ? 1250 : 625) * d;
  if (quality === "kling4k") return 1300 * d;
  if (quality === "seedance4k") return 4600 * d;
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
    if (!key) return res.status(500).json({ error: "Video service is not configured." });

    const orientation = ["landscape", "portrait", "square"].includes(body.orientation) ? body.orientation : "landscape";
    const quality = ["480p", "720p", "1080p", "veo", "kling4k", "seedance4k"].includes(body.quality) ? body.quality : "480p";
    const wantAudio = body.audio !== false; // default true (Veo only)

    const DUR = {
      "480p": [5, 10], "720p": [5, 10], "1080p": [5, 10, 15],
      "veo": [4, 6, 8], "kling4k": [5, 10, 15], "seedance4k": [5, 10, 15]
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
    if (quality === "seedance4k") {
      // 4K Max — Seedance 2.0 (native audio included; duration is a string)
      if (imageUrl) {
        modelPath = "bytedance/seedance-2.0/image-to-video";
        input = { prompt, image: imageUrl, resolution: "4k", aspect_ratio: ASPECTS[orientation], duration: String(duration) };
      } else {
        modelPath = "bytedance/seedance-2.0/text-to-video";
        input = { prompt, resolution: "4k", aspect_ratio: ASPECTS[orientation], duration: String(duration) };
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
    } else if (quality === "veo") {
      // Cinematic Pro — Google Veo 3.1 (native 1080p + synchronized audio)
      if (imageUrl) {
        modelPath = "google/veo3.1/image-to-video";
        input = { prompt, image: imageUrl, aspect_ratio: VEO_ASPECT, resolution: "1080p", duration: duration, generate_audio: wantAudio, seed: -1 };
      } else {
        modelPath = "google/veo3.1/text-to-video";
        input = { prompt, aspect_ratio: VEO_ASPECT, resolution: "1080p", duration: duration, generate_audio: wantAudio, seed: -1 };
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
    return res.status(200).json({ id, balance: paid.balance });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
