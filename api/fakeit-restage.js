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
// EDITORIAL PRESETS  — the "High Fashion" tab.
//
// WHY THESE ARE SO LONG: left to itself this model produces a centred, smiling
// subject, flat even light, a clean saturated grade and no grain — a stock photo.
// Every clause below exists to kill one of those defaults. Naming the camera, the
// lens, the film stock, the light DIRECTION, the grade in photographic terms
// (lifted blacks, desaturated, blown highlights) and the FRAMING is what separates
// an editorial frame from a Getty image. Do not trim these down.
//
// These describe looks. They do not copy anyone's photographs.
// ─────────────────────────────────────────────────────────────────────────────
const LOOK = {
  // Shared spine. Every preset gets this.
  base:
    "SHOOT IT LIKE A FASHION EDITORIAL, NOT A STOCK PHOTO.\n" +
    "  - Attitude: distant, composed, self-possessed, caught mid-thought. Never a cheesy grin, " +
    "never a chirpy 'say cheese' smile, never mugging for the camera. Cool, unbothered, a little " +
    "unreadable. A faint, knowing half-smile is allowed - a broad happy one is not.\n" +
    "  - GAZE - VARY IT. Do not default to looking away every time. Pick whatever suits the frame:\n" +
    "      * straight down the lens: a direct, cool, unblinking, mysterious stare. Often the " +
    "strongest frame in a set - use it freely.\n" +
    "      * toward the camera but focused PAST it, at something behind the photographer.\n" +
    "      * eyes lowered, looking down and away, lost in thought.\n" +
    "      * in profile, looking off out of frame.\n" +
    "      * eyes closed, chin lifted, face turned up into the light.\n" +
    "      * over the shoulder, back half-turned to camera, glancing round.\n" +
    "    The only thing forbidden is a posed, smiling, camera-pleasing expression.\n" +
    "  - Camera: full-frame, 35mm or 50mm lens, at eye level or slightly low. Real depth of field " +
    "with a soft falloff, not a fake blurred cut-out.\n" +
    "  - Grain: real 35mm film grain, visible in the shadows and flat tones.\n" +
    "  - Skin: real texture, pores, sheen where sweat or oil would sit. Never airbrushed, never waxy.\n" +
    "  - AVOID at all costs: a centred subject, a smiling subject, flat directionless light, clean " +
    "even studio lighting, a crisp saturated 'clean' digital grade, HDR, a plastic sheen, stock " +
    "photography composition. It must look like an unretouched frame from a magazine shoot.",

  // ── ITALY / COAST ──────────────────────────────────────────────────────────
  capri: { label: "Capri Harbour", body:
    "LOCATION: the harbour at Capri. A varnished mahogany-and-white Italian motor launch on green " +
    "Mediterranean water, chrome fittings catching the sun. Behind, the pastel town stacked up the " +
    "hillside - ochre, terracotta, faded pink - moored boats, a hazy limestone cliff.\n" +
    "LIGHT: low golden sun, late afternoon, raking in from the side and slightly behind, throwing " +
    "long highlights across the water and rim-lighting the person. Warm, hazy, a little flared.\n" +
    "GRADE: sun-bleached and warm. Creamy blown highlights. Lifted, milky blacks. Desaturated greens, " +
    "warm skin, soft contrast. The whole frame slightly hazed, as if shot into the light." },

  capriroad: { label: "Capri Clifftop", body:
    "LOCATION: a clifftop road high above the sea in Capri. A vintage red Fiat convertible taxi with " +
    "a fringed canopy parked on cracked concrete, a low stone wall, the Tyrrhenian Sea and a hazy " +
    "headland far below.\n" +
    "LIGHT: the sun just gone. A pale gold and lavender sky, soft flat afterglow, no hard shadows. " +
    "The whole scene lit by the sky itself.\n" +
    "GRADE: dusty pastel. Faded gold, dove grey, oxidised red. Very low contrast, milky lifted " +
    "blacks, muted saturation. Romantic, nostalgic, faintly sun-damaged, like old Kodak." },

  coastroad: { label: "Coast Road", body:
    "LOCATION: a headland car park above a harbour. A cream vintage Jaguar E-Type convertible with " +
    "chrome wire wheels on cracked asphalt, hills and moored yachts hazy in the distance.\n" +
    "LIGHT: hard low sun, late afternoon, coming almost straight into the lens from behind the " +
    "subject. Strong rim light, deep contrasty shadows, visible haze and flare.\n" +
    "GRADE: warm and bleached. Blown white sky, cream paintwork glowing, deep shadows. High contrast " +
    "but desaturated - a sun-drenched, faintly overexposed 90s campaign look." },

  clifftopglass: { label: "Clifftop Glass", body:
    "LOCATION: a stone and glass house on a cliff edge above a wild ocean. A tall pane of glass " +
    "throws a full mirror reflection of the person, with the sea, the headland and a winding path " +
    "doubled in it.\n" +
    "LIGHT: cool, flat, overcast coastal daylight. Soft, even, directionless, with a slight silver " +
    "sheen on the glass. No sun.\n" +
    "GRADE: cold and elegant. Bone white, slate, deep sea green. Low saturation, gentle contrast, " +
    "crisp but not clinical. Still, expensive, editorial." },

  oceandusk: { label: "Ocean at Dusk", body:
    "LOCATION: standing in flat, glassy, waist-deep water at the ocean's edge as night comes in. " +
    "Bare rock just breaking the surface. Nothing else - a huge empty horizon.\n" +
    "LIGHT: the last light after sunset. Very dim, very soft, coming from the sky itself. A single " +
    "faint edge of light modelling the face and shoulders out of near-darkness.\n" +
    "GRADE: dark, quiet, almost monochrome. Warm grey water, a pale cream sky, deep shadow. Very low " +
    "contrast in the sky, rich shadow on the body. Painterly, still, reverent." },

  // ── STONE / ARCHITECTURE ───────────────────────────────────────────────────
  dubrovnik: { label: "Dubrovnik Stone", body:
    "LOCATION: the base of an ancient limestone fortress wall on the Adriatic. Huge weathered stone " +
    "blocks, pale sand and bleached rock underfoot, rusted iron pipework, the sea just out of frame.\n" +
    "LIGHT: hard, high, unforgiving Mediterranean midday sun. Sharp-edged shadows with real shape. " +
    "Strong specular highlights on skin. Nothing soft, nothing flattering, nothing filled in.\n" +
    "GRADE: hot and dry. Bleached sandy stone, deep dense shadows, high contrast, low saturation. A " +
    "warm sand-and-shadow palette - almost monochrome in the stone, the skin the only real colour." },

  brutalist: { label: "Brutalist Coast", body:
    "LOCATION: a raw board-formed concrete interior open to the sea. Bare grey columns and beams, " +
    "floor-to-ceiling glass, a herringbone timber floor, grey-green ocean churning outside.\n" +
    "LIGHT: flat, cool, overcast daylight from one huge window. Soft directional light with a long, " +
    "gentle falloff into shadow. No sun, no sparkle, no fill.\n" +
    "GRADE: cool, quiet, desaturated. Concrete grey, sea-green, bone white. Muted and atmospheric " +
    "with lifted blacks. Restrained, architectural, still. Nearly monochrome." },

  whiteconcrete: { label: "White Concrete", body:
    "LOCATION: a set of broad, pale travertine steps between sharp white concrete forms - a modernist " +
    "rooftop of hard geometric planes against open sky. Nothing soft anywhere.\n" +
    "LIGHT: brilliant hard high sun in a cloudless sky. Crisp, graphic, black-edged shadows cutting " +
    "across the steps. Bright, clean, uncompromising.\n" +
    "GRADE: bold and graphic. Deep saturated cobalt sky against bone-white stone. High contrast, " +
    "clean blacks, restrained palette. Sculptural, architectural, powerful." },

  // ── DESERT ─────────────────────────────────────────────────────────────────
  desert: { label: "Desert Highway", body:
    "LOCATION: a vintage American car - a 60s Chevrolet or Cadillac, dust-covered, chrome dulled - " +
    "on an empty gravel road running dead flat to a distant horizon. Nothing else for miles.\n" +
    "LIGHT: the last twenty minutes before dark. The sun already below the horizon, so the light is " +
    "flat, cool and directionless, with a warm sodium glow low along the skyline. Blue hour.\n" +
    "GRADE: cinematic and cold. Deep desaturated slate-blue sky, warm dusty earth, muted skin. " +
    "Crushed but not black shadows. A moody, wide, cinematic frame - the emptiness IS the picture." },

  desertsunset: { label: "Desert Sunset", body:
    "LOCATION: leaning into the open door of a battered white 60s Chevrolet on a red dirt plain. " +
    "Dust on the paintwork, the horizon dead flat and endless.\n" +
    "LIGHT: the sun on the horizon directly behind the car. Warm, low, glowing, throwing long soft " +
    "shadows toward camera and haloing the hair. Gentle, golden, hazy.\n" +
    "GRADE: warm and creamy. Butter-gold sky fading to dusty rose, rust-red earth, glowing skin. Low " +
    "contrast, lifted blacks, soft blown highlights. Cinematic and romantic." },

  desertsun: { label: "Desert Noon", body:
    "LOCATION: a wrecked car and broken rock on a stark desert plain, hard mountains behind. " +
    "Nothing living. Baked, bright, brutal.\n" +
    "LIGHT: savage overhead noon sun in a deep cloudless sky. Tiny hard shadows straight down. " +
    "Glaring specular highlights, sweat-sheen, squinting light.\n" +
    "GRADE: high-contrast and saturated. A deep inky blue sky against bleached ground. Punchy, " +
    "sharp, glittering. Bold, hot, futuristic - the sky almost navy." },

  desertgold: { label: "Golden Desert", body:
    "LOCATION: an open desert plain of pale sand and low dunes, distant hills soft in the haze. " +
    "Empty, huge, silent.\n" +
    "LIGHT: raking golden hour sun straight into the lens from behind the subject. Every edge lit, " +
    "the air full of dust and glow. Strong flare and haze. Sparkles catching on fabric.\n" +
    "GRADE: rich amber and bronze. Deep warm shadows, glowing highlights, heavy atmospheric haze. " +
    "Sepia-adjacent, sculptural, almost monochromatic in gold." },

  sandstone: { label: "Sandstone", body:
    "LOCATION: enormous wind-eroded sandstone formations - wave-like layered rock, honeycombed and " +
    "sculptural - rising out of pale sand. A vast, empty, primal landscape.\n" +
    "LIGHT: hard, clean, high sun in a cloudless sky. Crisp shadows carving the rock. Strong, " +
    "directional, sculptural - light that models form rather than flattering it.\n" +
    "GRADE: bold and graphic. A deep saturated blue sky against warm ochre sandstone. High contrast, " +
    "rich shadows, punchy but never garish. Sculptural, elemental, monumental." },

  // ── HOUSES / INTERIORS ─────────────────────────────────────────────────────
  palmsprings: { label: "Palm Springs", body:
    "LOCATION: a mid-century modernist desert house. Warm timber, travertine, huge sliding glass, " +
    "brushed brass. Outside, raked gravel, agave and aloe, and desert dissolving into haze.\n" +
    "LIGHT: soft, hazy, diffused early morning light through marine fog or dust. Everything a little " +
    "veiled, a little low-contrast. Gentle, directional, through the glass.\n" +
    "GRADE: warm neutral and dreamy. Sand, bone, pale timber, dusty sage. Low contrast, lifted " +
    "blacks, a faint warm bloom in the highlights. Languid, quiet, expensive." },

  timberdeck: { label: "Timber Deck", body:
    "LOCATION: the deck of a modernist timber-and-glass house. Rich vertical hardwood cladding, a " +
    "huge sliding glass door reflecting the room within, a slatted deck chair, warm wood underfoot.\n" +
    "LIGHT: soft, warm, ambient afternoon light, mostly bounced off the timber. Gentle directional " +
    "falloff, deep warm shadow in the corners. Intimate, indoor-outdoor, unhurried.\n" +
    "GRADE: rich and warm. Mahogany, rust, cognac, deep shadow. Saturated warm tones, moody contrast, " +
    "creamy skin. Sensual, private, 70s-cinematic." },

  woodroom: { label: "Wood Room", body:
    "LOCATION: a still, minimal interior with a full wall of rich walnut panelling, sculptural bent-" +
    "wood furniture and a pale poured concrete floor. Empty, quiet, expensive. A campaign set.\n" +
    "LIGHT: soft, broad, controlled light from one side, like a huge window just out of frame. Gentle " +
    "wraparound shadow, no hard edges. Calm and deliberate.\n" +
    "GRADE: warm neutral and hushed. Walnut brown, cream, bone, oat. Muted saturation, soft contrast, " +
    "lifted blacks. Serene, luxurious, understated - a heritage fashion house campaign." },

  darkstudio: { label: "Dark Studio", body:
    "LOCATION: a pure black studio void. No set, no floor line, no props - only the person and " +
    "darkness.\n" +
    "LIGHT: a single hard light and a slow shutter. Crisp where it catches, smearing into motion " +
    "streaks and light trails everywhere else. Dramatic, sculptural, kinetic.\n" +
    "GRADE: deep black with one saturated colour blazing out of it - scarlet, oxblood, electric " +
    "orange. Crushed blacks, glowing highlights, heavy motion blur, a doubled ghosting edge. " +
    "Graphic, avant-garde, high-drama." },

  // ── STREET ─────────────────────────────────────────────────────────────────
  street: { label: "Street Blur", body:
    "LOCATION: a narrow city alley of old brick and stone, walking fast through a hard shaft of " +
    "sunlight. The walls streak past.\n" +
    "LIGHT: a hard, low, raking beam of sun cutting between buildings, hitting the face and body and " +
    "leaving the rest in deep shadow. Sharp, dramatic, contrasty.\n" +
    "GRADE: warm and gritty. Amber sunlight, deep brown-black shadow, blown highlights. Heavy motion " +
    "blur through the whole background and a smeared, kinetic feel. High contrast, filmic, urgent - " +
    "a stolen paparazzi frame." },
};
//
//   "restage"   (default) — DON'T regenerate the person. Keep their exact face,
//                pose, hands, hair and outfit from the photo, and only swap the
//                world around them, relighting them to match. This is a
//                compositing job. It is far more faithful, because the person is
//                literally the photograph — nothing about them is invented.
//
//   "reimagine" — generate a NEW photo of the same person in a new pose/outfit.
//                More creative freedom, less exact. This is the old behaviour.
//
// Do not water down the preservation list in "restage". Every line in it is
// there because leaving it out lets the model drift somewhere.
// ─────────────────────────────────────────────────────────────────────────────
// SHOT SIZE. Pulled out of LOOK.base so it's a dial, not a hardcode. Framing is
// half of what makes a picture feel editorial, and one crop for everything gets
// boring fast.
// ─────────────────────────────────────────────────────────────────────────────
const SHOT = {
  beauty: { label: "Beauty", body:
    "FRAMING - BEAUTY SHOT. Tight and intimate. Head and shoulders, or head to upper chest. The face " +
    "fills most of the frame. Crop into the top of the head or the shoulders if it makes a stronger " +
    "picture - editorial crops are bold, not polite. Shoot on an 85mm at a wide aperture: shallow " +
    "focus, the eyes tack sharp, the environment dissolved into soft colour and shape behind. The " +
    "LOCATION still reads through the light, the colour and the bokeh, even though little of it is " +
    "visible. This shot lives on SKIN and EYES: real pores, real texture, catchlights, the fine hairs " +
    "at the hairline. Do not centre the face perfectly - offset it, let it breathe unevenly." },

  half: { label: "Half Body", body:
    "FRAMING - HALF BODY. From the top of the head (or cropped just into it) down to roughly mid-thigh. " +
    "The person and the place share the frame about equally. Shoot on a 50mm at eye level or slightly " +
    "below. You can see the outfit properly - the cut, the drape, the fabric, the hands. Enough of the " +
    "location to know exactly where she is. Place her OFF-CENTRE, weight the frame to one side, leave " +
    "real negative space on the other." },

  full: { label: "Full Frame", body:
    "FRAMING - FULL FRAME. Wide and environmental. The LOCATION is the co-star, not a backdrop. The " +
    "whole body in frame with air above and below. Shoot on a 35mm. Place the person OFF-CENTRE, using " +
    "roughly a third of the frame, and leave generous negative space. Do NOT centre her. Do not crop " +
    "tight. The scale of the place against the person IS the picture." }
};

