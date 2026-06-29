// api/image.js — Gemini image generation with SERVER-ENFORCED credit spending.
//
// Flow: verify the logged-in user → deduct credits in the database (atomic) →
// generate → if generation fails, automatically refund. The browser cannot
// generate without paying, and cannot fake the cost (the server decides it).
//
// Env: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

async function getUserId(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, Authorization: "Bearer " + token } });
    const u = await r.json();
    return r.ok && u && u.id ? u.id : null;
  } catch { return null; }
}
async function spend(token, amount, reason) {
  try {
    const r = await fetch(SB_URL + "/rest/v1/rpc/spend_credits", {
      method: "POST",
      headers: { apikey: SB_ANON, Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ p_amount: amount, p_reason: reason })
    });
    const d = await r.json();
    if (!r.ok) return { ok: false, error: (d && d.message) || "Could not deduct credits." };
    return { ok: true, balance: typeof d === "number" ? d : null };
  } catch { return { ok: false, error: "Credit service unreachable." }; }
}
async function refund(userId, amount, reason) {
  try {
    await fetch(SB_URL + "/rest/v1/rpc/add_credits", {
      method: "POST",
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json" },
      body: JSON.stringify({ p_user: userId, p_amount: amount, p_reason: reason })
    });
  } catch {}
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const prompt = body.prompt;
    const inputImage = body.inputImage; // optional { mimeType, data }
    const inputImages = Array.isArray(body.inputImages) && body.inputImages.length
      ? body.inputImages
      : (inputImage && inputImage.data ? [inputImage] : []);

    const allowedRatios = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
    const aspectRatio = allowedRatios.includes(body.aspectRatio) ? body.aspectRatio : "1:1";
    const quality = ["standard", "2K", "4K"].includes(body.quality) ? body.quality : "standard";

    if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: "Missing prompt" });

    // ── Auth + server-decided cost ──
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again to generate." });
    const cost = quality === "4K" ? 750 : quality === "2K" ? 420 : 120;

    // ── Deduct first ──
    const paid = await spend(token, cost, "image:" + quality);
    if (!paid.ok) return res.status(402).json({ error: paid.error });

    const key = (process.env.GEMINI_API_KEY || "").trim();
    if (!key) { await refund(userId, cost, "refund:image-config"); return res.status(500).json({ error: "Image service is not configured." }); }

    const validImgs = inputImages.filter(im => im && im.data && im.mimeType);
    const parts = validImgs.length
      ? [...validImgs.map(im => ({ inlineData: { mimeType: im.mimeType, data: im.data } })), { text: prompt }]
      : [{ text: prompt }];

    let model, imageConfig;
    if (quality === "standard") { model = "gemini-2.5-flash-image"; imageConfig = { aspectRatio }; }
    else { model = "gemini-3-pro-image-preview"; imageConfig = { aspectRatio, imageSize: quality }; }

    let r, data;
    try {
      r = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(key),
        { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig } }) }
      );
      data = await r.json();
    } catch (e) {
      await refund(userId, cost, "refund:image-error");
      return res.status(502).json({ error: "Image service unreachable. Your credits were refunded." });
    }

    if (!r.ok) {
      await refund(userId, cost, "refund:image-fail");
      return res.status(r.status).json({ error: ((data && data.error && data.error.message) || "Image service error") + " Your credits were refunded." });
    }

    const candidates = data.candidates || [];
    const outParts = (candidates[0] && candidates[0].content && candidates[0].content.parts) || [];
    const img = outParts.find(p => p.inlineData);
    if (!img) {
      await refund(userId, cost, "refund:image-empty");
      return res.status(502).json({ error: "No image was returned. Your credits were refunded." });
    }

    const image = "data:" + img.inlineData.mimeType + ";base64," + img.inlineData.data;
    return res.status(200).json({ image, balance: paid.balance });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
