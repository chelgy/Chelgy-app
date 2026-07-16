// Chelgy — Gemini Omni Flash VIDEO EDIT (budget tier for the Video Edit tool).
// Keeps the person/motion from a source clip and rewrites the world around them,
// guided by reference images — same idea as the Seedance edit, cheaper. Straight
// to Google via the Interactions API with task "edit".
//
// The source video is uploaded to Supabase by the app first; we fetch it here and
// pass it inline as base64 (Omni edits are short — up to 10s/720p — so clips stay
// small). Reference images come in as small data URLs. Output is retrieved via the
// same /api/omni-result + /api/omni-download poll/stream endpoints (id is "omni:").
//
// Flat 3000 credits (up to 10s). Real cost ≈ $1.30 ($0.10/s output + video input
// tokens), so ~2x. Note: editing uploaded videos isn't available in the EEA/UK/CH.
// Env: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

export const maxDuration = 60;

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const OMNI_EDIT_COST = 3000;
const OMNI_EDIT_USD  = 1.30;

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
      body: JSON.stringify({ id: String(id), user_id: userId, tool: tool || "video-edit", model, duration: 10, credits_charged: credits, est_usd: estUsd })
    });
  } catch {}
}
function extractFileId(data) {
  const uris = [];
  if (data && data.output_video && data.output_video.uri) uris.push(data.output_video.uri);
  if (data && Array.isArray(data.steps)) {
    for (const step of data.steps) {
      const content = step && step.content;
      if (Array.isArray(content)) for (const c of content) { if (c && c.uri) uris.push(c.uri); }
    }
  }
  for (const u of uris) { const m = String(u).match(/files\/([^:?/]+)/); if (m) return m[1]; }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const prompt = (body.prompt || "").trim();
    const video = body.video;
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });
    if (!video || !/^https?:\/\//.test(video)) return res.status(400).json({ error: "Missing source video." });

    const GKEY = (process.env.GEMINI_API_KEY || "").trim();
    if (!GKEY) return res.status(500).json({ error: "Video service is not configured." });

    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again to generate." });

    // ── Fetch the source clip and inline it as base64 ──
    let vb64, vmime;
    try {
      const vr = await fetch(video);
      if (!vr.ok) throw new Error("fetch");
      vmime = vr.headers.get("content-type") || "video/mp4";
      const buf = Buffer.from(await vr.arrayBuffer());
      if (buf.length > 18 * 1024 * 1024) return res.status(400).json({ error: "That clip is too large for Omni — use a shorter clip (Omni edits up to ~10 seconds) or pick Seedance." });
      vb64 = buf.toString("base64");
    } catch {
      return res.status(502).json({ error: "Couldn't read that video. Please try again." });
    }

    const content = [{ type: "video", mime_type: vmime, data: vb64 }];
    const refs = Array.isArray(body.reference_images) ? body.reference_images.slice(0, 4) : [];
    for (const src of refs) {
      if (typeof src !== "string") continue;
      const m = src.match(/^data:(.*?);base64,(.*)$/);
      if (m) content.push({ type: "image", data: m[2] || "", mime_type: m[1] || "image/jpeg" });
    }
    content.push({ type: "text", text: prompt });

    // ── Charge before starting ──
    const paid = await spend(token, OMNI_EDIT_COST, "omni-edit");
    if (!paid.ok) return res.status(402).json({ error: paid.error });

    const gr = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "x-goog-api-key": GKEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-omni-flash-preview",
        input: [{ type: "user_input", content }],
        response_format: { type: "video", delivery: "uri" },
        generation_config: { video_config: { task: "edit" } }
      })
    });
    const gdata = await gr.json();
    if (!gr.ok) {
      await refund(userId, OMNI_EDIT_COST, "refund:omni-edit-submit");
      const msg = (gdata && gdata.error && gdata.error.message) || "Video edit service error";
      return res.status(gr.status).json({ error: msg + " Your credits were refunded." });
    }
    const fileId = extractFileId(gdata);
    if (!fileId) {
      await refund(userId, OMNI_EDIT_COST, "refund:omni-edit-nouri");
      return res.status(502).json({ error: "No video id returned. Your credits were refunded." });
    }
    await recordVideoJob("omni:" + fileId, userId, OMNI_EDIT_COST);
    await logCost("omni:" + fileId, userId, "video-edit", "gemini-omni-edit", OMNI_EDIT_COST, OMNI_EDIT_USD);
    return res.status(200).json({ id: fileId, balance: paid.balance });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
