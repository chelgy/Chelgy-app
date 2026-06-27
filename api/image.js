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

    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({ error: "Missing prompt" });
    }
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "Image service is not configured (no API key)." });
    }

    const parts = inputImage && inputImage.data
      ? [{ inlineData: { mimeType: inputImage.mimeType, data: inputImage.data } }, { text: prompt }]
      : [{ text: prompt }];

    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] }
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
