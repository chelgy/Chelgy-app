// Chelgy AI Video Editor — STEP 4: poll a Creatomate render.
// Mirrors /api/video-result's shape so the frontend's pollVideo can reuse it.
// On a failed render, the job's credits are refunded automatically (the job row
// is deleted after refunding so repeated polls can't double-refund).
// Env: CREATOMATE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_SVC = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

async function refundJob(fullId) {
  try {
    // Look up the recorded job for cost + user
    const q = await fetch(SB_URL + "/rest/v1/video_jobs?id=eq." + encodeURIComponent(fullId) + "&select=user_id,cost", {
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC }
    });
    const rows = await q.json();
    const job = Array.isArray(rows) && rows[0];
    if (!job || !job.user_id || !job.cost) return;
    await fetch(SB_URL + "/rest/v1/rpc/add_credits", {
      method: "POST",
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json" },
      body: JSON.stringify({ p_user: job.user_id, p_amount: job.cost, p_reason: "refund:video-editor-failed" })
    });
    // Delete the row so a repeat poll can't refund twice
    await fetch(SB_URL + "/rest/v1/video_jobs?id=eq." + encodeURIComponent(fullId), {
      method: "DELETE",
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC }
    });
  } catch {}
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const fullId = String(body.id || "");
    const rid = fullId.replace(/^cm:/, "").trim();
    if (!rid) return res.status(400).json({ error: "Missing id" });

    const CM = (process.env.CREATOMATE_API_KEY || "").trim();
    if (!CM) return res.status(500).json({ error: "Not configured" });

    const r = await fetch("https://api.creatomate.com/v2/renders/" + encodeURIComponent(rid), {
      headers: { Authorization: "Bearer " + CM }
    });
    const data = await r.json();
    if (!r.ok) return res.status(200).json({ status: "processing" }); // transient — keep polling

    const status = String((data && data.status) || "").toLowerCase();
    if (status === "succeeded" && data.url) {
      return res.status(200).json({ status: "completed", output: data.url });
    }
    if (status === "failed") {
      await refundJob(fullId);
      return res.status(200).json({ status: "failed" });
    }
    return res.status(200).json({ status: "processing" }); // planned / waiting / transcribing / rendering
  } catch (e) {
    return res.status(200).json({ status: "processing" });
  }
}
