// Chelgy back room — keeps your Anthropic API key private.
// The key lives in Vercel's settings as ANTHROPIC_API_KEY, never in your public code.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const prompt = body.prompt;
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        system: body.system || "You are Chelgy marketing advisor. Write punchy specific actionable content. No fluff.",
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: (data && data.error && data.error.message) || "AI service error" });
    }
    const text = (data.content || []).map(b => b.text || "").join("");
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(500).json({ error: "Server error" });
  }
}
