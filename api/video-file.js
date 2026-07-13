// api/video-file.js — streams a Google (Veo) generated video to the browser.
//
// Google's video links require the API key to download. We never want that key
// in the browser, so this endpoint fetches the file server-side and pipes it
// back. video-result.js hands the front end a link that points here.
//
// Env: GEMINI_API_KEY

export default async function handler(req, res) {
  try {
    const u = req.query && req.query.u;
    if (!u) return res.status(400).json({ error: "Missing url" });

    // Only ever proxy Google's own file hosts — never an arbitrary URL.
    let target;
    try { target = new URL(String(u)); } catch { return res.status(400).json({ error: "Bad url" }); }
    const okHost = /(^|\.)googleapis\.com$/.test(target.hostname);
    if (!okHost) return res.status(403).json({ error: "Not allowed" });

    const key = (process.env.GEMINI_API_KEY || "").trim();
    if (!key) return res.status(500).json({ error: "Video service is not configured." });

    const r = await fetch(target.toString(), { headers: { "x-goog-api-key": key } });
    if (!r.ok) return res.status(r.status).json({ error: "Could not fetch the video." });

    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", r.headers.get("content-type") || "video/mp4");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(500).json({ error: "Server error" });
  }
}
