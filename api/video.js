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

    const key = (process.env.WAVESPEED_API_KEY || "").trim();
    if (!key) return res.status(500).json({ error: "Video service is not configured." });

    const image = body.image;
    let imageUrl = null;

    // If a photo was provided, get it to WaveSpeed as a hosted URL so image-to-video can use it.
    if (image && /^https?:\/\//.test(image)) {
      // Already a public web link
      imageUrl = image;
    } else if (image && /^data:.*;base64,/.test(image)) {
      // Uploaded photo (base64). Upload it to WaveSpeed's media endpoint to get a URL.
      const m = image.match(/^data:(.*?);base64,(.*)$/);
      const mime = (m && m[1]) || "image/png";
      const b64 = (m && m[2]) || "";
      const bytes = Buffer.from(b64, "base64");
      const ext = (mime.split("/")[1] || "png").split("+")[0];
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: mime }), "upload." + ext);

      const up = await fetch("https://api.wavespeed.ai/api/v3/media/upload/binary", {
        method: "POST",
        headers: { "Authorization": "Bearer " + key },
        body: form
      });
      const upData = await up.json();
      if (!up.ok) {
        return res.status(up.status).json({ error: (upData && upData.message) || "Couldn't upload your photo." });
      }
      imageUrl = upData && upData.data && upData.data.download_url;
      if (!imageUrl) return res.status(502).json({ error: "Photo upload returned no URL." });
    }

    let modelPath, input;
    if (imageUrl) {
      modelPath = "wavespeed-ai/wan-2.2/i2v-480p";
      input = { prompt, image: imageUrl, duration: 5, seed: -1 };
    } else {
      modelPath = "wavespeed-ai/wan-2.2/t2v-480p-ultra-fast";
      input = { prompt, size: "832*480", duration: 5, seed: -1 };
    }

    const r = await fetch("https://api.wavespeed.ai/api/v3/" + modelPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + key
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
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
