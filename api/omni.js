// Chelgy — Gemini Omni Flash video (STRAIGHT from Google, no middlemen).
// Uses the Interactions API: POST /v1beta/interactions with model
// "gemini-omni-flash-preview". Text-to-video sends a string input; image-to-video
// sends an array of parts ({type:image,data,mime_type} + {type:text,text}). We ask
// for delivery:"uri" so the response hands back a Google file URI; the frontend
// then polls /api/omni-result and streams the finished clip through /api/omni-download.
//
// Priced flat at 2500 credits for an "up to 10-second" clip — Omni is $0.10/s, so
// a 10s clip really costs ~$1.00; 2500 credits ≈ $2 keeps a clean ~2x margin and,
// because duration isn't a controllable field, flat pricing never undercharges.
// Env: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

export const maxDuration = 60; // create can take a moment before returning the file URI

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const OMNI_COST = 2500;   // flat, "up to 10 seconds"
const OMNI_USD  = 1.00;   // real cost of a 10s clip ($0.10/s)

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
async function logCost(id, userId, tool, model, credits, estUsd) {
  try {
    await fetch(SB_URL + "/rest/v1/cost_log", {
      method: "POST",
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ id: String(id), user_id: userId, tool: tool || "omni", model, duration: 10, credits_charged: credits, est_usd: estUsd })
    });
  } catch {}
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const prompt = (body.prompt || "").trim();
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    const GKEY = (process.env.GEMINI_API_KEY || "").trim();
    if (!GKEY) return res.status(500).json({ error: "Video service is not configured." });

    const orientation = ["portrait", "landscape", "square"].includes(body.orientation) ? body.orientation : "landscape";
    const aspect = orientation === "portrait" ? "9:16" : "16:9"; // Omni: 9:16 or 16:9 only
    const tool = typeof body.tool === "string" ? body.tool.slice(0, 40) : "omni";

    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again to generate." });

    // ── Build the interaction input (text-only, or image parts for animate) ──
    let input, task;
    const images = [];
    if (body.image) images.push(body.image);
    if (Array.isArray(body.reference_images)) images.push(...body.reference_images);
    const parts = [];
    for (const src of images.slice(0, 6)) {
      if (typeof src !== "string") continue;
      const m = src.match(/^data:(.*?);base64,(.*)$/);
      if (!m) continue;
      parts.push({ type: "image", data: m[2] || "", mime_type: m[1] || "image/jpeg" });
    }
    if (parts.length) {
      parts.push({ type: "text", text: prompt });
      input = parts;
      task = "image_to_video";
    } else {
      input = prompt;
      task = "text_to_video";
    }

    // ── Charge (flat) before starting ──
    const paid = await spend(token, OMNI_COST, "omni:" + task);
    if (!paid.ok) return res.status(402).json({ error: paid.error });

    const gr = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "x-goog-api-key": GKEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-omni-flash-preview",
        input,
        response_format: { type: "video", aspect_ratio: aspect, delivery: "uri" },
        generation_config: { video_config: { task } }
      })
    });
    const gdata = await gr.json();
    if (!gr.ok) {
      await refund(userId, OMNI_COST, "refund:omni-submit");
      const msg = (gdata && gdata.error && gdata.error.message) || "Video service error";
      return res.status(gr.status).json({ error: msg + " Your credits were refunded." });
    }

    // Find the Google file URI in the response and extract the file id.
    const fileId = extractFileId(gdata);
    if (!fileId) {
      await refund(userId, OMNI_COST, "refund:omni-nouri");
      return res.status(502).json({ error: "No video id returned. Your credits were refunded." });
    }

    await recordVideoJob("omni:" + fileId, userId, OMNI_COST);
    await logCost("omni:" + fileId, userId, tool, "gemini-omni-flash", OMNI_COST, OMNI_USD);
    return res.status(200).json({ id: fileId, balance: paid.balance });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}

// Pull the "files/XXXX" id out of the interaction response (uri lives in the
// model_output step's video content, or the SDK convenience field output_video).
function extractFileId(data) {
  const uris = [];
  if (data && data.output_video && data.output_video.uri) uris.push(data.output_video.uri);
  if (data && Array.isArray(data.steps)) {
    for (const step of data.steps) {
      const content = step && step.content;
      if (Array.isArray(content)) {
        for (const c of content) { if (c && c.uri) uris.push(c.uri); }
      }
    }
  }
  for (const u of uris) {
    const m = String(u).match(/files\/([^:?/]+)/);
    if (m) return m[1];
  }
  return null;
}
