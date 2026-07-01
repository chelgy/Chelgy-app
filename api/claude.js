// Chelgy back room — keeps your Anthropic API key private.
// The key lives in Vercel's settings as ANTHROPIC_API_KEY, never in your public code.
// Now supports an optional reference image so Claude can SEE a photo and write from it.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const prompt = body.prompt;
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    const maxTokens = Math.min(Math.max(parseInt(body.max_tokens, 10) || 1000, 1), 8192);
    const useSearch = body.web_search === true;

    // ── Parse any reference image(s) into Anthropic image blocks ──
    const ALLOWED = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    function parseImg(x) {
      if (!x) return null;
      if (typeof x === "object" && x.data) {
        const mt = ALLOWED.includes(x.media_type) ? x.media_type : "image/png";
        return { media_type: mt, data: x.data };
      }
      if (typeof x === "string") {
        const m = x.match(/^data:([^;]+);base64,(.*)$/);
        if (m) { const mt = ALLOWED.includes(m[1]) ? m[1] : "image/png"; return { media_type: mt, data: m[2] }; }
        return { media_type: "image/png", data: x }; // raw base64, assume png
      }
      return null;
    }
    let imgs = [];
    if (body.image) { const p = parseImg(body.image); if (p) imgs.push(p); }
    if (Array.isArray(body.images)) { body.images.forEach(x => { const p = parseImg(x); if (p) imgs.push(p); }); }
    imgs = imgs.slice(0, 6);

    // If images are present, content becomes an array of image blocks + the text prompt.
    const content = imgs.length
      ? [
          ...imgs.map(p => ({ type: "image", source: { type: "base64", media_type: p.media_type, data: p.data } })),
          { type: "text", text: prompt }
        ]
      : prompt;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: maxTokens,
        system: body.system || "You are Chelgy marketing advisor. Write punchy specific actionable content. No fluff.",
        ...(useSearch ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }] } : {}),
        messages: [{ role: "user", content }]
      })
    });

    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: (data && data.error && data.error.message) || "AI service error" });
    }
    const text = (data.content || []).map(b => b.text || "").join("");
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || "Server error" });
  }
}
