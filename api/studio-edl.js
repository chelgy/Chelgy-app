// api/studio-edl.js
//
// EDL planner. Replaces studio-commercial.js.
//
// Takes a brief, returns a full edit decision list: sources to generate, and a
// timeline that references slices of those sources. The timeline is always much
// longer than the source list — that reuse is the entire point, and it is free.
//
// Costs nothing to call. Nothing is generated here.
//
// Gemini primary, GPT fallback. Override with EDL_ENGINE=openai.

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";
// MODELS, MATCHING api/studio-plan.js.
//
// This said gemini-2.5-pro, which Google has since closed to new users — a hard 404,
// not a capacity error. It sat harmless while GPT was primary and Gemini was a rarely
// hit fallback; making Gemini the default walked the whole pipeline onto a dead model.
//
// studio-plan.js was migrated off 2.5 already and these are the same two it uses. They
// are duplicated rather than shared because these are separate serverless functions —
// so if one is ever changed, CHANGE BOTH. A model name that only half the app knows
// about is the same drift that has bitten this repo all week.
const GEMINI_PRIMARY = process.env.GEMINI_MODEL || "gemini-flash-latest";
const GEMINI_FALLBACK = "gemini-3.1-flash-lite";

// ---------------------------------------------------------------------------
// Costs
//
// USD figures are the verified real Seedance costs per 15s from the pricing
// correction (480p $1.62, 720p $3.50, 1080p $10.00, 4K $16.20).
//
// CREDITS: 1080p and 4K are Chelsea's confirmed sell rates. 480p and 720p are
// DERIVED at the same margin as 1080p (2700 credits per USD) and should be
// checked against the live pricing table before this ships to customers.
// ---------------------------------------------------------------------------
const RES = {
  "480p":  { usdPerSec: 0.1080, creditsPerSec: 292  },  // derived — CONFIRM
  "720p":  { usdPerSec: 0.2333, creditsPerSec: 630  },  // derived — CONFIRM
  "1080p": { usdPerSec: 0.6667, creditsPerSec: 1800 },  // confirmed
  "4k":    { usdPerSec: 1.0800, creditsPerSec: 2800 },  // confirmed
};

const FX = new Set([
  "motionBlur", "rgbSplit", "zoomBlur", "whip", "speedRamp",
  "filmBurn", "doubleExpose", "ghost", "dutch", "push", "flash",
]);

const MAX_SOURCES = 15;
const MAX_TIMELINE = 120;
const CLIP_SECONDS = 4; // Seedance sweet spot

// ---------------------------------------------------------------------------