// ─────────────────────────────────────────────────────────────────────────────
// The preservation block. Every mode that keeps the person uses this, word for
// word. Each line is here because leaving it out lets the model drift.
// Short and blunt ON PURPOSE. The previous version of this was ~400 words and it
// made things WORSE — image editors follow short, forceful commands and start
// paraphrasing (i.e. regenerating) when you bury the instruction in an essay.
// Every word here is load-bearing. Do not pad it back out.
// SOFT identity guidance, on purpose.
//
// We tried hard pixel-lock compositing ("do not re-pose, do not change a thing").
// It produced WORSE images — fighting the model's nature made it brittle and ugly.
// So we let it GENERATE, and feed it MANY reference photos of the same person in
// the SAME OUTFIT instead. It learns her face and her clothes from the whole set
// and renders them its own way. Better pictures, close-enough likeness. That is a
// deliberate trade, made with eyes open.
const KEEP_PERSON =
  "IDENTITY - the most important thing, above all else:\n" +
  "Every attached photo is the SAME PERSON, wearing the SAME OUTFIT, from different angles. " +
  "Study them ALL together to build a complete, precise understanding of her exact face, then " +
  "render THAT EXACT FACE. Strictly maintain her exact facial likeness and identity. The output " +
  "must look unmistakably like HER - the same specific woman, not a lookalike, not a relative, not " +
  "a model who resembles her. If someone who knows her saw the result, they must recognise her " +
  "instantly.\n" +
  "  - Face: replicate her EXACT bone structure, the exact shape and spacing of her eyes, her exact " +
  "nose shape and nose bridge, her exact mouth and lips, her exact jawline and chin, her exact " +
  "brows, and her exact skin tone. Do not average her features toward a prettier or more generic " +
  "face. Her specific face is the whole point.\n" +
  "  - Outfit: the same garments she wears in the references - same cut, fabric, colour and " +
  "detail. Do not invent different clothes.\n" +
  "  - Hair: the same style, length, texture and colour, with its natural flyaways.\n" +
  "  - Body: her real proportions. Do not slim or lengthen her.\n\n";

