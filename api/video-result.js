// Chelgy back room — checks on a video job and returns the finished video link.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const id = body.id;
    if (!id) return res.status(400).json({ error: "Missing id" });

    const r = await fetch("https://api.wavespeed.ai/api/v3/predictions/" + id + "/result", {
      headers: { "Authorization": "Bearer " + process.env.WAVESPEED_API_KEY }
    });

    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: (data && data.message) || "Video service error" });
    }
    const d = (data && data.data) || {};
    return res.status(200).json({
      status: d.status || "processing",
      output: (d.outputs && d.outputs[0]) || null
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error" });
  }
}