const SYSTEM = `You plan short-form video commercials as edit decision lists.

You do not write clips that get played end to end. You write a small set of
generated SOURCES, then a much longer TIMELINE that cuts between slices of them.
A 30 second commercial is typically 8-12 sources and 30-45 timeline entries.
Most sources appear three or four times, at different in/out points and
different crops, with different captions over them. That reuse is what makes
the edit feel dense and expensive. It is not a shortcut.

THE THROUGHLINE
Every commercial is a series of DIFFERENT settings and situations telling ONE
story. The settings should vary a lot — different locations, different scales,
different subjects. What holds it together is the narrative and, often, a
repeating visual idea that survives the change of setting.

Two worked examples of the form:

  A betting brand's anti-cyberbullying film. Eight different sports: track,
  soccer, pool, basketball, handball, volleyball, rugby, tennis. Every one is
  a completely different surface, crowd and motion. The connective tissue is
  a white boundary line held near the centre of frame, which at the end becomes
  a blinking text cursor typing abuse at the athletes.

  A tutorial ad. A runner in Manhattan, an extreme macro of a shoe striking
  asphalt, a wrist, a lone swimmer in open ocean, a watch half underwater.
  Nothing alike. The connective tissue is the voiceover and the escalating
  claim.

So: vary the settings hard. Find one idea that carries across them.

STRUCTURE — FOUR ACTS, IN THIS ORDER, EVERY TIME
This is not a suggestion. The reference film is 33 seconds and splits almost
exactly like this, and the proportions are what make it feel produced rather
than assembled. Scale them to the duration you are given.

  ACT 1 — THE MONTAGE          ~50% of the running time
    The same idea repeated across completely different settings. Eight shots in
    the reference: track, soccer, pool, basketball, handball, volleyball, rugby,
    tennis. Every one a different surface, crowd and motion; the anchor holds
    dead centre through all of them.
    Shots run 1.0 to 2.5 seconds. HARD CUTS ONLY — no dissolves, no fades.
    ACCELERATE toward the end: the reference runs 2.3, 2.3, 2.5, 2.3, then 1.5,
    1.1, 1.7, and holds the last at 2.5. Getting faster is what builds pressure.
    THE LAST SHOT OF THIS ACT ENDS WITH SOMETHING CROSSING THE LENS — a ball, a
    hand, a body — filling frame and blacking it out. Write that into the scene
    prompt. It is what hides the cut into Act 2 and it costs nothing.

  ACT 2 — THE PIVOT            ~10%, and never more than 3 seconds
    One or two entries where the idea TRANSFORMS into something else. In the
    reference the sports line becomes a typing cursor. This is the whole point of
    the film and it is very short. Do not linger.

  ACT 3 — THE PAYOFF           ~25%
    The transformed idea plays out and the message lands. Slower than Act 1 —
    longer holds, fewer cuts. The audience has to read something here.

  ACT 4 — THE END CARD         ~15%, ALWAYS PRESENT
    At least one timeline entry with a "card": the brand line, then the message.
    The reference gives this six seconds of a thirty-three second film. A
    commercial that stops without a card is not a commercial.

Every act is mandatory. If the brief does not obviously suit a transformation,
find one — a change of scale, of place, of time of day, of who is holding the
thing. The turn is what separates an ad from a montage.

THE LOCKED LOOK — THE RULE THAT MAKES OR BREAKS THIS
The connective idea must exist IN THE FRAMES, not just in the story. This is the
single most common way these plans fail: the throughline is written as a sentence,
every source is then described with its own camera, lens and lighting, and the
finished ad looks like eight unrelated clips with one caption track over them.

So you must also return a LOOK: one camera specification and one visual anchor that
EVERY source shares. The anti-cyberbullying film works because the camera sits a few
centimetres off the ground with an ultra-wide lens, centred on a white boundary line,
in EVERY sport — the surface changes from track to grass to water to hardwood to clay
while the line barely moves. That is why the cuts read as one continuous idea.

  look.grade — the photographic quality every shot shares. A STILL is generated from
    this first and then animated, so write it as you would brief a photographer:
    stock or sensor, light quality, contrast, colour. Real and cinematic, never
    illustrated or rendered.
    e.g. "shot on 35mm, natural stadium floodlight, deep contrast, rich saturated
    colour, fine film grain, photographic realism"

  look.camera — height, angle, lens, composition. Identical in every shot.
    e.g. "camera a few centimetres off the ground, ultra-wide lens, one-point
    perspective, subject approaching the lens head-on, shallow foreground focus"

  look.anchor — the element held in the same screen position throughout.
    e.g. "a bright white boundary line running from bottom centre to the vanishing
    point, held dead centre"

Write each source's scene as SETTING, SUBJECT and ACTION only. Do not restate the
camera — it is appended to every source automatically, so anything you write about
framing will fight it.

Pick an anchor that can genuinely survive a change of setting: a line, a horizon, a
doorway, a colour, a repeated object, a hand entering frame from the same side. If you
cannot name one that works across all your settings, change the settings.

THE VOICEOVER MUST FILL THE AD
A script is not a tagline. Write to LENGTH, and count the words before you return it.

  Spoken advertising runs at roughly 2.5 words per second. So:
    15 seconds  ->  about 35-40 words
    30 seconds  ->  about 70-80 words
    60 seconds  ->  about 145-160 words

A 30 second ad with a 30 word script leaves eighteen seconds of silence, and the
person recording it finds out only after they have paid for the footage. Err LONG
rather than short — a read that slightly overruns can be trimmed, a short one cannot
be stretched.

Write it as continuous spoken sentences that carry across the whole film, not a list
of slogans. Slogans are what a short script collapses into, and they are why it stops
early: three lines and a brand name is fifteen words and eight seconds.

SOUND
Return up to SIX sound effects and one line of ambience.

  sfx[].at    — the second in the FINISHED AD where the sound lands. You are writing
                the timeline, so you already know when every shot starts; add up the
                entries before it. This is not the source footage's clock.
  sfx[].sound — what the sound IS, in five words or fewer. "boot striking wet grass",
                "ball hitting a hardwood floor", "a single keyboard key". Describe the
                SOUND, never the picture.
  ambience    — the space the ad lives in, as one continuous bed. "packed stadium
                crowd", "empty room tone". Empty string if it has no sense of place.

Put them on IMPACTS — the moment something is struck, lands, or arrives. That is what
sound design is: the picture already shows the movement, the sound confirms it. Do not
put one on every cut; a handful across the whole ad is what makes the rest feel real.

The anti-cyberbullying film does something worth copying here: the sport half is loud
and physical, and the digital half is unnaturally quiet. If your ad has a pivot, let
the sound change with it rather than running the same bed throughout.

CUTTING
Default to hard cuts. Effects are seasoning, not structure. A commercial with
zero effects and good cutting beats one with an effect on every shot.
Shot lengths: 0.2-0.8s for fast montage passages, 1.5-3s where something needs
to land or a person is speaking. Vary it — even pacing reads as a slideshow.

WHAT YOU DO NOT WRITE
Caption timings. The voiceover is spoken by a TTS engine that returns word
timings, and captions are built from those automatically. You only list which
words deserve emphasis.

Return ONLY a JSON object. No markdown, no prose, no code fences.`;