// ─────────────────────────────────────────────────────────────────────────────
// SKIN & LIGHT. This is the block that kills the "AI matte face."
//
// Left alone, the model renders flat, even, retouched-looking skin — because it
// was trained on beauty-retouched images where retouchers DELETE exactly the
// highlights that make skin look real. So we have to (a) explicitly demand the
// specular highlights back and (b) explicitly forbid the matte look, or it
// reverts to airbrushed every time. Both halves are load-bearing.
const SKIN =
  "SKIN MUST LOOK LIT AND REAL, NOT MATTE AND RETOUCHED:\n" +
  "  - Give the skin real SPECULAR HIGHLIGHTS - the small bright hotspots where light bounces off " +
  "the natural oil and moisture of the face: the tops of the cheekbones, the bridge and tip of the " +
  "nose, the brow bones, the cupid's bow, a wet gleam on the lower lip, the chin, the tops of the " +
  "shoulders and collarbones. These highlights are what make skin read as real skin.\n" +
  "  - Put bright, sharp CATCHLIGHTS in the eyes - a real reflection of the light source. Eyes " +
  "without catchlights look dead and fake.\n" +
  "  - Let the skin have a natural sheen and a slight dewiness. A little shine is correct. Sweat-" +
  "sheen in warm light is correct.\n" +
  "  - Keep real texture underneath: visible pores, fine lines, faint unevenness, the soft peach-" +
  "fuzz at the hairline and jaw catching the light.\n" +
  "  - FORBIDDEN: flat matte skin, evenly-lit skin, powdered or airbrushed skin, blurred or " +
  "smoothed skin, a uniform poreless surface, that plastic or waxy 'AI face' look, beauty-filter " +
  "skin. If the face looks retouched or matte, it is WRONG.\n" +
  "  - The light on the face must have clear DIRECTION: one side brighter, the other falling into " +
  "shadow, with the highlights sitting on the lit side. Never flat, frontal, shadowless light.\n\n";

