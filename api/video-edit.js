// Chelgy — Fake It "Video Edit".
// Keeps the person + their motion from a SOURCE VIDEO and rewrites the world
// around them, guided by REFERENCE IMAGES. Runs on ByteDance Seedance 2.0
// Video Edit via WaveSpeed:  POST /api/v3/bytedance/seedance-2.0/video-edit
//   inputs: prompt, video (URL), reference_images (URLs), resolution, generate_audio
//   duration is auto-detected from the input clip (clamped 4–15s) — no field.
//
// The source video is passed as a URL: the app uploads it to Supabase Storage
// first (browser → Supabase, so we never push a big file through Vercel's ~4.5MB
// body limit), then hands us the public URL. Reference images arrive as small
// data URLs and are uploaded to WaveSpeed here.
//
// Billing is per second across INPUT + OUTPUT duration, so we charge the chosen
// resolution's per-second rate × duration × 2. Credits are deducted before the
// job starts and refunded automatically if submission fails.
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
// Real (calibrated) video-to-video cost. Anchored to WaveSpeed's dashboard:
// ~$10 for a 15s 1080p edit → ~$0.667/s at 1080p. Recalibrate as you see receipts.
function realUsdEdit(resolution, duration) {
  const d = Number(duration) || 0;
  const perSec = resolution === "1080p" ? 0.667 : resolution === "720p" ? 0.444 : 0.222; // 480p default
  return Math.round(perSec * d * 10000) / 10000;
}
async function logCost(id, userId, tool, model, duration, credits, estUsd) {
  try {
    await fetch(SB_URL + "/rest/v1/cost_log", {
      method: "POST",
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ id: String(id), user_id: userId, tool: tool || "video-edit", model, duration: Number(duration) || null, credits_charged: credits, est_usd: estUsd })
    });
  } catch {}
}
// Video Edit bills input + output seconds. We use the same 2x-markup Seedance
// per-second rate, then multiply by 1.85 — real video-to-video runs ~1.85x a
// plain generation (confirmed against WaveSpeed's dashboard: ~$10 for 15s 1080p).
function editCost(resolution, duration) {
  const d = Number(duration);
  const rate = resolution === "1080p" ? 900 : resolution === "720p" ? 600 : 300; // 480p default
  return Math.round(rate * d * 1.85);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const prompt = (body.prompt || "").trim();
    const video = body.video;
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });
    if (!video || !/^https?:\/\//.test(video)) return res.status(400).json({ error: "Missing source video." });

    const key = (process.env.WAVESPEED_API_KEY || "").trim();
    if (!key) return res.status(500).json({ error: "Video service is not configured." });

    const resolution = ["480p", "720p", "1080p"].includes(body.resolution) ? body.resolution : "720p";
    let duration = Number(body.duration);
    if (!Number.isFinite(duration)) duration = 5;
    duration = Math.max(4, Math.min(15, Math.round(duration))); // Seedance clamps 4–15s

    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again to generate." });
    const cost = editCost(resolution, duration);

    // ── Upload reference images (small data URLs) to WaveSpeed → URLs ──────────
    const refUrls = [];
    const refs = Array.isArray(body.reference_images) ? body.reference_images.slice(0, 4) : [];
    for (const ref of refs) {
      if (typeof ref !== "string") continue;
      if (/^https?:\/\//.test(ref)) { refUrls.push(ref); continue; }
      const m = ref.match(/^data:(.*?);base64,(.*)$/);
      if (!m) continue;
      try {
        const mime = m[1] || "image/jpeg";
        const bytes = Buffer.from(m[2] || "", "base64");
        const ext = (mime.split("/")[1] || "jpg").split("+")[0];
        const form = new FormData();
        form.append("file", new Blob([bytes], { type: mime }), "ref." + ext);
        const up = await fetch("https://api.wavespeed.ai/api/v3/media/upload/binary", {
          method: "POST", headers: { Authorization: "Bearer " + key }, body: form
        });
        const upData = await up.json();
        const url = upData && upData.data && upData.data.download_url;
        if (url) refUrls.push(url);
      } catch { /* skip a reference we couldn't upload */ }
    }

    // ── Deduct credits before starting ────────────────────────────────────────
    const paid = await spend(token, cost, "video-edit:" + resolution + ":" + duration + "s");
    if (!paid.ok) return res.status(402).json({ error: paid.error });

    // ── Submit the edit. No duration field — Seedance matches the input clip.
    // aspect_ratio is intentionally omitted so output follows the source video.
    const input = { prompt, video, resolution, generate_audio: true };
    if (refUrls.length) input.reference_images = refUrls;

    const r = await fetch("https://api.wavespeed.ai/api/v3/bytedance/seedance-2.0/video-edit", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify(input)
    });
    const data = await r.json();
    if (!r.ok) {
      await refund(userId, cost, "refund:video-edit-submit");
      return res.status(r.status).json({ error: ((data && data.message) || "Video edit service error") + " Your credits were refunded." });
    }
    const id = data && data.data && data.data.id;
    if (!id) {
      await refund(userId, cost, "refund:video-edit-noid");
      return res.status(502).json({ error: "No prediction id returned. Your credits were refunded." });
    }
    await recordVideoJob(id, userId, cost); // so a later failure can be refunded
    await logCost(id, userId, "video-edit", "seedance-edit-" + resolution, duration, cost, realUsdEdit(resolution, duration));
    return res.status(200).json({ id, balance: paid.balance });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
