// Chelgy AI Video Editor — STEP 4: poll a render.
//
// Two engines, one response shape. Viral clips now render on the Chelgy render
// server ("ff:" ids, state in the render_jobs table); older Creatomate jobs ("cm:")
// still poll Creatomate so anything already in flight finishes normally. Both are
// translated into the completed/processing/failed shape the frontend already speaks,
// so nothing in the app had to change.
// Mirrors /api/video-result's shape so the frontend's pollVideo can reuse it.
// On a failed render, the job's credits are refunded automatically (the job row
// is deleted after refunding so repeated polls can't double-refund).
// Env: CREATOMATE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_SVC = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();

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

    // ── Chelgy render server job ────────────────────────────────────────────────
    // State lives in Postgres, so there is no render server in the polling path.
    if (/^ff:/.test(fullId)) {
      const jid = fullId.replace(/^ff:/, "").trim();
      if (!jid) return res.status(400).json({ error: "Missing id" });
      try {
        const q = await fetch(SB_URL + "/rest/v1/render_jobs?id=eq." + encodeURIComponent(jid) +
                              "&select=status,output_url,error", {
          headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC }
        });
        const rows = await q.json();
        const j = Array.isArray(rows) && rows[0];
        // No row yet: the plan call has returned but the row may not be visible for a
        // moment. Keep polling rather than reporting a failure that would refund a
        // render still on its way.
        if (!j) return res.status(200).json({ status: "processing" });
        if (j.status === "done" && j.output_url) return res.status(200).json({ status: "completed", output: j.output_url });
        if (j.status === "error") {
          await refundJob(fullId);
          return res.status(200).json({ status: "failed" });
        }
        return res.status(200).json({ status: "processing" });
      } catch {
        return res.status(200).json({ status: "processing" }); // transient — keep polling
      }
    }

    // ── Legacy Creatomate job ───────────────────────────────────────────────────
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
