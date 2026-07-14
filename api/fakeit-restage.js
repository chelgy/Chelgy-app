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

// Models tried IN ORDER for the photo safety check (vision in, text out).
// We try several because Google renames these constantly and which ones your
// API key can reach depends on the project. First one that answers, wins.
const SAFETY_MODELS = [
  "gemini-2.5-flash",
  "gemini-flash-latest",
  "gemini-2.0-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash-image"   // last resort: the one image.js already proves works
];

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
// GUARD 1 — the words.
//
// ALSO TUNED PERMISSIVE. Fashion words are NOT banned. "in a bikini on a beach",
// "in lingerie", "in a bodysuit", "sexy going-out look" are all normal, expected
// requests for this app and they go straight through.
//
// What's banned is only: literal porn, minors, and impersonation/deepfake intent.
// ─────────────────────────────────────────────────────────────────────────────
const BANNED = [
  // Literal porn / sex acts
  "nude","naked","nudity","topless","bottomless","porn","porno","pornographic",
  "xxx","hardcore","explicit sex","sex act","having sex","blowjob","masturbat",
  "genitals","penis","vagina","nipples","onlyfans",

  // Minors — anything pairing a child with this tool
  "child","children","kid","kids","minor","underage","teen","teenage","toddler",
  "baby","infant","schoolgirl","schoolboy","loli","preteen","pre-teen","12 year",
  "13 year","14 year","15 year","16 year","17 year",

  // Non-consent / abuse
  "rape","molest","non-consensual","nonconsensual","without consent","revenge porn",

  // Impersonation / deepfake intent
  "deepfake","deep fake","impersonate","impersonating","identity theft","blackmail"
];
function promptIsBlocked(text) {
  const t = " " + String(text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ") + " ";
  return BANNED.find(w => t.includes(" " + w) || t.includes(w + " "));
}

// ─────────────────────────────────────────────────────────────────────────────
// GUARD 2 — the picture.
//
// TUNED DELIBERATELY PERMISSIVE. Our users are adults posting fashion, going-out
// looks, gym content, swimwear and bodysuits. That is NORMAL CONTENT and it must
// pass. A filter that blocks a crop top is a broken filter.
//
// So this checks for exactly TWO things:
//
//   1. MINORS  — hard block, non-negotiable. Feeding a child's photo into an
//      image generator that restages them into new scenes and outfits is the
//      exact mechanic behind CSAM. One incident = criminal liability, permanent
//      App Store removal, and Stripe/RevenueCat termination. This will almost
//      never fire on a real user, because real users upload photos of themselves.
//
//   2. ACTUAL NUDITY — exposed genitals, exposed nipples, or sex acts. NOT
//      "sexy". Not revealing. Not a bikini. Only literal nudity.
//
// Note we are NOT trying to be Google's filter. Gemini has its own safety layer
// downstream: if someone asks for genuine porn, GOOGLE refuses and returns no
// image, and the handler below refunds them. This guard exists for the one thing
// Google's filter won't reliably save us from — the minors case.
//
// Fails CLOSED on the minors question: if the check itself errors, we reject.
// ─────────────────────────────────────────────────────────────────────────────
async function photoIsSafe(key, images) {
  const parts = [
    ...images.map(im => ({ inlineData: { mimeType: im.mimeType, data: im.data } })),
    { text:
      "You are a narrow content-safety filter for an adult photo app. Look at the attached image(s).\n" +
      "Answer with a single JSON object and NOTHING else. No prose, no markdown fences.\n" +
      '{"minor": true|false, "nudity": true|false, "hasFace": true|false}\n\n' +

      '"minor" = true ONLY if a person shown clearly appears to be under 18 (a child or ' +
      "adolescent). If the person plausibly appears to be an adult, answer false. Do not guess " +
      "low. Adults with youthful faces are still adults.\n\n" +

      '"nudity" = true ONLY for LITERAL nudity: exposed genitals, exposed nipples/areolae, ' +
      "or a depicted sex act.\n" +
      "The following are NOT nudity and MUST return false — this app is for fashion and social " +
      "content and these are its normal, expected use:\n" +
      "  - swimwear, bikinis, one-piece swimsuits\n" +
      "  - bodysuits, leotards, crop tops, bralettes, sheer or mesh fabric over covered skin\n" +
      "  - lingerie worn as an outfit, going-out and club wear\n" +
      "  - low-cut tops, cleavage, bare midriffs, short skirts, shorts\n" +
      "  - gym and athletic wear, sports bras\n" +
      "  - bare legs, bare arms, bare shoulders, bare back\n" +
      "  - suggestive or flattering poses in clothing\n" +
      "Revealing, form-fitting, or sexy is NOT nudity. Only literal exposure counts.\n\n" +

      '"hasFace" = true if at least one clear human face is visible.'
    }
  ];

  const errors = [];

  for (const model of SAFETY_MODELS) {
    let r, data;
    try {
      r = await fetch(GEMINI_HOST + model + ":generateContent?key=" + encodeURIComponent(key), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0 } })
      });
      data = await r.json();
    } catch (e) {
      errors.push(model + ": network error");
      continue; // try the next model
    }

    if (!r.ok) {
      // Model doesn't exist / isn't enabled on this key -> try the next one.
      errors.push(model + ": " + ((data && data.error && data.error.message) || ("HTTP " + r.status)));
      continue;
    }

    const out = ((data.candidates || [])[0]?.content?.parts || []).map(p => p.text || "").join("");
    const match = out.match(/\{[\s\S]*\}/);
    if (!match) {
      errors.push(model + ": returned no JSON");
      continue;
    }

    let v;
    try { v = JSON.parse(match[0]); }
    catch { errors.push(model + ": bad JSON"); continue; }

    // ── We got a real answer. Judge it. ──
    if (v.minor === true)    return { ok: false, reason: "Fake It is adults-only, and only for photos of yourself. This photo appears to show someone under 18." };
    if (v.nudity === true)   return { ok: false, reason: "Please upload a clothed photo of yourself." };
    if (v.hasFace === false) return { ok: false, reason: "We couldn't find a clear face in that photo. Try one where your face is visible and well lit." };
    return { ok: true };
  }

  // Every model failed. Fail CLOSED — but say WHY, so this is debuggable instead
  // of a dead end. This message is what tells us the real problem.
  return {
    ok: false,
    reason: "Photo safety check unavailable — " + (errors[0] || "unknown error") +
            " (tried: " + SAFETY_MODELS.join(", ") + ")"
  };
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

// Vercel caps a serverless request body at 4.5MB by DEFAULT. Base64 inflates a
// file by ~37%, so one big phone photo can blow past it — and when it does,
// Vercel rejects the request before this file ever runs and returns a non-JSON
// error, which Safari reports as "The string did not match the expected pattern."
// The browser now downscales photos to ~1280px before upload (see shrink() in
// App.jsx), which is the real fix. This raises the ceiling as a safety net.
export const config = {
  api: { bodyParser: { sizeLimit: "10mb" } }
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    const scene   = String(body.scene || "").trim();
    const consent = body.consent === true;
    const photos  = (Array.isArray(body.photos) ? body.photos : [])
      .filter(p => p && p.data && p.mimeType)
      .slice(0, 3); // 3 references is plenty; more just costs money

    // Belt-and-braces: if something huge still gets through, say so in plain
    // English instead of letting the platform return an unparseable error.
    const totalBytes = photos.reduce((n, p) => n + (p.data ? p.data.length : 0), 0);
    if (totalBytes > 9 * 1024 * 1024) {
      return res.status(413).json({ error: "Those photos are too large. Try one photo, or a smaller one." });
    }

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
