// Chelgy back room — keeps your ElevenLabs API key private.
// The key lives in Vercel's settings as ELEVENLABS_API_KEY, never in your public code.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const text = body.text;
    const voiceId = body.voiceId || "JBFqnCBsd6RMkjVDRZzb";

    if (!text || !String(text).trim()) {
      return res.status(400).json({ error: "Missing text" });
    }

    const key = (process.env.ELEVENLABS_API_KEY || "").trim();
    if (!key) {
      return res.status(500).json({ error: "No voiceover key reached the server. Check the ELEVENLABS_API_KEY name in Vercel and that a fresh deploy ran." });
    }

    const r = await fetch("https://api.elevenlabs.io/v1/text-to-speech/" + voiceId, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": key
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      })
    });

    if (!r.ok) {
      let msg = "Voiceover service error";
      try {
        const err = await r.json();
        const d = err && err.detail;
        msg = (d && (d.message || d)) || (err && err.message) || msg;
        if (typeof msg === "object") msg = JSON.stringify(msg);
      } catch (_) {}
      return res.status(r.status).json({ error: String(msg) });
    }

    const audio = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", audio.length);
    return res.status(200).send(audio);
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
