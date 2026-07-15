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
    "  - Framing: wide and environmental. The location is the co-star. Leave generous negative " +
    "space. Place the person OFF-CENTRE, using roughly a third of the frame. Do NOT centre them. " +
    "Do not crop tight to the face.\n" +
    "  - Attitude: distant, composed, self-possessed, caught mid-thought. Not smiling at the camera. " +
    "Not posing for the camera. They look away, past the lens, or down.\n" +
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

  // ═══ BEAUTY LOOKS — close on the body and face, environment carried by light,
  //     colour and what sits just behind the skin. Framing is baked into each
  //     body because this endpoint has no separate framing system. ═══

  // ── WATER ──
  b_oceanface: { label: "Ocean Surface", body:
    "FRAME: an extreme close-up, the face half-submerged at the waterline of a calm sea, eyes just " +
    "above the surface looking into the lens, wet hair strands across the forehead.\n" +
    "LOCATION: open ocean at golden hour, the water surface filling the lower frame, a soft blurred " +
    "horizon and pale sky behind.\n" +
    "LIGHT: low warm sun from one side, catching every water droplet beaded on the skin, wet lashes, " +
    "and a bright ripple of reflected light bouncing up off the water onto the underside of the face.\n" +
    "GRADE: warm honey skin against cool blue-green water. Crisp detail on the wet skin - droplets, " +
    "freckles, sheen - with the sea softly out of focus. Rich, tactile, sun-soaked." },

  b_splash: { label: "Through Water", body:
    "FRAME: a tight beauty close-up of the face seen through and between rushing, swirling water, " +
    "wearing tinted sunglasses, lips parted, water streaming over the skin.\n" +
    "LOCATION: abstract - the water IS the environment, sheets and ribbons of clear water wrapping " +
    "the face, catching light as it moves.\n" +
    "LIGHT: bright directional light through the water, throwing caustic ripples of light across the " +
    "lips and cheeks, glossy wet highlights everywhere.\n" +
    "GRADE: warm amber through the lenses against neutral wet skin. High detail, high gloss, every " +
    "droplet sharp. Sensual, kinetic, expensive." },

  b_lakeboat: { label: "Dark Lake", body:
    "FRAME: shot from above and behind at half-body, leaning forward over the bow of a dark wooden " +
    "boat, reaching toward the water, face turned enough to catch the profile.\n" +
    "LOCATION: a still, dark, glassy lake mirroring a pale cloudy sky - deep green-black water with " +
    "soft cloud reflections, the weathered timber bow cutting through the frame.\n" +
    "LIGHT: flat, cool, overcast north-light. Soft and even, with a silvery sheen on the water and " +
    "gentle wraparound shadow on the body.\n" +
    "GRADE: quiet and painterly. Ivory, walnut brown, deep green-black. Low contrast, muted " +
    "saturation, still and cinematic." },

  // ── SUN & SAND ──
  b_goldensand: { label: "Gilded Sand", body:
    "FRAME: a tight beauty close-up, lying with the cheek resting on the arms in warm sand, face " +
    "toward camera, wet hair strands falling across the brow, gold jewellery catching light.\n" +
    "LOCATION: fine golden beach sand filling the frame, tiny grains dusted across the forearms and " +
    "shoulder, nothing else - the world reduced to sand, skin and gold.\n" +
    "LIGHT: low warm afternoon sun raking across the face, making the skin glisten with sheen and " +
    "fine glitter, deep soft shadows in the eye sockets and under the jaw.\n" +
    "GRADE: monochromatic gold - bronze skin, golden sand, brass jewellery. Warm, rich, glowing, " +
    "with real pores and sun-sheen. Sultry and tactile." },

  b_whitebeach: { label: "White Haze Beach", body:
    "FRAME: half-body, reclining propped on one arm in pale sand, sand dusted and clinging across " +
    "one side of the body, gaze straight down the lens.\n" +
    "LOCATION: a white-sand beach dissolved in bright haze - the sea and sky merge into one pale, " +
    "glowing backdrop with almost no horizon.\n" +
    "LIGHT: strong backlight through haze - the whole background blown to soft white, the body " +
    "rim-lit, the face gently filled by light bouncing off the sand.\n" +
    "GRADE: bleached and luminous. Pale bone background, deep tanned skin as the only rich tone in " +
    "frame. Soft contrast on the world, crisp texture on the skin and the clinging sand." },

  b_bluedusk: { label: "Blue Dusk", body:
    "FRAME: full-body from behind or three-quarter, standing at the water's edge, arms stretched " +
    "overhead, the body a sculpted line against sea and sky.\n" +
    "LOCATION: a dark ocean at dusk under a deep, clean, cloudless blue sky grading darker at the " +
    "top, a thin far horizon line.\n" +
    "LIGHT: the last cool light of the day plus a subtle warm kick from one side, giving the skin a " +
    "polished bronze sheen along every muscle line.\n" +
    "GRADE: deep navy and bronze. Saturated dusk blue against glowing warm skin, rich shadows, " +
    "high polish. Sculptural, athletic, monumental." },

  b_sunvisor: { label: "White Wall Sun", body:
    "FRAME: a tight beauty portrait against a wall, head and shoulders, chin level, lips parted, " +
    "stillness like a campaign shot.\n" +
    "LOCATION: a white stucco wall in full sun - its rough texture in crisp focus, a hard shadow of " +
    "the head thrown onto the wall to one side.\n" +
    "LIGHT: brutal direct midday sun straight onto the face. Glossy specular highlights on the " +
    "forehead, nose and lips, freckles vivid, skin glowing with sheen and sweat.\n" +
    "GRADE: hot and clean. Bleached white wall, deep warm skin, glinting gold accents. High " +
    "contrast, high detail, unapologetically sunlit." },

  // ── HARD LIGHT ──
  b_shadowplay: { label: "Shadow Play", body:
    "FRAME: a beauty close-up, head tilted back, one hand raised flat above the brow to shield the " +
    "sun, so a hard shadow falls diagonally across the eyes and nose while the mouth and chin blaze " +
    "in full light.\n" +
    "LOCATION: a bright white wall or architectural plane behind, cut by bold diagonal shadows from " +
    "unseen structures - pure graphic geometry.\n" +
    "LIGHT: one hard, high sun. Razor-edged shadows carving the face into lit and unlit planes, " +
    "glossy highlights on the lips and the cheekbone in sun.\n" +
    "GRADE: graphic and warm-neutral. Bright bone whites, deep brown shadows, luminous skin. High " +
    "contrast, precise, sculptural - light as makeup." },

  b_citypower: { label: "City Power", body:
    "FRAME: half-to-full body shot from a low angle looking up, stance wide and dominant, chin " +
    "lifted, towering over the camera.\n" +
    "LOCATION: dark high-rise towers rising behind against a saturated deep teal sky, the street " +
    "world far below and out of frame.\n" +
    "LIGHT: hard direct flash-like key on the body against the darker city - crisp, fashion-flash " +
    "edges, deep dramatic shadow behind.\n" +
    "GRADE: bold editorial punch. Inky building blacks, electric teal sky, clean bright skin. High " +
    "contrast, saturated, fierce - a 2000s fashion-flash statement." },

  // ── MACHINES ──
  b_rivadeck: { label: "Riva Deck", body:
    "FRAME: half-body from slightly above, seated back against cream leather at the helm of a " +
    "classic wooden runabout, one hand resting on the wheel, face turned to the light.\n" +
    "LOCATION: a varnished mahogany and cream-leather Italian speedboat, teak deck lines, chrome " +
    "trim, deep blue sea with a soft wake behind.\n" +
    "LIGHT: full clean afternoon sun, warm and direct, sparkling off the chrome and the water, a " +
    "soft warm bounce up off the cream leather into the face.\n" +
    "GRADE: nautical luxury. Deep navy water, honey timber, cream leather, sun-warm skin. Crisp, " +
    "rich, saturated - a Riviera campaign." },

  b_backseat: { label: "Back Seat", body:
    "FRAME: half-body lounging across the tan leather back seat of a vintage car, one arm along the " +
    "seat back, legs crossed, face in profile or turned to the window.\n" +
    "LOCATION: a 70s sedan interior - caramel leather, chrome window frames - with a deep blue sea " +
    "and sky filling every window.\n" +
    "LIGHT: punchy direct sun through the windows plus a crisp flash-like key: sharp highlights on " +
    "the leather, clean bright skin, hard little shadows.\n" +
    "GRADE: saturated and graphic. Caramel leather, cobalt sea, bright whites. Bold contrast, " +
    "glossy, sharp - a sun-drenched campaign frame." },

  b_carwindow: { label: "Vintage Interior", body:
    "FRAME: half-body seated in a vintage car's passenger seat, framed through the open window or " +
    "windscreen, one hand in the hair, gaze away down the road.\n" +
    "LOCATION: an old convertible's cabin - stitched tan leather bench, black dashboard, chrome " +
    "mirror - the world outside soft and out of focus.\n" +
    "LIGHT: soft, warm, directional daylight through the glass, gentle falloff into the cabin's " +
    "shadows, a warm bounce off the leather under the chin.\n" +
    "GRADE: warm 70s film. Caramel, cream, walnut, soft denim blue outside. Gentle contrast, creamy " +
    "highlights, nostalgic and intimate." },

  b_cockpit: { label: "Cockpit", body:
    "FRAME: half-body seated in a vintage light-aircraft cockpit, leaning slightly toward camera, " +
    "sunglasses on, framed by the windscreen struts and the instrument panel.\n" +
    "LOCATION: a 1950s propeller plane cabin - black dial instruments, worn brown leather seats, " +
    "pale overcast sky filling the cockpit glass.\n" +
    "LIGHT: soft, even, overcast daylight through the canopy - flat and flattering, with gentle " +
    "reflections in the sunglasses and a soft sheen on the coat.\n" +
    "GRADE: quiet vintage. Cream, cognac leather, charcoal instruments, milky sky. Muted saturation, " +
    "soft film contrast, timeless." },

  b_helipad: { label: "Helipad", body:
    "FRAME: full-body stepping down from a black helicopter, one hand on the door frame, wind in " +
    "the hair, mid-stride toward camera.\n" +
    "LOCATION: a wet dark tarmac helipad under a heavy overcast sky, the glossy black machine " +
    "filling the background, rotor blades cutting the top of frame.\n" +
    "LIGHT: soft dramatic storm-light - a huge overcast softbox from above, with the wet tarmac " +
    "bouncing cool light up, and the black fuselage framing the figure in darkness.\n" +
    "GRADE: steel and skin. Gunmetal greys, wet-asphalt blacks, warm legs and face as the only " +
    "warmth in frame. Moody contrast, cinematic, powerful." },

  // ── STUDIO ──
  b_bronze: { label: "Bronze Sculpt", body:
    "FRAME: an intimate beauty close-up in profile-to-three-quarter, eyes closed, chin lifted, one " +
    "arm raised behind the head - the face and neck as sculpture.\n" +
    "LOCATION: a bare, seamless warm-grey studio backdrop, nothing else - all attention on skin.\n" +
    "LIGHT: one warm directional beauty light raking across the face, plus a soft rim from behind: " +
    "the skin oiled and glowing, molten highlights pooling on the cheekbone, brow bone, cupid's bow " +
    "and shoulder, deep soft shadow everywhere else.\n" +
    "GRADE: liquid bronze. Deep warm browns, molten gold highlights, soft smoky background. Very " +
    "low key, very high polish - skin rendered like poured metal." },
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
// The preservation block. Every mode that keeps the person uses this, word for
// word. Each line is here because leaving it out lets the model drift.
const KEEP_PERSON =
  "═══ ABSOLUTE, NON-NEGOTIABLE RULE — THIS OVERRIDES EVERYTHING ELSE BELOW ═══\n" +
  "The person in the attached photograph must appear in the output as THE SAME HUMAN BEING. Not a " +
  "similar-looking person. Not an idealised version. Not a model who resembles them. The SAME " +
  "person, recognisable instantly by anyone who knows them.\n\n" +

  "TREAT THE PERSON AS A FIXED, UNEDITABLE LAYER. You are compositing them into a new background. " +
  "You are NOT redrawing them. If any instruction later in this prompt would change the person, " +
  "IGNORE that instruction. The environment must bend around the person, never the reverse.\n\n" +

  "COPY THE PERSON PIXEL-FOR-PIXEL. Preserve, with zero alteration:\n" +
  "  - FACE: the exact bone structure, jawline, cheekbones, brow, nose shape, lip shape, eye shape " +
  "and eye spacing. The exact skin tone. The exact expression. The exact eye direction. Any freckles, " +
  "moles, marks or scars stay exactly where they are.\n" +
  "  - POSE: the exact position of the head, neck, shoulders, torso, arms, hands, fingers, legs and " +
  "feet. The exact tilt of the head. The exact angle of the body to camera. Do NOT re-pose, " +
  "straighten, or 'improve' the pose in any way.\n" +
  "  - BODY: the exact body shape, proportions and size. Do NOT slim, lengthen, lift, sculpt, or " +
  "otherwise flatter the body. Their body is correct as photographed.\n" +
  "  - HAIR: the exact style, length, texture, parting and colour, including every flyaway and stray " +
  "strand exactly where it falls.\n" +
  "  - OUTFIT: every garment, its exact cut, drape, fabric, colour, pattern, logo and detail. Every " +
  "fold and wrinkle. Do NOT restyle, swap, add or remove clothing.\n" +
  "  - ACCESSORIES: all jewellery, bags, glasses, watches, and anything held, exactly as they are.\n" +
  "  - SKIN: real texture - pores, fine lines, natural unevenness, blemishes, sheen. Do NOT smooth, " +
  "retouch, airbrush, blur, even out, or beautify the skin in any way.\n\n" +

  "FORBIDDEN: changing the face. Changing the pose. Changing the body. Changing the outfit. " +
  "Prettifying. Slimming. Smoothing. Making them look more like a professional model. Substituting a " +
  "different person. Blending in a second face. If the output shows a different person, the image is " +
  "a FAILURE, no matter how good the environment looks.\n\n" +

  "The ONLY thing you may change about the person is the LIGHT falling on them and the COLOUR GRADE " +
  "applied to them, so they sit believably in the new environment.\n" +
  "═══════════════════════════════════════════════════════════════════════════\n\n";