const INTEGRATE =
  "Then integrate them into that environment so it looks real:\n" +
  "  - Relight the person to match the new scene. Match the direction of the light, its colour " +
  "temperature, its hardness or softness, and its intensity. If the light in the new scene comes " +
  "from one side, the light on the person must come from that same side.\n" +
  "  - Match the colour grade of the person to the environment so they share one palette.\n" +
  "  - Add correct contact shadows where the person meets the ground or any surface, and cast a " +
  "believable shadow in the direction the new light dictates.\n" +
  "  - Match the depth of field, focus falloff and grain of the new scene.\n\n";

function buildPrompt(scene, mode, preset, shot) {
  const s = String(scene || "").trim();
  const framing = (SHOT[shot] || SHOT.full).body;

  // ── HIGH FASHION ──
  if (mode === "editorial") {
    const look = LOOK[preset] || LOOK.capri;
    return (
      "Create a high-fashion editorial photograph of the person in the attached reference photos.\n\n" +
      KEEP_PERSON +
      "PUT HER HERE:\n" + look.body + "\n\n" +
      (s ? "Also: " + s + "\n\n" : "") +
      framing + "\n\n" +
      LOOK.base + "\n\n" +
      SKIN +
      "The result must look like a real frame from a fashion magazine editorial, shot on film, of " +
      "THIS person on location. Photographed, not generated."
    );
  }

  // ── STYLE MATCH ──
  if (mode === "stylematch") {
    return (
      "The attached images come in two groups.\n" +
      "  The FIRST images are THE PERSON - the same woman, same outfit, different angles.\n" +
      "  The LAST image is the STYLE REFERENCE.\n\n" +

      "Create a new photograph of THE PERSON in the world of the STYLE REFERENCE.\n\n" +

      KEEP_PERSON +

      "FROM THE STYLE REFERENCE, copy everything else precisely:\n" +
      "  - Its location and environment.\n" +
      "  - The direction, colour temperature, hardness and intensity of its light.\n" +
      "  - Its exact colour grade: palette, saturation, contrast, how lifted or crushed the blacks " +
      "are, how blown the highlights are, any colour cast.\n" +
      "  - Its film grain, lens character, flare and depth of field.\n" +
      "  - Its framing, camera angle, camera height and use of negative space.\n" +
      "  - Its pose energy, attitude and overall mood.\n\n" +

      "CRITICAL: do NOT copy the FACE or BODY of any person in the STYLE REFERENCE, and do not blend " +
      "them with our person. Their face is irrelevant. Take only the world, the light, the grade and " +
      "the mood. The only person in the result is OUR person from the first images.\n\n" +

      (s ? "Also: " + s + "\n\n" : "") +
      SKIN +
      "It must look like our person was really photographed on that set, by that photographer, on " +
      "that camera, on that day. Photographed, not generated."
    );
  }

  // ── FAKE IT (default): generate her into a described scene. ──
  return (
    "Create a photograph of the person in the attached reference photos, " + s + ".\n\n" +
    KEEP_PERSON +
    framing + "\n\n" +
    SKIN +
    "Render it as a real photograph - natural film grain, believable depth of field, slightly " +
    "imperfect framing. It must look photographed, not generated."
  );
}