function schemaBlock(duration, aspect, hasRefs) {
  return `Return exactly this shape:

{
  "rationale": "one sentence naming the idea that connects the settings",
  "throughline": "the story in one sentence",
  "ambience": "one short description of the room tone under the whole ad, or empty",
  "sfx": [{"at": number, "sound": "short description of the sound"}],
  "look": {
    "camera": "the ONE camera spec every source shares — height, angle, lens, composition",
    "anchor": "the ONE visual element held in the same screen position in every source",
    "grade": "the ONE photographic quality every source shares — stock, light, contrast, colour"
  },
  "vo": {
    "script": "the full voiceover, spoken as one continuous read",
    "emphasis": ["words", "that", "get", "oversized", "treatment"]
  },
  "music": {
    "bpm": 120,
    "brief": "one line describing the track to generate, including where it drops out or lifts"
  },
  "sources": [
    {
      "id": "s1",
      "seconds": ${CLIP_SECONDS},
      "scene": "SETTING, SUBJECT and ACTION only — no camera, no lens, no framing. The shared look is appended for you.",
      "useRefs": ${hasRefs ? "true or false — true only where the product must actually appear" : "false"}
    }
  ],
  "timeline": [
    { "src": "s1", "in": 0.0, "out": 1.4, "crop": null, "speed": 1.0, "fx": [] },
    { "src": "s1", "in": 2.2, "out": 2.6, "crop": { "x": 0.3, "y": 0.4, "w": 0.35, "h": 0.35 }, "speed": 1.0, "fx": ["motionBlur"] },
    { "card": { "text": "first", "bg": "#E8352B", "fg": "#FAF7F0", "flash": true }, "dur": 0.35 }
  ],
  "endCard": {
    "lines": ["closing message", "optional second line"],
    "hold": 2.5
  }
}

RULES
- Target ${duration} seconds total.

  DURATION IS COMPUTED AS: for each source entry, (out - in) / speed. For each
  card entry, its "dur". Sum all of them.

  Note what "speed" does. A slice from 1.0 to 1.75 played at speed 1.35 does NOT
  run for 0.75 seconds. It runs for 0.75 / 1.35 = 0.56 seconds. Speeding a shot
  up makes it SHORTER. Slowing it down makes it LONGER.

  You will need roughly ${Math.round(duration / 0.75)} timeline entries to fill
  ${duration} seconds. Keep a running total as you write. If you have written
  ${Math.round(duration / 0.75)} entries and the total is still well under
  ${duration}, keep going — do not stop at an entry count that feels finished.
  Add it up before you return, and adjust until it lands within a second of
  ${duration}.

- Aspect is ${aspect}. Write scenes that compose for it.
- Every "src" must match a source "id". "in" and "out" are seconds within that
  source, 0 to ${CLIP_SECONDS}, and "out" must exceed "in".
- "crop" is fractions of the source frame, 0 to 1, x+w and y+h each at most 1.
  Use it constantly. Cropping a wide shot into a macro insert costs nothing and
  is the main way one generation becomes four shots.
- Reuse sources deliberately. If a source appears only once, ask whether it
  earns its cost.
- Cards have no "src". Use them for full-screen typography beats. Keep them
  short, 0.3-0.6s, except a final one.
- Allowed fx: ${[...FX].join(", ")}. Leave "fx" empty on at least two thirds of
  entries. Effects are punctuation. A clean cut reads as confident; an effect on
  every shot reads as a template.
- "speed" between 0.25 and 3.
- At most ${MAX_SOURCES} sources.`;
}

