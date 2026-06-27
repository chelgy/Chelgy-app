// Chelgy back room — starts a video job on WaveSpeed.
// Your key lives in Vercel as WAVESPEED_API_KEY, never in public code.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const prompt = body.prompt;
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    const image = body.image;
    let modelPath, input;
    // Image-to-video only works when the photo is a public web link.
    // Uploaded photos arrive as raw data, so we fall back to text-to-video for now.
    if (image && /^https?:\/\//.test(image)) {
      modelPath = "wavespeed-ai/wan-2.2/i2v-480p";
      input = { prompt, image, duration: 5, seed: -1 };
    } else {
      modelPath = "wavespeed-ai/wan-2.2/t2v-480p-ultra-fast";
      input = { prompt, size: "832*480", duration: 5, seed: -1 };
    }

    const r = await fetch("https://api.wavespeed.ai/api/v3/" + modelPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + process.env.WAVESPEED_API_KEY
      },
      body: JSON.stringify(input)
    });

    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: (data && data.message) || "Video service error" });
    }
    const id = data && data.data && data.data.id;
    if (!id) return res.status(502).json({ error: "No prediction id returned" });
    return res.status(200).json({ id });
  } catch (e) {
    return res.status(500).json({ error: "Server error" });
  }
}
