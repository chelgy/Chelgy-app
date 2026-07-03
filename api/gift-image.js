// api/gift-image.js — FREE daily "on the house" gift image (flyer / graphic / quote post).
//
// Unlike api/image.js, this does NOT charge the user — Chelgy covers it. Abuse is
// prevented by a SERVER-ENFORCED weekly cap (3 gift images per user per week), checked
// atomically in the database. Uses the same Gemini setup as api/image.js.
//
// Env: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();

async function getUserId(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, Authorization: "Bearer " + token } });
    const u = await r.json();
    return r.ok && u && u.id ? u.id : null;
  } catch { return null; }
}
// Atomically claim one weekly gift-image slot. Returns remaining count, or -1 if capped.
async function claimGift(token) {
  try {
    const r = await fetch(SB_URL + "/rest/v1/rpc/claim_gift_image", {
      method: "POST",
      headers: { apikey: SB_ANON, Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: "{}"
    });
    const d = await r.json();
    if (!r.ok) return null;
    return typeof d === "number" ? d : null;
  } catch { return null; }
}
// Give a slot back if generation fails, so a failed image never costs the user a freebie.
async function releaseGift(token) {
  try {
    await fetch(SB_URL + "/rest/v1/rpc/release_gift_image", {
      method: "POST",
      headers: { apikey: SB_ANON, Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: "{}"
    });
  } catch {}
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const prompt = body.prompt;
    if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: "Missing prompt" });

    const allowedRatios = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
    const aspectRatio = allowedRatios.includes(body.aspectRatio) ? body.aspectRatio : "4:5";

    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again." });

    // ── Weekly cap (server-enforced) ──
    const remaining = await claimGift(token);
    if (remaining === -1) return res.status(200).json({ capped: true });
    // remaining === null means the cap RPC isn't installed yet or errored — fail closed (no free image)
    if (remaining === null) return res.status(200).json({ capped: true });

    const key = (process.env.GEMINI_API_KEY || "").trim();
    if (!key) { await releaseGift(token); return res.status(500).json({ error: "Image service is not configured." }); }

    let r, data;
    try {
      r = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=" + encodeURIComponent(key),
        { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio } } }) }
      );
      data = await r.json();
    } catch (e) {
      await releaseGift(token);
      return res.status(502).json({ error: "Image service unreachable." });
    }
    if (!r.ok) {
      await releaseGift(token);
      return res.status(r.status).json({ error: (data && data.error && data.error.message) || "Image service error." });
    }

    const candidates = data.candidates || [];
    const outParts = (candidates[0] && candidates[0].content && candidates[0].content.parts) || [];
    const img = outParts.find(p => p.inlineData);
    if (!img) {
      await releaseGift(token);
      return res.status(502).json({ error: "No image was returned." });
    }

    const image = "data:" + img.inlineData.mimeType + ";base64," + img.inlineData.data;
    return res.status(200).json({ image, remaining });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
