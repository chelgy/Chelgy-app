// Chelgy back room — keeps your Gemini API key private.
// The key lives in Vercel's settings as GEMINI_API_KEY, never in your public code.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const prompt = body.prompt;
    const inputImage = body.inputImage; // optional { mimeType, data }

    // Orientation / aspect ratio — only allow values Gemini actually supports.
    const allowedRatios = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
    const aspectRatio = allowedRatios.includes(body.aspectRatio) ? body.aspectRatio : "1:1";

    // Quality tier:
    //   "standard" -> Nano Banana (Gemini 2.5 Flash Image), ~1K, cheapest
    //   "2K"       -> Nano Banana Pro (Gemini 3 Pro Image), 2K, higher cost
    //   "4K"       -> Nano Banana Pro (Gemini 3 Pro Image), 4K, highest cost
    const quality = ["standard", "2K", "4K"].includes(body.quality) ? body.quality : "standard";

    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({ error: "Missing prompt" });
    }

    const key = (process.env.GEMINI_API_KEY || "").trim();
    if (!key) {
      return res.status(500).json({ error: "Image service is not configured." });
    }

    const parts = inputImage && inputImage.data
      ? [{ inlineData: { mimeType: inputImage.mimeType, data: inputImage.data } }, { text: prompt }]
      : [{ text: prompt }];

    // Pick the model + image config based on the quality tier.
    let model, imageConfig;
    if (quality === "standard") {
      model = "gemini-2.5-flash-image";
      imageConfig = { aspectRatio: aspectRatio };
    } else {
      // Nano Banana Pro handles 2K and 4K via imageSize.
      model = "gemini-3-pro-image-preview";
      imageConfig = { aspectRatio: aspectRatio, imageSize: quality }; // "2K" or "4K"
    }

    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(key),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            imageConfig: imageConfig
          }
        })
      }
    );

    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: (data && data.error && data.error.message) || "Image service error" });
    }

    const candidates = data.candidates || [];
    const outParts = (candidates[0] && candidates[0].content && candidates[0].content.parts) || [];
    const img = outParts.find(p => p.inlineData);
    if (!img) {
      return res.status(502).json({ error: "No image was returned. Please try again." });
    }

    const image = "data:" + img.inlineData.mimeType + ";base64," + img.inlineData.data;
    return res.status(200).json({ image });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