function userBrief(b) {
  const L = [];
  L.push(`SUBJECT: ${b.subject}`);
  if (b.message) L.push(`MESSAGE TO LAND: ${b.message}`);
  if (b.tone) L.push(`TONE: ${b.tone}`);
  L.push(`DURATION: ${b.duration} seconds`);
  L.push(`ASPECT: ${b.aspect}`);
  if (b.refs?.length) {
    L.push(`PRODUCT REFERENCES: ${b.refs.length} image(s) supplied. The product must appear accurately in at least three sources.`);
  }
  if (b.notes) L.push(`ADDITIONAL NOTES: ${b.notes}`);
  return L.join("\n");
}

function revisionBrief(prior, revision) {
  return `Here is an EDL you produced earlier:

${JSON.stringify(prior, null, 2)}

Revise it according to this instruction:

${revision}

Change only what the instruction asks for. Everything the instruction does not
mention must survive unchanged — same source ids, same scenes, same timeline
entries, same voiceover wording. Return the complete revised EDL in the same
shape.`;
}

function durationBrief(edl, actual, target) {
  const dir = actual < target ? "TOO SHORT" : "TOO LONG";
  const delta = Math.abs(round(target - actual));
  return `This EDL is ${dir}. Its timeline runs ${round(actual)} seconds against a
${target} second target — ${delta} seconds ${actual < target ? "short" : "over"}.

${JSON.stringify(edl, null, 2)}

Fix ONLY the timeline length. ${
    actual < target
      ? `Add roughly ${Math.ceil(delta / 0.75)} more entries. Draw them from the sources that
already exist — new in/out points, new crops. Do not add sources. Spread the new
entries through the edit rather than piling them at the end.`
      : `Remove or shorten entries. Cut the weakest repeats first.`
  }

Remember: a source entry lasts (out - in) / speed seconds, and a card lasts its
"dur". Sum them and check before returning.

Keep the sources, the voiceover, the music, the cards and the end card exactly as
they are. Return the complete EDL in the same shape.`;
}

// ---------------------------------------------------------------------------
// Model calls
// ---------------------------------------------------------------------------

