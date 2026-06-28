// api/video-result.js — checks a video job and returns the finished link.
// If the job FAILED, it refunds the credits that were charged at start —
// exactly once, server-side, without trusting the browser.
//
// Env: WAVESPEED_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_SVC = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

// Flip the job to refunded ONLY if it wasn't already; returns the job row if we
// were the one who flipped it (so the refund happens exactly once).
async function claimRefund(id) {
  try {
    const r = await fetch(
      SB_URL + "/rest/v1/video_jobs?id=eq." + encodeURIComponent(id) + "&refunded=eq.false",
      {
        method: "PATCH",
        headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify({ refunded: true })
      }
    );
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch { return null; }
}
async function addCredits(userId, amount, reason) {
  try {
    await fetch(SB_URL + "/rest/v1/rpc/add_credits", {
      method: "POST",
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json" },
      body: JSON.stringify({ p_user: userId, p_amount: amount, p_reason: reason })
    });
  } catch {}
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const id = body.id;
    if (!id) return res.status(400).json({ error: "Missing id" });

    const r = await fetch("https://api.wavespeed.ai/api/v3/predictions/" + id + "/result", {
      headers: { "Authorization": "Bearer " + process.env.WAVESPEED_API_KEY }
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: (data && data.message) || "Video service error" });

    const d = (data && data.data) || {};
    const status = d.status || "processing";

    // Auto-refund a failed job, exactly once
    if (status === "failed") {
      const job = await claimRefund(id);
      if (job && job.user_id && job.cost) {
        await addCredits(job.user_id, job.cost, "refund:video-failed");
      }
    }

    return res.status(200).json({ status, output: (d.outputs && d.outputs[0]) || null });
  } catch (e) {
    return res.status(500).json({ error: "Server error" });
  }
}
