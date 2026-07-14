// api/fakeit-restage.js — "Fake It" rebuilt on Gemini reference photos.
//
// WHAT THIS DOES (and why it's different from the old fal/Flux version):
//   The old version TRAINED a model of your face, then invented a new face from
//   scratch every time. That's why it looked plastic — no real photo underneath.
//   This version takes a REAL photo of you and restages it. Your actual skin,
//   pores and hair survive, because they were photographed, not invented.
//   This is the same trick Retake AI uses to get natural-looking faces.
//
// FLOW (order matters):
//   1. Verify the logged-in user
//   2. Require the consent checkbox
//   3. Block banned words in the scene description
//   4. LOOK AT THE UPLOADED PHOTO and reject it if it's explicit  <-- the new guard
//   5. ONLY THEN deduct credits  (so nobody pays for a rejected upload)
//   6. Generate. If generation fails, refund automatically.
//
// Env: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

const GEMINI_HOST = "https://generativelanguage.googleapis.com/v1beta/models/";

// Model used to LOOK at the uploaded photo and judge it. Vision in, text out.
// If Google ever renames this, this is the one line to change.
const SAFETY_MODEL = "gemini-2.5-flash";

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

// ─────────────────────────────────────────────────────────────────────────────
// GUARD 1 — the words. Blocks explicit / non-consensual scene descriptions.
// ─────────────────────────────────────────────────────────────────────────────
const BANNED = [
  "nude","naked","nudity","topless","bottomless","undressed","strip","stripping",
  "porn","porno","pornographic","xxx","nsfw","explicit","erotic","erotica",
  "sex","sexual","sexy","seductive","provocative","lingerie","underwear","bra ",
  "panties","thong","bikini","lewd","fetish","bdsm","onlyfans","escort",
  "genitals","breasts","boobs","nipple","cleavage","butt","ass ","crotch",
  "child","kid","minor","teen","underage","toddler","baby","schoolgirl","loli",
  "rape","molest","abuse","non-consensual","nonconsensual","without consent",
  "revenge porn","deepfake","deep fake","blackmail","impersonate","identity theft"
];
function promptIsBlocked(text) {
  const t = " " + String(text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ") + " ";
  return BANNED.find(w => t.includes(w.trim().length === w.length ? " " + w + " " : " " + w.trim()));
}

// ─────────────────────────────────────────────────────────────────────────────
// GUARD 2 — the picture. THIS IS THE NEW ONE.
//
// The word-blocklist above only reads what the user TYPES. It cannot stop
// someone uploading an already-explicit photo and typing something totally
// innocent like "on a beach at sunset". The words are clean; the input isn't.
//
// So before the photo goes anywhere near the image generator, we show it to
// Gemini and ask: is this explicit, and is this an adult? If either answer is
// wrong, we reject and NOTHING is generated and NOTHING is charged.
//
// Fails CLOSED: if the safety check itself errors out, we reject. We'd rather
// annoy a user than let one bad image through.
// ─────────────────────────────────────────────────────────────────────────────
async function photoIsSafe(key, images) {
  const parts = [
    ...images.map(im => ({ inlineData: { mimeType: im.mimeType, data: im.data } })),
    { text:
      "You are a content-safety filter for a photo app. Look at the attached image(s).\n" +
      "Answer with a single JSON object and NOTHING else. No prose, no markdown fences.\n" +
      '{"explicit": true|false, "minor": true|false, "hasFace": true|false}\n\n' +
      '"explicit"  = true if the image shows nudity, exposed genitals or nipples, sexual acts, ' +
      "or is clearly pornographic or sexually explicit. Ordinary clothing, swimwear at a beach/pool, " +
      "gym wear, and everyday fashion are NOT explicit.\n" +
      '"minor"     = true if any person shown appears to be under 18.\n' +
      '"hasFace"   = true if at least one clear human face is visible.'
    }
  ];

  try {
    const r = await fetch(GEMINI_HOST + SAFETY_MODEL + ":generateContent?key=" + encodeURIComponent(key), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0 } })
    });
    const data = await r.json();
    if (!r.ok) return { ok: false, reason: "We couldn't check that photo. Please try a different one." };

    const out = ((data.candidates || [])[0]?.content?.parts || []).map(p => p.text || "").join("");
    const match = out.match(/\{[\s\S]*\}/);
    if (!match) return { ok: false, reason: "We couldn't check that photo. Please try a different one." };

    const v = JSON.parse(match[0]);

    if (v.minor === true)    return { ok: false, reason: "This photo appears to show a minor. Fake It is adults-only, and only for photos of yourself." };
    if (v.explicit === true) return { ok: false, reason: "That photo looks explicit. Please upload an ordinary, clothed photo of yourself." };
    if (v.hasFace === false) return { ok: false, reason: "We couldn't find a clear face in that photo. Upload a photo where your face is visible and well lit." };

    return { ok: true };
  } catch {
    // Fail closed. Never let an unchecked photo through.
    return { ok: false, reason: "We couldn't check that photo. Please try again." };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The locked prompt scaffold.
//
// This is the part that actually keeps the render from going plastic, and the
// user never sees it or types it. Every call gets it, word for word. The user
// only supplies the SCENE. Do not water this down — "do not smooth, retouch or
// beautify" is the single most load-bearing sentence in this whole file.
// ─────────────────────────────────────────────────────────────────────────────
function buildPrompt(scene) {
  return (
    "Using the attached photo(s) as the reference for this person, generate a new photograph " +
    "of the SAME person, " + String(scene).trim() + ".\n\n" +

    "IDENTITY — this is the most important instruction:\n" +
    "Preserve this person's face exactly as it appears in the reference. Keep the same facial " +
    "structure, the same bone structure, the same eyes, nose and mouth, the same skin tone, and " +
    "the same real skin texture including pores, fine lines and natural unevenness. Keep the same " +
    "hair texture, including its natural frizz and flyaways. Do NOT smooth, retouch, airbrush, " +
    "slim, or beautify them in any way. Do NOT alter their features. They should be immediately " +
    "recognisable as the person in the reference photo.\n\n" +

    "REALISM:\n" +
    "Light the scene with a single clear directional light source so shadows fall believably across " +
    "one side of the face. Render it as a real candid photograph taken on a good camera - natural " +
    "grain, believable depth of field, natural catchlights in the eyes, slightly imperfect framing. " +
    "Avoid a glossy, waxy, airbrushed or CGI look. Avoid flat, directionless studio lighting. " +
    "It should look photographed, not generated."
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    const scene   = String(body.scene || "").trim();
    const consent = body.consent === true;
    const photos  = (Array.isArray(body.photos) ? body.photos : [])
      .filter(p => p && p.data && p.mimeType)
      .slice(0, 3); // 3 references is plenty; more just costs money

    const allowedRatios = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
    const aspectRatio = allowedRatios.includes(body.aspectRatio) ? body.aspectRatio : "4:5";
    const quality = body.quality === "high" ? "high" : "standard";

    // ── Basic validation ──
    if (!consent)        return res.status(400).json({ error: "Please confirm these are photos of you before continuing." });
    if (!photos.length)  return res.status(400).json({ error: "Upload at least one clear photo of your face." });
    if (!scene)          return res.status(400).json({ error: "Describe the scene — a place, an outfit, a vibe." });

    // ── Auth ──
    const token  = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again to generate." });

    const key = (process.env.GEMINI_API_KEY || "").trim();
    if (!key) return res.status(500).json({ error: "Image service is not configured." });

    // ── GUARD 1: the words ──
    const badWord = promptIsBlocked(scene);
    if (badWord) {
      return res.status(400).json({ error: "That scene isn't allowed. Fake It is for ordinary photos of yourself — no explicit, sexual, or impersonation content." });
    }

    // ── GUARD 2: the picture. Runs BEFORE we charge anybody. ──
    const safe = await photoIsSafe(key, photos);
    if (!safe.ok) return res.status(400).json({ error: safe.reason });

    // ── Only now do we take the money ──
    const cost = quality === "high" ? 450 : 150;
    const paid = await spend(token, cost, "restage:" + quality);
    if (!paid.ok) return res.status(402).json({ error: paid.error });

    // ── Generate ──
    const model = quality === "high" ? "gemini-3-pro-image-preview" : "gemini-2.5-flash-image";
    const imageConfig = quality === "high" ? { aspectRatio, imageSize: "2K" } : { aspectRatio };

    const parts = [
      ...photos.map(p => ({ inlineData: { mimeType: p.mimeType, data: p.data } })),
      { text: buildPrompt(scene) }
    ];

    let r, data;
    try {
      r = await fetch(GEMINI_HOST + model + ":generateContent?key=" + encodeURIComponent(key), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig } })
      });
      data = await r.json();
    } catch (e) {
      await refund(userId, cost, "refund:restage-error");
      return res.status(502).json({ error: "Image service unreachable. Your credits were refunded." });
    }

    if (!r.ok) {
      await refund(userId, cost, "refund:restage-fail");
      return res.status(r.status).json({ error: ((data && data.error && data.error.message) || "Image service error") + " Your credits were refunded." });
    }

    const outParts = ((data.candidates || [])[0]?.content?.parts) || [];
    const img = outParts.find(p => p.inlineData);
    if (!img) {
      // Gemini returns no image when ITS OWN safety filter trips. Refund and say so plainly.
      await refund(userId, cost, "refund:restage-empty");
      return res.status(502).json({ error: "No image came back — that usually means the scene was blocked. Try describing it differently. Your credits were refunded." });
    }

    const image = "data:" + img.inlineData.mimeType + ";base64," + img.inlineData.data;
    return res.status(200).json({ image, balance: paid.balance });

  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
