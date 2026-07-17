// Chelgy AI Video Editor — LARGE-FOOTAGE OPTIMIZER (proxy transcode).
// Real camera files can be 5-20GB, which uploads fine (resumable chunks) but is
// too heavy for the downstream pipeline to keep re-fetching. So for big files we
// first run a Creatomate "optimize" render: their infrastructure pulls the giant
// source ONCE and outputs a lean 1080p mp4 — audio fully preserved — and the
// whole pipeline (transcription, edit render, viral clips) works from that lean
// copy. Output quality is unaffected: the final video is 1080p regardless.
//
// Charged per raw minute (real ~$0.12/min of render time → 250 credits ≈ 2x).
// The job is recorded in video_jobs so /api/studio-status auto-refunds if the
// optimize fails. action:"delete" removes the finished proxy from Creatomate
// storage once the edit is done.
// Env: CREATOMATE_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

export const maxDuration = 60;

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const PROXY_PER_MIN = 250;       // credits per raw minute (real ~$0.12/min → ~2x)
const MAX_RAW_SECONDS = 600;

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
async function logCost(id, userId, duration, credits, estUsd) {
  try {
    await fetch(SB_URL + "/rest/v1/cost_log", {
      method: "POST",
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ id: String(id), user_id: userId, tool: "video_editor", model: "creatomate-proxy", duration: Math.round(duration) || null, credits_charged: credits, est_usd: estUsd })
    });
  } catch {}
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const CM = (process.env.CREATOMATE_API_KEY || "").trim();
    if (!CM) return res.status(500).json({ error: "The editor is not configured yet (render key missing)." });

    // ── Cleanup: delete a finished proxy from Creatomate storage ──
    if (body.action === "delete") {
      const rid = String(body.id || "").replace(/^cm:/, "").trim();
      if (rid) {
        try { await fetch("https://api.creatomate.com/v2/renders/" + encodeURIComponent(rid), { method: "DELETE", headers: { Authorization: "Bearer " + CM } }); } catch {}
      }
      return res.status(200).json({ ok: true });
    }

    const url = body.url;
    const orientation = body.orientation === "landscape" ? "landscape" : "portrait";
    const rawDuration = Number(body.rawDuration) || 0;
    if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: "Missing video URL." });
    if (rawDuration > MAX_RAW_SECONDS) return res.status(400).json({ error: "Raw footage is limited to 10 minutes for now." });

    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again." });

    const minutes = Math.max(1, Math.ceil((rawDuration || 60) / 60));
    const cost = minutes * PROXY_PER_MIN;
    const paid = await spend(token, cost, "video-editor:optimize");
    if (!paid.ok) return res.status(402).json({ error: paid.error });

    const W = orientation === "landscape" ? 1920 : 1080;
    const H = orientation === "landscape" ? 1080 : 1920;
    const cr = await fetch("https://api.creatomate.com/v2/renders", {
      method: "POST",
      headers: { Authorization: "Bearer " + CM, "Content-Type": "application/json" },
      body: JSON.stringify({
        output_format: "mp4", width: W, height: H, frame_rate: 30,
        elements: [{ type: "video", track: 1, source: url, fit: "cover" }]
      })
    });
    const cdata = await cr.json();
    if (!cr.ok) {
      await refund(userId, cost, "refund:video-editor-optimize");
      const msg = (cdata && (cdata.message || (cdata.error && cdata.error.message))) || "Optimize service error";
      return res.status(cr.status).json({ error: String(msg) + " Your credits were refunded." });
    }
    const render = Array.isArray(cdata) ? cdata[0] : cdata;
    const rid = render && render.id;
    if (!rid) {
      await refund(userId, cost, "refund:video-editor-optimize-noid");
      return res.status(502).json({ error: "No optimize job returned. Your credits were refunded." });
    }

    await recordVideoJob("cm:" + rid, userId, cost);
    const estUsd = Math.round((0.12 * minutes) * 10000) / 10000;
    await logCost("cm:" + rid, userId, rawDuration, cost, estUsd);
    return res.status(200).json({ id: "cm:" + rid, balance: paid.balance, charged: cost });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
