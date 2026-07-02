// api/openai-image.js — GPT Image 2 (OpenAI) generation with SERVER-ENFORCED credit spending.
//
// Used for the text-heavy design tabs (logo, flyer, social, banner) where OpenAI's
// text-in-image is strongest. Mirrors api/image.js exactly: verify the logged-in user →
// deduct credits in the database → generate → refund automatically if it fails.
// The browser cannot generate without paying and cannot fake the cost.
//
// Env: OPENAI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

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

// Map the app's aspect ratios → GPT Image 2 sizes (W and H divisible by 16, ratio within 1:3–3:1).
function sizeFor(aspect) {
  switch (aspect) {
    case "4:5":  return "1024x1280";
    case "9:16": return "1024x1536";
    case "16:9": return "1536x1024";
    case "4:3":  return "1344x1024";
    case "1:1":
    default:     return "1024x1024";
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    // ── Prompt Writer mode: expand a plain idea into a detailed image prompt (ChatGPT) ──
    if (body.mode === "prompt") {
      const idea = String(body.idea || "").trim();
      if (!idea) return res.status(400).json({ error: "Tell me what you want to make first." });
      const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
      const userId = await getUserId(token);
      if (!userId) return res.status(401).json({ error: "Please log in again." });
      const key = (process.env.OPENAI_API_KEY || "").trim();
      if (!key) return res.status(500).json({ error: "Prompt service is not configured." });
      const target = body.target === "video" ? "video" : "image";
      const kindHint = body.imageType ? ("This is for a " + String(body.imageType) + ". ") : "";
      const sys = target === "video"
        ? "You are an expert at writing prompts for AI video generators. Turn the user's rough idea into ONE vivid, detailed video prompt of 2-4 sentences. Cover the subject, the action and motion, camera movement, lighting, style, mood, and setting. Output ONLY the prompt text — no preamble, no quotes, no explanation, no labels."
        : "You are an expert at writing prompts for AI image generators. Turn the user's rough idea into ONE vivid, detailed image-generation prompt of 2-4 sentences. Cover subject, composition, lighting, style, mood, colors, and background. Output ONLY the prompt text — no preamble, no quotes, no explanation, no labels.";
      try {
        const r = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "system", content: sys }, { role: "user", content: kindHint + "Idea: " + idea }], max_tokens: 320, temperature: 0.85 })
        });
        const d = await r.json();
        if (!r.ok) return res.status(r.status).json({ error: (d && d.error && d.error.message) || "Prompt service error." });
        const text = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
        if (!text || !String(text).trim()) return res.status(502).json({ error: "No prompt was returned. Try again." });
        return res.status(200).json({ prompt: String(text).trim() });
      } catch (e) {
        return res.status(502).json({ error: "Prompt service unreachable. Try again." });
      }
    }

    const prompt = body.prompt;
    const inputImage = body.inputImage; // optional { mimeType, data }
    const inputImages = Array.isArray(body.inputImages) && body.inputImages.length
      ? body.inputImages
      : (inputImage && inputImage.data ? [inputImage] : []);

    const allowedRatios = ["1:1", "4:5", "9:16", "16:9", "4:3"];
    const aspectRatio = allowedRatios.includes(body.aspectRatio) ? body.aspectRatio : "1:1";
    const quality = ["standard", "2K", "4K"].includes(body.quality) ? body.quality : "standard";
    const oaQuality = quality === "4K" ? "high" : quality === "2K" ? "medium" : "low";
    const size = sizeFor(aspectRatio);
    const bg = ["transparent", "opaque", "auto"].includes(body.background) ? body.background : undefined;

    if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: "Missing prompt" });

    // ── Auth + server-decided cost (same scale as Gemini, so the UI stays consistent) ──
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again to generate." });
    const cost = quality === "4K" ? 750 : quality === "2K" ? 420 : 120;

    // ── Deduct first ──
    const paid = await spend(token, cost, "image-openai:" + quality);
    if (!paid.ok) return res.status(402).json({ error: paid.error });

    const key = (process.env.OPENAI_API_KEY || "").trim();
    if (!key) { await refund(userId, cost, "refund:openai-config"); return res.status(500).json({ error: "Image service is not configured." }); }

    const validImgs = inputImages.filter(im => im && im.data && im.mimeType);

    let r, data;
    try {
      if (validImgs.length) {
        // Reference photos uploaded → use the edits endpoint (multipart form-data).
        const form = new FormData();
        form.append("model", "gpt-image-2");
        form.append("prompt", String(prompt));
        form.append("size", size);
        form.append("quality", oaQuality);
        form.append("n", "1");
        if (bg) form.append("background", bg);
        if (bg === "transparent") form.append("output_format", "png");
        validImgs.slice(0, 16).forEach((im, i) => {
          const buf = Buffer.from(im.data, "base64");
          const type = im.mimeType || "image/png";
          const ext = type.indexOf("jpeg") !== -1 || type.indexOf("jpg") !== -1 ? "jpg" : type.indexOf("webp") !== -1 ? "webp" : "png";
          form.append("image[]", new Blob([buf], { type }), "ref" + i + "." + ext);
        });
        r = await fetch("https://api.openai.com/v1/images/edits", {
          method: "POST",
          headers: { Authorization: "Bearer " + key },
          body: form
        });
      } else {
        // No reference → text-to-image generation.
        r = await fetch("https://api.openai.com/v1/images/generations", {
          method: "POST",
          headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gpt-image-2", prompt: String(prompt), size, quality: oaQuality, n: 1, background: bg, output_format: bg === "transparent" ? "png" : undefined })
        });
      }
      data = await r.json();
    } catch (e) {
      await refund(userId, cost, "refund:openai-error");
      return res.status(502).json({ error: "Image service unreachable. Your credits were refunded." });
    }

    if (!r.ok) {
      await refund(userId, cost, "refund:openai-fail");
      return res.status(r.status).json({ error: ((data && data.error && data.error.message) || "Image service error") + " Your credits were refunded." });
    }

    const b64 = data && data.data && data.data[0] && data.data[0].b64_json;
    if (!b64) {
      await refund(userId, cost, "refund:openai-empty");
      return res.status(502).json({ error: "No image was returned. Your credits were refunded." });
    }

    const image = "data:image/png;base64," + b64;
    return res.status(200).json({ image, balance: paid.balance });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