async function callOpenAI(system, user) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY missing");

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.9,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!r.ok) throw new Error(`openai ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const txt = j.choices?.[0]?.message?.content;
  if (!txt) throw new Error("openai returned no content");
  return txt;
}

async function callGemini(system, user) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY missing");

  // Two tries on the primary, then the fallback. Capacity errors are transient and
  // worth retrying; a 404 for a retired model is not, so that drops through to the
  // fallback immediately rather than waiting twice for an answer that cannot come.
  const models = [GEMINI_PRIMARY, GEMINI_PRIMARY, GEMINI_FALLBACK];
  let lastErr = "The planner is busy. Please try again in a moment.";
  for (let attempt = 0; attempt < models.length; attempt++) {
    const model = models[attempt];
    const out = await callGeminiOnce(model, key, system, user).catch((e) => ({ ok: false, error: (e && e.message) || "network error" }));
    if (out.ok) return out.text;
    lastErr = out.error;
    const retryable = /overloaded|high demand|try again later|unavailable|resource[_ ]?exhausted|rate limit|quota|50\d/i.test(String(lastErr));
    const gone = /no longer available|not_found|NOT_FOUND|404/i.test(String(lastErr));
    if (gone) {
      console.warn("[edl] model " + model + " is retired — moving to the fallback");
      attempt = models.length - 2;   // skip the remaining primary tries
      continue;
    }
    if (!retryable) break;
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  throw new Error(lastErr);
}

async function callGeminiOnce(model, key, system, user) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          temperature: 0.9,
          responseMimeType: "application/json",
        },
      }),
    }
  );

  // Returns a RESULT rather than throwing, so the wrapper above can read the message
  // and decide whether it is worth another attempt. The 404 for a retired model and a
  // 503 for a busy one need opposite responses, and both arrive here as failures.
  if (!r.ok) {
    return { ok: false, error: `gemini ${r.status}: ${(await r.text()).slice(0, 300)}` };
  }
  const j = await r.json().catch(() => ({}));
  const txt = j.candidates?.[0]?.content?.parts?.map((p) => p.text).join("");
  if (!txt) return { ok: false, error: "gemini returned no content" };
  return { ok: true, text: txt };
}

function parseJson(txt) {
  const clean = String(txt).replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  return JSON.parse(clean);
}

// ---------------------------------------------------------------------------
// Validation and repair
//
// The model gets structure right and arithmetic wrong. Repair what is cheap to
// repair, reject what is not, and never let a bad reference reach the renderer.
// ---------------------------------------------------------------------------

function validate(edl, opts) {
  const warnings = [];
  opts = { ...opts, res: normRes(opts.res) };

  if (!edl || typeof edl !== "object") throw new Error("planner returned a non-object");
  if (!Array.isArray(edl.sources) || !edl.sources.length) throw new Error("no sources");
  if (!Array.isArray(edl.timeline) || !edl.timeline.length) throw new Error("no timeline");

  // --- sources ---
  if (edl.sources.length > MAX_SOURCES) {
    edl.sources = edl.sources.slice(0, MAX_SOURCES);
    warnings.push(`trimmed to ${MAX_SOURCES} sources`);
  }

  // The shared look. A model that skips it gets a neutral default rather than a failed
  // plan — but the default is deliberately plain, because a bland consistent look still
  // beats twelve inconsistent good ones, and the warning says what happened.
  const look = {
    camera: String((edl.look && edl.look.camera) || "").trim(),
    anchor: String((edl.look && edl.look.anchor) || "").trim(),
    grade:  String((edl.look && edl.look.grade)  || "").trim(),
  };
  if (!look.grade) {
    // Plain, real, and the same everywhere. Generation models drift toward illustration
    // when nothing pins them down, and one illustrated shot among eight photographic
    // ones is far more obvious than eight consistently plain ones.
    look.grade = "photographic realism, natural light, cinematic contrast, fine film grain, no illustration or 3D render look";
    warnings.push("no shared photographic grade returned — used a neutral realistic default");
  }
  if (!look.camera) {
    look.camera = "consistent camera height and framing across every shot, single-point " +
                  "composition, subject centred, shallow foreground focus";
    warnings.push("no shared camera returned — used a neutral default, so the shots will match but plainly");
  }
  if (!look.anchor) {
    warnings.push("no visual anchor returned — the cuts will rely on the story alone to connect");
  }
  edl.look = look;

  // An end card is structural, not decoration, so its absence is worth saying out
  // loud. Not fatal — a commercial without one is still a rendered video — but it is
  // the most common thing to be missing and the easiest to fix by rewriting.
  if (!edl.timeline.some((e) => e && e.card && String(e.card.text || "").trim())) {
    warnings.push("no end card — the ad stops rather than ends; rewrite asking for a closing brand card");
  }

  // A script far shorter than the ad is the single most common thing to go wrong with
  // the voice, and it is invisible until the take is recorded. Say so at plan time,
  // when a rewrite is still free.
  {
    const words = String((edl.vo && edl.vo.script) || "").trim().split(/\s+/).filter(Boolean).length;
    const total = Number(edl.totalSeconds) || 0;
    if (words && total) {
      const expected = total * 2.5;
      if (words < expected * 0.65) {
        warnings.push("the voiceover is only about " + Math.round(words / 2.5) + "s of speech against a " +
                      Math.round(total) + "s ad — rewrite asking for a fuller script");
      }
    }
  }

  // Sound. Times are already on the finished ad's clock — the planner writes the
  // timeline, so unlike the video editor there is no remapping to do. Clamped to the
  // ad's actual length, spaced, and capped.
  {
    const total = Number(edl.totalSeconds) || 0;
    const seenAt = [];
    edl.sfx = (Array.isArray(edl.sfx) ? edl.sfx : [])
      .map((x) => ({ at: Number(x && x.at), sound: String((x && x.sound) || "").trim().slice(0, 60) }))
      .filter((x) => Number.isFinite(x.at) && x.at >= 0 && (!total || x.at <= total) && x.sound.length > 2)
      .sort((a, b) => a.at - b.at)
      .filter((x) => {
        if (seenAt.some((t) => Math.abs(t - x.at) < 0.4)) return false;
        seenAt.push(x.at);
        return true;
      })
      .slice(0, 6);
    edl.ambience = String(edl.ambience || "").trim().slice(0, 80);
  }

  const seen = new Set();
  edl.sources = edl.sources.map((s, i) => {
    let id = String(s.id || `s${i + 1}`);
    while (seen.has(id)) id = `${id}_`;
    seen.add(id);
    const seconds = Math.min(CLIP_SECONDS, Math.max(1, Number(s.seconds) || CLIP_SECONDS));
    if (!s.scene || String(s.scene).trim().length < 20) {
      throw new Error(`source ${id} has no usable scene prompt`);
    }
    // THE LOOK IS APPENDED HERE, not asked for per source.
    //
    // Instructing a model to "keep the camera consistent" across a dozen independently
    // written prompts does not survive contact with a dozen independently written
    // prompts. Appending one spec to all of them does, and it costs nothing. If the
    // model ignores the instruction and writes its own framing anyway, the appended
    // spec still lands last, which is where generation models weight it most.
    const scene = [
      String(s.scene).trim().replace(/[.\s]+$/, ""),
      look.camera,
      look.anchor ? ("held throughout: " + look.anchor) : null,
      look.grade,
    ].filter(Boolean).join(". ") + ".";
    return {
      id,
      engine: "seedance",
      res: opts.res,
      seconds,
      scene,
      useRefs: !!s.useRefs && !!opts.refs?.length,
      refs: s.useRefs && opts.refs?.length ? opts.refs : [],
    };
  });

  const byId = new Map(edl.sources.map((s) => [s.id, s]));

  // --- timeline ---
  const out = [];
  for (const e of edl.timeline) {
    if (out.length >= MAX_TIMELINE) { warnings.push(`timeline capped at ${MAX_TIMELINE}`); break; }

    // card entry
    if (e && e.card && !e.src) {
      const text = String(e.card.text ?? "").trim();
      if (!text) continue;
      out.push({
        src: null,
        card: {
          text,
          bg: /^#[0-9a-f]{6}$/i.test(e.card.bg || "") ? e.card.bg : "#E8352B",
          fg: /^#[0-9a-f]{6}$/i.test(e.card.fg || "") ? e.card.fg : "#FAF7F0",
          flash: !!e.card.flash,
        },
        dur: Math.min(3, Math.max(0.15, Number(e.dur) || 0.4)),
      });
      continue;
    }

    // source slice
    const s = byId.get(String(e?.src));
    if (!s) { warnings.push(`dropped entry with unknown src "${e?.src}"`); continue; }

    let i0 = Math.max(0, Number(e.in) || 0);
    let i1 = Number(e.out);
    if (!Number.isFinite(i1) || i1 <= i0) i1 = i0 + 0.5;
    i1 = Math.min(s.seconds, i1);
    if (i1 - i0 < 0.12) {
      i0 = Math.max(0, Math.min(i0, s.seconds - 0.12));
      i1 = i0 + 0.12;
    }

    let crop = null;
    if (e.crop && typeof e.crop === "object") {
      const c = {
        x: Math.min(0.95, Math.max(0, Number(e.crop.x) || 0)),
        y: Math.min(0.95, Math.max(0, Number(e.crop.y) || 0)),
        w: Math.min(1, Math.max(0.05, Number(e.crop.w) || 1)),
        h: Math.min(1, Math.max(0.05, Number(e.crop.h) || 1)),
      };
      if (c.x + c.w > 1) c.w = 1 - c.x;
      if (c.y + c.h > 1) c.h = 1 - c.y;
      for (const k of ["x", "y", "w", "h"]) c[k] = Math.round(c[k] * 1000) / 1000;
      if (c.w < 0.999 || c.h < 0.999) crop = c;
    }

    const fx = Array.isArray(e.fx) ? e.fx.filter((f) => FX.has(f)) : [];
    const dropped = (Array.isArray(e.fx) ? e.fx.length : 0) - fx.length;
    if (dropped > 0) warnings.push(`dropped ${dropped} unknown fx`);

    out.push({
      src: s.id,
      in: round(i0),
      out: round(i1),
      crop,
      speed: Math.min(3, Math.max(0.25, Number(e.speed) || 1)),
      fx,
    });
  }

  if (!out.length) throw new Error("timeline empty after validation");
  edl.timeline = out;

  // --- duration ---
  const total = out.reduce((a, e) => {
    return a + (e.src ? (e.out - e.in) / (e.speed || 1) : e.dur);
  }, 0);
  edl.totalSeconds = round(total);
  const drift = Math.abs(total - opts.duration) / opts.duration;
  if (drift > 0.1) {
    warnings.push(`timeline is ${edl.totalSeconds}s against a ${opts.duration}s target`);
  }

  // --- unused sources are pure waste ---
  const used = new Set(out.map((e) => e.src).filter(Boolean));
  const unused = edl.sources.filter((s) => !used.has(s.id));
  if (unused.length) {
    edl.sources = edl.sources.filter((s) => used.has(s.id));
    warnings.push(`removed ${unused.length} source(s) the timeline never used`);
  }

  // --- cost, computed here, never taken from the model ---
  const resKey = opts.res;
  const rate = RES[resKey];
  const genSeconds = edl.sources.reduce((a, s) => a + s.seconds, 0);
  edl.cost = {
    res: resKey,
    generatedSeconds: genSeconds,
    usd: round(genSeconds * rate.usdPerSec),
    credits: Math.ceil(genSeconds * rate.creditsPerSec),
    atRes: priceLadder(genSeconds),
  };

  // --- vo / music / end card ---
  edl.vo = {
    engine: "elevenlabs",
    voice: opts.voice || null,
    script: String(edl.vo?.script || "").trim(),
    emphasis: Array.isArray(edl.vo?.emphasis) ? edl.vo.emphasis.map(String).slice(0, 12) : [],
  };
  if (!edl.vo.script) warnings.push("no voiceover script — the edit will be music only");

  edl.music = {
    bpm: Math.min(200, Math.max(60, Number(edl.music?.bpm) || 120)),
    brief: String(edl.music?.brief || "").trim(),
    duckUnderVo: true,
  };

  edl.endCard = {
    lines: Array.isArray(edl.endCard?.lines) ? edl.endCard.lines.map(String).slice(0, 3) : [],
    hold: Math.min(5, Math.max(1, Number(edl.endCard?.hold) || 2.5)),
    logo: opts.logo || null,
  };

  // --- envelope ---
  edl.version = 1;
  edl.style = "commercial";
  edl.aspect = opts.aspect;
  edl.duration = opts.duration;
  edl.fontPack = opts.fontPack || "chelgy";
  edl.lut = opts.lut || null;
  edl.rationale = String(edl.rationale || "").trim();
  edl.throughline = String(edl.throughline || "").trim();
  edl.warnings = warnings;

  return edl;
}

const round = (n) => Math.round(n * 100) / 100;

// "4K", "1080P", "  720p " all resolve. Anything unrecognised falls back to 720p.
function normRes(v) {
  const k = String(v || "").trim().toLowerCase().replace(/\s/g, "");
  if (RES[k]) return k;
  if (k === "480" || k === "sd") return "480p";
  if (k === "720" || k === "hd") return "720p";
  if (k === "1080" || k === "fhd") return "1080p";
  if (k === "2160" || k === "2160p" || k === "uhd") return "4k";
  return "720p";
}

// What this exact plan would cost at every resolution, so the picker can show
// real prices for this ad rather than a generic rate card.
function priceLadder(generatedSeconds) {
  const out = {};
  for (const [k, r] of Object.entries(RES)) {
    out[k] = {
      usd: round(generatedSeconds * r.usdPerSec),
      credits: Math.ceil(generatedSeconds * r.creditsPerSec),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const b = req.body || {};

    const opts = {
      duration: [15, 30, 60].includes(Number(b.duration)) ? Number(b.duration) : 30,
      aspect: b.aspect === "16:9" ? "16:9" : "9:16",
      res: normRes(b.res),
      refs: Array.isArray(b.refs) ? b.refs.filter(Boolean).slice(0, 3) : [],
      logo: b.logo || null,
      voice: b.voice || null,
      fontPack: b.fontPack || "chelgy",
      lut: b.lut || null,
    };

    if (!b.revision && !String(b.subject || "").trim()) {
      return res.status(400).json({ error: "subject is required" });
    }

    const system = SYSTEM;
    const user = b.revision && b.priorEdl
      ? revisionBrief(b.priorEdl, String(b.revision))
      : `${userBrief({ ...b, ...opts })}\n\n${schemaBlock(opts.duration, opts.aspect, !!opts.refs.length)}`;

    // ENGINE IS CONFIGURABLE, and Gemini is the default.
    //
    // GPT was hardcoded first with no switch. In practice it writes scene descriptions
    // far more elaborate than this planner wants — the prompt asks for a shot list and
    // gets prose — and the elaboration is what makes the resulting edits read as
    // arbitrary. Gemini stays closer to the brief.
    //
    // EDL_ENGINE=openai puts it back. PLANNER_FALLBACK=off disables the second engine
    // entirely, the same knob studio-plan.js uses, so a failure is a clean error rather
    // than an edit silently planned by the engine you turned off.
    const preferred = (process.env.EDL_ENGINE || "gemini").trim().toLowerCase() === "openai"
      ? "openai" : "gemini";
    const fallbackOff = (process.env.PLANNER_FALLBACK || "").trim().toLowerCase() === "off";

    let raw, engine = preferred;
    try {
      raw = preferred === "gemini" ? await callGemini(system, user) : await callOpenAI(system, user);
    } catch (e1) {
      if (fallbackOff) throw e1;
      const other = preferred === "gemini" ? "openai" : "gemini";
      console.warn("[edl] " + preferred + " failed, falling back to " + other + ":", e1.message);
      engine = other;
      raw = other === "gemini" ? await callGemini(system, user) : await callOpenAI(system, user);
    }

    let parsed;
    try {
      parsed = parseJson(raw);
    } catch {
      // one retry against the other engine before giving up
      console.warn("[edl] unparseable JSON from", engine, "— retrying on the other engine");
      if (fallbackOff) throw new Error(engine + " returned unparseable JSON and fallback is off");
      raw = engine === "openai" ? await callGemini(system, user) : await callOpenAI(system, user);
      engine = engine === "openai" ? "gemini" : "openai";
      parsed = parseJson(raw);
    }

    let edl = validate(parsed, opts);

    // The model reliably under-fills the timeline because it does not account for
    // speed shortening a slice. One repair pass, no video spend either way.
    const drift = Math.abs(edl.totalSeconds - opts.duration) / opts.duration;
    if (drift > 0.12) {
      try {
        const fixRaw = engine === "openai"
          ? await callOpenAI(SYSTEM, durationBrief(edl, edl.totalSeconds, opts.duration))
          : await callGemini(SYSTEM, durationBrief(edl, edl.totalSeconds, opts.duration));
        const fixed = validate(parseJson(fixRaw), opts);
        const newDrift = Math.abs(fixed.totalSeconds - opts.duration) / opts.duration;
        if (newDrift < drift) {
          fixed.warnings.unshift(`length repaired: ${edl.totalSeconds}s -> ${fixed.totalSeconds}s`);
          edl = fixed;
        } else {
          edl.warnings.unshift(`length repair attempted and rejected (${fixed.totalSeconds}s was no better)`);
        }
      } catch (e) {
        console.warn("[edl] duration repair failed:", e.message);
        edl.warnings.unshift("length repair failed — timeline is off target");
      }
    }

    edl.plannedBy = engine;
    return res.status(200).json({ ok: true, edl });
  } catch (err) {
    console.error("[edl] failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
