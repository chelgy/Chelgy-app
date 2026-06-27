// api/image.js — secure Gemini image generation for Chelgy
// The Gemini API key lives ONLY here, in a Vercel Environment Variable.
// Set GEMINI_API_KEY in your Vercel project settings (Sensitive ON).

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Image service is not configured." });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const prompt = body.prompt;
    const inputImage = body.inputImage; // optional { mimeType, data }

    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({ error: "Missing prompt." });
    }

    const parts = inputImage && inputImage.data
      ? [{ inlineData: { mimeType: inputImage.mimeType, data: inputImage.data } }, { text: prompt }]
      : [{ text: prompt }];

    const geminiRes = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        }),
      }
    );

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      const msg =
        data && data.error && data.error.message
          ? data.error.message
          : "Image generation failed.";
      return res.status(geminiRes.status).json({ error: msg });
    }

    const candidates = data.candidates || [];
    const outParts =
      candidates[0] && candidates[0].content && candidates[0].content.parts
        ? candidates[0].content.parts
        : [];
    const img = outParts.find((p) => p.inlineData);

    if (!img) {
      return res.status(502).json({ error: "No image was returned. Please try again." });
    }

    const image = "data:" + img.inlineData.mimeType + ";base64," + img.inlineData.data;
    return res.status(200).json({ image });
  } catch (err) {
    return res
      .status(500)
      .json({ error: "Image generation error: " + (err && err.message ? err.message : "unknown") });
  }
};
