// Chelgy — poll a Gemini Omni Flash job. The frontend sends the file id (from
// /api/omni); we check the Google Files API state and, once ACTIVE, hand back a
// same-origin streaming URL (/api/omni-download) the browser can play + save.
// Shape mirrors /api/video-result so the frontend's pollVideo can reuse it.
// Env: GEMINI_API_KEY

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const id = String(body.id || "").replace(/^omni:/, "").trim();
    if (!id) return res.status(400).json({ error: "Missing id" });

    const GKEY = (process.env.GEMINI_API_KEY || "").trim();
    if (!GKEY) return res.status(500).json({ error: "Video service is not configured." });

    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/files/" + encodeURIComponent(id), {
      headers: { "x-goog-api-key": GKEY }
    });
    const data = await r.json();
    if (!r.ok) return res.status(200).json({ status: "processing" }); // transient — keep polling

    const state = (data && (data.state || data.status) || "").toString().toUpperCase();
    if (state === "ACTIVE") {
      return res.status(200).json({ status: "completed", output: "/api/omni-download?f=" + encodeURIComponent(id) });
    }
    if (state === "FAILED") return res.status(200).json({ status: "failed" });
    return res.status(200).json({ status: "processing" });
  } catch (e) {
    return res.status(200).json({ status: "processing" });
  }
}