const INTEGRATE =
  "Then integrate them into that environment so it looks real:\n" +
  "  - Relight the person to match the new scene. Match the direction of the light, its colour " +
  "temperature, its hardness or softness, and its intensity. If the light in the new scene comes " +
  "from one side, the light on the person must come from that same side.\n" +
  "  - Match the colour grade of the person to the environment so they share one palette.\n" +
  "  - Add correct contact shadows where the person meets the ground or any surface, and cast a " +
  "believable shadow in the direction the new light dictates.\n" +
  "  - Match the depth of field, focus falloff and grain of the new scene.\n\n";

function buildPrompt(scene, mode, preset, presetWasSent) {
  const s = String(scene || "").trim();

  // ── HIGH FASHION: drop them into a fully-specified editorial world. ──
  if (mode === "editorial") {
    const look = LOOK[preset] || LOOK.capri;
    return (
      "You are editing the attached photograph. Do NOT generate a new person, and do NOT re-pose them.\n\n" +
      KEEP_PERSON +
      "PLACE THEM IN THIS WORLD:\n" + look.body + "\n\n" +
      (s ? "The user also asks for: " + s + "\n\n" : "") +
      LOOK.base + "\n\n" +
      INTEGRATE +
      "The result must look like a real frame from a high-fashion magazine editorial, shot on film, " +
      "of THIS EXACT PERSON on location. Photographed, not generated."
    );
  }

  // ── STYLE MATCH: image 1 is the person, image 2 is the look to copy. ──
  if (mode === "stylematch") {
    return (
      "You are given TWO images.\n" +
      "  IMAGE 1 is THE PERSON.\n" +
      "  IMAGE 2 is THE STYLE REFERENCE.\n\n" +

      "Put the person from IMAGE 1 into the world of IMAGE 2.\n\n" +

      KEEP_PERSON +

      "That absolute rule applies to the person in IMAGE 1 ONLY.\n\n" +

      "FROM IMAGE 2, take EVERYTHING ELSE — copy its look precisely:\n" +
      "  - The location and environment.\n" +
      "  - The direction, colour temperature, hardness and intensity of its light.\n" +
      "  - Its exact colour grade: the palette, the saturation, the contrast, how lifted or crushed " +
      "the blacks are, how blown the highlights are, any colour cast.\n" +
      "  - Its film grain, lens character, flare and depth of field.\n" +
      "  - Its framing, camera angle and camera height, and how much negative space it leaves.\n" +
      "  - Its overall mood and attitude.\n\n" +

      "CRITICAL: do NOT copy, keep, or blend in any PERSON who appears in IMAGE 2. Their face, body " +
      "and clothing are irrelevant and must not influence the person from IMAGE 1. Take only the " +
      "world, the light and the grade from IMAGE 2. The only person in the result is the person " +
      "from IMAGE 1.\n\n" +

      (s ? "The user also asks for: " + s + "\n\n" : "") +
      INTEGRATE +
      "The result must look like the person from IMAGE 1 was really photographed on the set of " +
      "IMAGE 2, by the same photographer, on the same camera, on the same day. Photographed, not " +
      "generated."
    );
  }

  if (mode === "reimagine") {
    return (
      "Using the attached photo(s) as the reference for this person, generate a new photograph " +
      "of the SAME person, " + s + ".\n\n" +

      "IDENTITY — the most important instruction:\n" +
      "Preserve this person's face exactly as it appears in the reference. Keep the same facial " +
      "structure, bone structure, eyes, nose and mouth, the same skin tone, and the same real skin " +
      "texture including pores, fine lines and natural unevenness. Keep the same hair texture " +
      "including its natural frizz and flyaways. Do NOT smooth, retouch, airbrush, slim or beautify " +
      "them. Do NOT alter their features. They must be immediately recognisable as the person in " +
      "the reference photo.\n\n" +

      "REALISM:\n" +
      "Light the scene with a single clear directional source so shadows fall believably across one " +
      "side of the face. Render it as a real candid photograph - natural grain, believable depth of " +
      "field, natural catchlights in the eyes, slightly imperfect framing. Avoid a glossy, waxy, " +
      "airbrushed or CGI look. Avoid flat, directionless studio lighting. It should look photographed, " +
      "not generated."
    );
  }

  // ── DEFAULT: plain restage. Keep the person, swap the world. ──
  // If a preset id arrives, its environment text IS the place. Deliberately no
  // LOOK.base, no beauty real-face clause, no styling add-ons — Fake It keeps
  // its exact twin prompt; only the destination changes.
  const place = (LOOK[preset] && presetWasSent)
    ? LOOK[preset].body + (s ? "\n\nAlso: " + s : "")
    : s;
  return (
    "You are editing the attached photograph. Do NOT generate a new person, and do NOT re-pose them.\n\n" +
    KEEP_PERSON +
    "CHANGE ONLY THE ENVIRONMENT AROUND THEM. Place them in: " + place + "\n\n" +
    INTEGRATE +
    "  - Keep the same camera angle, distance and framing relative to the person.\n\n" +
    "The result must look like this exact photograph was originally taken in that place - a real " +
    "photo, not a cut-out pasted onto a backdrop. Photographed, not generated."
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
    const totalBytes = photos.reduce((n, p) => n + (p.data ? p.data.length : 0), 0)
                     + (body.stylePhoto && body.stylePhoto.data ? body.stylePhoto.data.length : 0);
    if (totalBytes > 9 * 1024 * 1024) {
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
    // Fake It can now use the preset library too: if a valid preset was explicitly
    // sent in restage mode, its environment text becomes the "place" — but the
    // generation stays on Fake It's own prompt path (no editorial composition
    // rules, no beauty styling). Just the place, on the twin engine.
    const presetSent = LOOK[body.preset] ? body.preset : null;

    const stylePhoto = (body.stylePhoto && body.stylePhoto.data && body.stylePhoto.mimeType)
      ? body.stylePhoto : null;

    // ── Basic validation ──
    if (!consent)       return res.status(400).json({ error: "Please confirm these are photos of you before continuing." });
    if (!photos.length) return res.status(400).json({ error: "Upload at least one clear photo of your face." });

    // "editorial" picks a look from a grid, so a typed scene is optional.
    // "stylematch" gets its scene FROM the reference image, so it's optional too.
    if (!scene && !presetSent && mode !== "editorial" && mode !== "stylematch") {
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
    const paid = await spend(token, cost, "restage:" + mode + (mode === "editorial" ? ":" + preset : "") + ":" + quality);
    if (!paid.ok) return res.status(402).json({ error: paid.error });

    // ── Generate ──
    const model = quality === "high" ? "gemini-3-pro-image-preview" : "gemini-2.5-flash-image";
    const imageConfig = quality === "high" ? { aspectRatio, imageSize: "2K" } : { aspectRatio };

    // Photo ORDER MATTERS. In stylematch the prompt says "IMAGE 1 is the person,
    // IMAGE 2 is the style reference" — so the person MUST go first.
    // In any compositing mode we send exactly ONE photo of the person: extra
    // references just confuse it (which pose is it meant to keep?). Only
    // "reimagine" genuinely benefits from multiple references.
    let sendPhotos;
    if (mode === "reimagine")        sendPhotos = photos;
    else if (mode === "stylematch")  sendPhotos = [photos[0], stylePhoto];   // person, then style
    else                             sendPhotos = photos.slice(0, 1);

    const parts = [
      ...sendPhotos.map(p => ({ inlineData: { mimeType: p.mimeType, data: p.data } })),
      { text: buildPrompt(scene, mode, preset, !!presetSent) }
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