// Vercel caps a serverless request body at 4.5MB by DEFAULT. Base64 inflates a
// file by ~37%, so one big phone photo can blow past it — and when it does,
// Vercel rejects the request before this file ever runs and returns a non-JSON
// error, which Safari reports as "The string did not match the expected pattern."
// The browser now downscales photos to ~1280px before upload (see shrink() in
// App.jsx), which is the real fix. This raises the ceiling as a safety net.
export const config = {
  api: { bodyParser: { sizeLimit: "20mb" } }   // 8 reference photos at 1600px + a style photo need more headroom
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    const scene   = String(body.scene || "").trim();
    const consent = body.consent === true;
    const photos  = (Array.isArray(body.photos) ? body.photos : [])
      .filter(p => p && p.data && p.mimeType)
      .slice(0, 8); // as many as we can send. More angles of the same outfit = better likeness.

    // Belt-and-braces: if something huge still gets through, say so in plain
    // English instead of letting the platform return an unparseable error.
    const totalBytes = photos.reduce((n, p) => n + (p.data ? p.data.length : 0), 0)
                     + (body.stylePhoto && body.stylePhoto.data ? body.stylePhoto.data.length : 0);
    if (totalBytes > 19 * 1024 * 1024) {
      return res.status(413).json({ error: "Those photos are too large. Try one photo, or a smaller one." });
    }

    const allowedRatios = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
    const aspectRatio = allowedRatios.includes(body.aspectRatio) ? body.aspectRatio : "4:5";
    const quality = body.quality === "high" ? "high" : "standard";
    // restage    = keep the exact person, swap the world (default)
    // reimagine  = generate a new photo of them in a new pose/outfit
    // editorial  = High Fashion tab: drop them into a fully-specified editorial look
    // stylematch = Style Match tab: image 1 = person, image 2 = look to copy
    const MODES = ["restage", "reimagine", "editorial", "stylematch"];
    const mode = MODES.includes(body.mode) ? body.mode : "restage";

    const preset = LOOK[body.preset] ? body.preset : "capri";
    const shot   = SHOT[body.shot] ? body.shot : "full";   // beauty | half | full

    const stylePhoto = (body.stylePhoto && body.stylePhoto.data && body.stylePhoto.mimeType)
      ? body.stylePhoto : null;

    // ── Basic validation ──
    if (!consent)       return res.status(400).json({ error: "Please confirm these are photos of you before continuing." });
    if (!photos.length) return res.status(400).json({ error: "Upload at least one clear photo of your face." });

    // "editorial" picks a look from a grid, so a typed scene is optional.
    // "stylematch" gets its scene FROM the reference image, so it's optional too.
    if (!scene && mode !== "editorial" && mode !== "stylematch") {
      return res.status(400).json({ error: "Describe the scene — a place, an outfit, a vibe." });
    }
    if (mode === "stylematch" && !stylePhoto) {
      return res.status(400).json({ error: "Upload a style reference image — the look you want to copy." });
    }

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

    // The style reference is a user upload too — it gets checked as well.
    if (stylePhoto) {
      const safeStyle = await photoIsSafe(key, [stylePhoto]);
      if (!safeStyle.ok) {
        return res.status(400).json({
          error: safeStyle.reason.indexOf("under 18") > -1
            ? "That style reference appears to show a minor and can't be used."
            : "That style reference can't be used. Try a different one."
        });
      }
    }

    // ── Only now do we take the money ──
    const cost = quality === "high" ? 450 : 150;
    const paid = await spend(token, cost, "restage:" + mode + (mode === "editorial" ? ":" + preset : "") + ":" + shot + ":" + quality);
    if (!paid.ok) return res.status(402).json({ error: paid.error });

    // ── Generate ──
    const model = quality === "high" ? "gemini-3-pro-image-preview" : "gemini-2.5-flash-image";

    // ⚠️ THE BIG ONE. Sending an aspectRatio on an EDIT is self-defeating.
    // If the source photo is 3:4 and we demand 4:5, the model physically CANNOT
    // preserve the person's pixels — the canvas is a different shape, so it must
    // recompose, and once it recomposes it REDRAWS the person. That is exactly
    // why the pose and face kept drifting: we were saying "don't change them" and
    // "change the shape of the picture" in the same breath, and the second one wins.
    //
    // So: only "reimagine" (which genuinely generates a new photo) gets an aspect
    // ratio. Every compositing mode inherits the source photo's shape and says
    // nothing about framing.
    // Everything generates now, so the aspect ratio is honest again — we're no
    // longer promising to preserve a crop we were about to change anyway.
    const imageConfig = { aspectRatio };
    if (quality === "high") imageConfig.imageSize = "2K";

    // Photo ORDER MATTERS. In stylematch the prompt says "IMAGE 1 is the person,
    // IMAGE 2 is the style reference" — so the person MUST go first.
    // In any compositing mode we send exactly ONE photo of the person: extra
    // references just confuse it (which pose is it meant to keep?). Only
    // "reimagine" genuinely benefits from multiple references.
    // Send EVERY reference photo. That IS the strategy now: more angles of the same
    // person in the same outfit beats any amount of nagging the model. In stylematch
    // the style reference goes LAST, because the prompt says "the LAST image is the
    // style reference" — order matters.
    const sendPhotos = (mode === "stylematch") ? [...photos, stylePhoto] : photos;

    const parts = [
      ...sendPhotos.map(p => ({ inlineData: { mimeType: p.mimeType, data: p.data } })),
      { text: buildPrompt(scene, mode, preset, shot) }
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
