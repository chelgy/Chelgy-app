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
    "  - Attitude: distant, composed, self-possessed, caught mid-thought. Not posing or smiling " +
    "for the camera - cool, unbothered, a little unreadable.\n" +
    "  - Gaze: VARY IT, do not always look away. Any of these, whichever suits the frame: a cool " +
    "direct stare straight down the lens (often the strongest frame - use it freely); toward the " +
    "camera but focused just past it; eyes lowered and away, lost in thought; in profile out of " +
    "frame; or eyes closed, chin lifted into the light. The only thing forbidden is a posed, " +
    "camera-pleasing smile.\n" +
    "  - Camera: full-frame, 35mm or 50mm lens, at eye level or slightly low. Real depth of field " +
    "with a soft falloff, not a fake blurred cut-out.\n" +
    "  - Grain: real 35mm film grain, visible in the shadows and flat tones.\n" +
    "  - Skin: real texture, pores, sheen where sweat or oil would sit. Never airbrushed, never waxy.\n" +
    "  - AVOID at all costs: a centred subject, a smiling subject, flat directionless light, clean " +
    "even studio lighting, a crisp saturated 'clean' digital grade, HDR, a plastic sheen, stock " +
    "photography composition. It must look like an unretouched frame from a magazine shoot.",

  // ── ITALY / COAST ── (rewritten 1:1 from the reference images)
  capri: { label: "Capri Harbour", body:
    "FRAME: aboard a classic boat in Capri's harbour, seated at the transom rail, shot from deck " +
    "level with the harbour and town behind.\n" +
    "LOCATION: the deck of a varnished wooden boat on green harbour water. Behind her, across the " +
    "water: the whole of Capri town stacked up the mountainside - cream, white and ochre buildings " +
    "climbing the slope, moored white boats along the marina, a huge grey limestone peak dissolving " +
    "into haze at the top of frame.\n" +
    "LIGHT: warm hazy afternoon Mediterranean sun from one side, softened by sea haze, gentle " +
    "sparkle on the water, no hard shadows on the town.\n" +
    "GRADE: sun-warmed and slightly hazy. Green-jade harbour water, cream and terracotta town, " +
    "soft blue-grey mountain. Gentle contrast, warm skin, a faint golden veil over everything." },

  capriroad: { label: "Capri Clifftop", body:
    "FRAME: standing at the rear corner of a parked vintage taxi on a clifftop, half-leaning on the " +
    "boot, full body, sea and sky filling the background.\n" +
    "LOCATION: the back of a burgundy-red vintage Fiat convertible taxi - chrome bumper, old black " +
    "Naples number plate, a small TAXI sign on top, its tan canvas canopy folded open. Cracked pale " +
    "concrete underfoot, a low weathered stone parapet, and beyond it nothing but a vast pale sea " +
    "fading into a dusk sky, one soft headland far below.\n" +
    "LIGHT: the sun just gone. A pale gold-to-lavender afterglow lighting everything softly and " +
    "evenly from the sky - no hard shadows, a gentle glow on the car's curves.\n" +
    "GRADE: dusty pastel nostalgia. Oxidised red paint, faded gold sky, dove-grey stone. Very low " +
    "contrast, milky lifted blacks, muted saturation - like a sun-damaged 60s postcard." },

  coastroad: { label: "Coast Road", body:
    "FRAME: perched on the rear deck of a parked vintage roadster, side-on to camera, body turned " +
    "away with the face in profile over the shoulder, full figure against a blown-out sky.\n" +
    "LOCATION: a cream 1960s Jaguar E-Type convertible with chrome wire wheels and a long sculpted " +
    "bonnet, parked on cracked asphalt on a headland. Far below and behind: a hazy bay with moored " +
    "yachts, low scrubby hills, distant houses on a ridge - everything dissolving into silver haze.\n" +
    "LIGHT: hard low sun almost straight into the lens from behind her - strong rim light down the " +
    "arms and hair, the sky blown to white, deep soft shadow on the near side of the body and car.\n" +
    "GRADE: sun-drenched and bleached. Blown silver-white sky, glowing cream paintwork, warm skin " +
    "in shadow, desaturated hills. High contrast but faded - an overexposed 90s campaign frame." },

  clifftopglass: { label: "Clifftop Glass", body:
    "FRAME: standing pressed side-on against a tall pane of glass at the corner of a stone building, " +
    "three-quarter body, her full mirror reflection doubled in the glass beside her.\n" +
    "LOCATION: a minimal stone-and-glass building on a cliff edge. The huge glass pane holds a " +
    "perfect reflection of her AND of the view behind the camera: a grey-green sea, a wide headland " +
    "of scrub and rock, and a pale winding path cutting down toward the water.\n" +
    "LIGHT: cool, flat, overcast coastal daylight - soft, even and directionless, a silver sheen " +
    "sliding across the glass, gentle shadow where she meets it.\n" +
    "GRADE: cold elegance. Bone whites, slate glass, deep sea green, stone beige. Low saturation, " +
    "gentle contrast, crisp edges but a quiet, expensive stillness." },

  oceandusk: { label: "Ocean at Dusk", body:
    "FRAME: in profile, chest-deep in dead-still ocean at nightfall, fabric floating and billowing " +
    "on the waterline around her, a tight and reverent side portrait.\n" +
    "LOCATION: open sea at last light - flat, glassy, silver-grey water to the horizon, one dark " +
    "rock breaking the surface far behind, a vast pale empty sky.\n" +
    "LIGHT: the dim afterglow of a set sun. One faint soft edge of sky-light modelling the profile, " +
    "cheekbone and shoulder out of near-darkness; everything else falls into deep soft shadow.\n" +
    "GRADE: almost monochrome. Warm-grey water, cream-blush sky, deep umber shadow on the skin. " +
    "Very low contrast in the sky, rich shadow on the body - painterly, silent, devotional." },

  // ── STONE / ARCHITECTURE ──
  dubrovnik: { label: "Dubrovnik Stone", body:
    "FRAME: standing among pale boulders at the foot of a huge fortress wall, shot from slightly " +
    "below, full figure against the stone.\n" +
    "LOCATION: a towering medieval wall of massive weathered limestone blocks. Bolted to the stone: " +
    "old exposed iron plumbing - rusted vertical pipes each ending in a round outdoor shower head. " +
    "Pale sand, sea-worn rock and big honey-coloured boulders underfoot; the sea just out of frame.\n" +
    "LIGHT: hard, high Mediterranean midday sun. Sharp-edged shadows off every stone course and " +
    "pipe, strong specular highlights on skin, nothing filled in, nothing soft.\n" +
    "GRADE: hot and dry. Bleached sand-gold stone, dense brown shadow, low saturation, high " +
    "contrast - almost monochrome in the wall, the skin carrying the only warmth." },

  brutalist: { label: "Brutalist Coast", body:
    "FRAME: seated low in a vast empty concrete room, fabric spread wide across the floor around " +
    "her, shot wide with the architecture towering and the sea glowing beyond.\n" +
    "LOCATION: a raw board-formed concrete interior - massive square columns, a deep coffered " +
    "concrete ceiling, herringbone timber parquet meeting pale travertine. Behind, full-height " +
    "glazing with a slender frame opens onto a grey-green sea and a hazy stone breakwater.\n" +
    "LIGHT: flat, cool, overcast daylight pouring in through the glass wall - one soft directional " +
    "wash with a long gentle falloff into the room's shadow. No sun, no sparkle.\n" +
    "GRADE: cool and hushed. Concrete grey, sea-green, bone white, warm parquet brown. Muted, " +
    "atmospheric, lifted blacks - monumental and still." },

  whiteconcrete: { label: "White Concrete", body:
    "FRAME: seated square to camera on broad stone steps, knees wide, elbows on knees, a powerful " +
    "symmetrical low-angle portrait between hard geometry.\n" +
    "LOCATION: wide pale travertine steps climbing between sharp white concrete forms - a blank " +
    "monolithic wall on one side, angled sculptural blocks behind - a modernist rooftop of pure " +
    "geometry against a cloudless deep blue sky.\n" +
    "LIGHT: brilliant hard high sun. Crisp black-edged shadows cast by the blocks across the steps, " +
    "clean bright light on the face and hands, glinting metallic highlights.\n" +
    "GRADE: bold and graphic. Deep cobalt sky against bone-white stone, precise blacks, restrained " +
    "palette, high contrast - sculptural power." },

  // ── DESERT ──
  desert: { label: "Desert Highway", body:
    "FRAME: standing tall in front of a parked vintage car on an empty plain, fabric trailing and " +
    "pooling on the dirt, a wide cinematic frame with a huge sky and dead-flat horizon.\n" +
    "LOCATION: a pale blue-grey 1960s Chevrolet sedan - dusty chrome grille, twin headlights - " +
    "parked on a red-brown gravel plain. A rutted dirt road runs past it dead straight to the " +
    "vanishing point. No fence, no pole, nothing else to the horizon.\n" +
    "LIGHT: dusk, the sun already below the horizon. Flat, cool, directionless light with the " +
    "faintest warm glow low along the skyline. Long soft dimness, no shadows.\n" +
    "GRADE: cinematic and cold. Deep desaturated slate-blue sky, rust-red earth, muted chrome, " +
    "cool skin. Crushed but breathing shadows - the emptiness IS the picture." },

  desertsunset: { label: "Desert Sunset", body:
    "FRAME: leaning into the open driver's door of a vintage car, one hand raised into the hair, " +
    "body in a long S-curve, shot into the sun with the horizon at hip height.\n" +
    "LOCATION: a battered dusty pale-blue 60s Chevrolet on a flat scrub plain - low dry brush to a " +
    "dead-level horizon, dust on every panel, the door mirror catching the last light.\n" +
    "LIGHT: the sun ON the horizon directly behind the car - warm, low, glowing, haloing the hair " +
    "and rim-lighting the arms, long soft shadows reaching toward camera, gentle lens haze.\n" +
    "GRADE: warm and creamy. Butter-gold sky melting to dusty rose, rust earth, glowing skin, " +
    "sparkle where sequins or chrome catch the sun. Low contrast, lifted blacks, romantic." },

  desertsun: { label: "Desert Noon", body:
    "FRAME: standing over the camera from a low angle, arms raised behind the head, eyes closed, " +
    "chin lifted into the sun - monumental against a huge sky.\n" +
    "LOCATION: a stark bright desert plain strewn with broken pale rock and the low wrecks of " +
    "abandoned cars, hard dry mountains far behind, nothing alive anywhere.\n" +
    "LIGHT: savage overhead noon sun in a deep cloudless sky - tiny hard shadows straight down, " +
    "glaring specular highlights, sweat-sheen on the skin, metallic fabric flaring white where it " +
    "catches the sun.\n" +
    "GRADE: high-contrast and saturated. Deep inky navy sky against bleached ground, glittering " +
    "highlights, punchy sharp blacks - hot, bold, futuristic." },

  desertgold: { label: "Golden Desert", body:
    "FRAME: from behind at half-body, face turned away in profile, the garment and the light doing " +
    "the talking - shot straight into a low sun.\n" +
    "LOCATION: an open desert of pale sand and low dunes, soft dusty hills dissolving into golden " +
    "haze on the horizon, one warm ridge catching the last sun.\n" +
    "LIGHT: raking golden-hour sun straight into the lens from ahead of her - every fibre and bead " +
    "of the clothing lit like filament, the air thick with dust and glow, strong halation and " +
    "flare, deep warm shadow on the camera side.\n" +
    "GRADE: molten amber and bronze, almost monochrome in gold. Deep warm shadows, glowing blown " +
    "highlights, heavy atmospheric haze - sepia-adjacent and sculptural." },

  sandstone: { label: "Sandstone", body:
    "FRAME: seated on a rock ledge beneath towering eroded stone, one arm draped over a knee, " +
    "wet-look hair, shot from slightly below so the rock wave crests over her.\n" +
    "LOCATION: enormous wind-carved sandstone - layered, honeycombed, wave-like formations in " +
    "cream, ochre and charcoal banding, curling overhead like a breaking wave, pale sand and flat " +
    "rock shelves below, deep blue sky in the gaps.\n" +
    "LIGHT: hard, clean, high sun. Crisp shadows carving every ripple and hollow of the rock, " +
    "strong sculptural light modelling the face and hands.\n" +
    "GRADE: bold and elemental. Saturated deep blue sky against warm ochre stone, rich shadows, " +
    "punchy but never garish - primal and monumental." },

  // ── HOUSES / INTERIORS ──
  palmsprings: { label: "Palm Springs", body:
    "FRAME: standing at floor-to-ceiling glass looking out, three-quarter body framed by the warm " +
    "timber window frame, caught mid-moment - unposed, domestic, expensive.\n" +
    "LOCATION: a modernist desert house - huge glass panes in warm timber frames, a pale concrete " +
    "sill. Outside: a raked gravel courtyard with sculptural agave and a flowering aloe sending up " +
    "orange spikes, a second low pavilion across the court, and fog dissolving the desert beyond " +
    "into pale nothing.\n" +
    "LIGHT: soft, hazy, diffused morning light through marine fog - everything veiled and gentle, " +
    "one soft direction through the glass, no hard edges anywhere.\n" +
    "GRADE: warm neutral and dreamy. Sand, bone, pale timber, dusty sage, one hit of aloe orange. " +
    "Low contrast, lifted blacks, a faint warm bloom - languid and quiet." },

  timberdeck: { label: "Timber Deck", body:
    "FRAME: reclined in a low slatted deck chair, legs long and crossed toward camera, one arm up " +
    "behind the head - shot from just above deck level, intimate and unhurried.\n" +
    "LOCATION: the deck of a modernist timber house - rich vertical hardwood cladding, a huge " +
    "sliding glass door beside her reflecting the room within (a white bed just visible inside), a " +
    "pale timber slat chair, warm boards underfoot, a dark steel deck edge.\n" +
    "LIGHT: soft warm ambient afternoon light bounced off all that timber - gentle directional " +
    "falloff, deep warm shadow inside the glass, a soft sheen on skin and fabric.\n" +
    "GRADE: rich and warm - mahogany, rust, cognac, deep interior shadow. Saturated warm tones, " +
    "moody contrast, creamy highlights - sensual, private, 70s-cinematic." },

  woodroom: { label: "Wood Room", body:
    "FRAME: reclined full-length across sculptural furniture, propped on one elbow, legs extended, " +
    "shot square-on like a campaign plate with generous space around her.\n" +
    "LOCATION: a still, minimal room: a full wall of rich walnut panelling, a pale poured-concrete " +
    "floor, and one extraordinary piece of furniture - a low sculptural bentwood sofa of two " +
    "curved, polished walnut shells. Nothing else in the room.\n" +
    "LIGHT: soft, broad, controlled light from one side, like an enormous window just out of " +
    "frame - a gentle wraparound with slow falloff, no hard edges, calm and deliberate.\n" +
    "GRADE: warm neutral and hushed. Walnut brown, cream, bone, oat. Muted saturation, soft " +
    "contrast, lifted blacks - serene heritage-house luxury." },

  darkstudio: { label: "Dark Studio", body:
    "FRAME: a half-body portrait swallowed by darkness, the figure crisp at the eyes and smearing " +
    "into long horizontal motion streaks at every edge - a doubled, ghosting energy.\n" +
    "LOCATION: a pure black studio void - no set, no floor line, no props. Only the person, one " +
    "blaze of saturated colour in her clothing, and the dark.\n" +
    "LIGHT: a single hard light with a slow shutter dragged through the exposure: tack-sharp where " +
    "it catches the face, streaking into luminous trails and echoes everywhere else.\n" +
    "GRADE: deep black with one colour burning out of it - scarlet, oxblood, electric orange. " +
    "Crushed blacks, glowing highlights, heavy motion blur and ghost edges - avant-garde drama." },

  // ── STREET ──
  street: { label: "Street Blur", body:
    "FRAME: caught mid-stride walking fast toward camera, half-body, the whole frame smeared with " +
    "motion except the sunlit face - a stolen paparazzi frame.\n" +
    "LOCATION: a narrow old-city alley of dark brick and stone, fire escapes above, the walls and " +
    "pavement streaking past with movement, one bright wedge of daylight at the alley's end.\n" +
    "LIGHT: a hard low shaft of sun cutting between the buildings and landing square on the face " +
    "and collar - everything outside that beam falling into deep brown shadow, flare kissing the " +
    "sunglasses.\n" +
    "GRADE: warm and gritty. Amber sunlight, deep brown-black shadow, blown highlights, heavy " +
    "directional motion blur - kinetic, urgent, filmic." },

  // ── CITY & MACHINES ── (from the second reference batch)
  marblestreet: { label: "Marble Street", body:
    "FRAME: caught mid-stride walking past a grand storefront, full body, coat swinging with the " +
    "step, one leg extended - a real street moment, not a pose.\n" +
    "LOCATION: the base of a luxury flagship building - towering black marble columns veined in " +
    "white, fluted pilaster detail, a white marble corner, a warm-lit shop window with a mannequin, " +
    "pale stone pavement.\n" +
    "LIGHT: low golden late-afternoon city sun raking down the street - a warm glow on the face and " +
    "legs, the black marble holding deep reflections, long soft shadows on the pavement.\n" +
    "GRADE: rich and urban. Ink-black marble, warm gold light, deep shadow. Elegant contrast, " +
    "saturated warmth on skin against the dark stone - old-money city luxury." },

  mirrormaze: { label: "Mirror Maze", body:
    "FRAME: seated on a white floor leaning back on one hand, legs extended and crossed, " +
    "surrounded by her own reflections repeating to infinity on every side.\n" +
    "LOCATION: a mirrored installation room - full-height mirror panels at angles on a seamless " +
    "white floor, thin suspension wires catching light, every panel carrying another copy of her " +
    "receding into darkness above.\n" +
    "LIGHT: clean, even, bright studio light from above - crisp and shadow-soft on the white floor, " +
    "the mirror world above falling away into black.\n" +
    "GRADE: graphic and glamorous. Pure white floor, black mirror depths, one rich metallic accent. " +
    "Clean contrast, polished, endlessly repeating - a hall-of-mirrors campaign." },

  gildedbath: { label: "Gilded Bath", body:
    "FRAME: lying back fully clothed in an empty white bathtub, legs up over the rim, head resting " +
    "on a folded towel, holding the brass shower handset like a telephone - playful, decadent, " +
    "shot from above the tub's corner.\n" +
    "LOCATION: a grand old-hotel bathroom - black marble walls veined in gold, brass-framed " +
    "mirrors, warm sconce light, a deep white enamel tub with polished brass fittings, white " +
    "towels on a brass rail.\n" +
    "LIGHT: warm tungsten interior light - soft pools from the sconces, glows in the brass, deep " +
    "shadow in the marble, a gentle sheen down the tub's enamel.\n" +
    "GRADE: opulent and warm. Black-and-gold marble, cream enamel, brass glow, denim blue as the " +
    "cool accent. Rich contrast, honeyed highlights - Vogue-in-a-palace-hotel decadence." },

  slotcanyon: { label: "Slot Canyon", body:
    "FRAME: standing square to camera in a narrow canyon passage, hands in pockets, shot from " +
    "slightly below so the rock walls tower and curve overhead, a strip of pale sky above.\n" +
    "LOCATION: a slot canyon of dark wind-polished stone - smooth, layered, flowing rock walls in " +
    "deep umber and charcoal pressing in on both sides, fine pale gravel underfoot.\n" +
    "LIGHT: soft top-light falling down through the canyon opening - a gentle column of daylight " +
    "on the face and shoulders, the rock walls falling away into deep shadow around her.\n" +
    "GRADE: sculptural and quiet. Deep chocolate and slate rock, one bright pale figure glowing at " +
    "the centre, soft sky above. Moody contrast, rich shadow - cathedral light in stone." },

  privatejet: { label: "Private Jet", body:
    "FRAME: descending the fold-down stairs of a private jet mid-step, wind lifting the hair, " +
    "shot from just below eye level, three-quarter to full body against the fuselage.\n" +
    "LOCATION: a cream-and-gold private jet on wet tarmac - the open oval cabin door, polished " +
    "airstair with carpeted treads, engine nacelle behind, a flat grey horizon of airfield and " +
    "stormy sky.\n" +
    "LIGHT: soft dramatic overcast - one huge grey softbox of sky, a crisp fashion-flash kick on " +
    "the face and furs, the wet tarmac bouncing cool light up, everything slightly wind-blown.\n" +
    "GRADE: moneyed and moody. Champagne fuselage, storm-grey sky, deep blacks in the furs, warm " +
    "skin. Punchy editorial contrast - a first-class campaign frame." },

  whitesandstone: { label: "White Sandstone", body:
    "FRAME: shot from low looking up, chin lifted to the sun with the throat and jaw catching " +
    "light, one hand on the hip, fabric blowing - monumental against pale rock and a deep sky.\n" +
    "LOCATION: smooth wind-carved white-and-cream sandstone rising in soft layered waves behind, " +
    "a dark weathered crest of rock along its top edge, deep blue sky in the gap.\n" +
    "LIGHT: hard, clean, high sun - crisp shadows sliding down the rock's curves, brilliant light " +
    "on the fabric, glowing bounce up off the pale stone into the shadows of the face.\n" +
    "GRADE: luminous and elemental. Bone-white and cream stone, deep saturated blue sky, warm skin. " +
    "High-key brightness with rich shadow accents - marble goddess in the desert." },

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

  b_creamcabin: { label: "Cream Cabin", body:
    "FRAME: lounging deep in the tan leather back seat of a vintage car, one arm raised gripping " +
    "the roof handle, legs drawn up across the seat, head tilted with a level unbothered gaze - " +
    "half-body, intimate, shot from the opposite seat.\n" +
    "LOCATION: a classic car's rear cabin - caramel perforated leather bench and door cards, a " +
    "cream ribbed headliner, chrome window frames, soft pale daylight through every window.\n" +
    "LIGHT: soft, even, wrapping daylight through the glass all around - a bright creamy key from " +
    "the windows, gentle bounce off the pale headliner, glittering pinpoints wherever fabric or " +
    "jewellery catches it.\n" +
    "GRADE: warm and creamy with sparkle. Caramel leather, ivory headliner, soft daylight skin, " +
    "deep glinting darks in the clothing. Gentle contrast, luxurious calm - a quiet superstar " +
    "moment between takes." },
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
