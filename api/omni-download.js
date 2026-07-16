// Chelgy — stream a finished Gemini Omni Flash video. Google hosts the file
// behind the API key, so the browser can't fetch it directly; this same-origin
// proxy pulls it with the server key and streams the mp4 back for playback +
// download. Nothing is stored — the file just passes through.
// Env: GEMINI_API_KEY

export const maxDuration = 60;

export default async function handler(req, res) {
  try {
    const id = String((req.query && req.query.f) || "").replace(/^omni:/, "").trim();
    if (!id) return res.status(400).send("Missing file id");

    const GKEY = (process.env.GEMINI_API_KEY || "").trim();
    if (!GKEY) return res.status(500).send("Not configured");

    const g = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/files/" + encodeURIComponent(id) + ":download?alt=media",
      { headers: { "x-goog-api-key": GKEY } }
    );
    if (!g.ok) return res.status(g.status).send("Could not fetch video");

    res.setHeader("Content-Type", g.headers.get("content-type") || "video/mp4");
    res.setHeader("Content-Disposition", 'inline; filename="chelgy-omni.mp4"');
    res.setHeader("Cache-Control", "private, max-age=3600");

    const buf = Buffer.from(await g.arrayBuffer());
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(500).send("Server error");
  }
}
