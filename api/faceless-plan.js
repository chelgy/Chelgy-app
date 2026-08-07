// api/faceless-plan.js — the planner behind the Faceless Video maker.
//
// TWO VERBS, ONE ENDPOINT, the convention this app already follows.
//
//   POST { action:"script", topic, seconds, voice }   -> { script, title, look }
//   POST { action:"shots",  script, words, look, .. } -> { sources, timeline }
//
// WHY IT IS TWO STEPS AND NOT ONE
// The script is the product. Everything downstream — the voiceover, fifty images, a
// five-minute render — is generated FROM it and costs real money, so it gets read and
// edited by a person before any of that starts. Generating images against a script
// nobody has read is how you pay for a video you delete.
//
// WHY THE SHOTS STEP NEEDS THE WORD TIMINGS
// A still image has no natural length. The shot boundaries have to come from the
// voiceover, which means the running order is:
//
//     script  ->  voiceover  ->  transcribe  ->  time the shots  ->  images  ->  assemble
//
// Not the obvious order. Choosing shot lengths first and generating a voiceover to fit
// them cannot work — speech runs at the speed it runs at. And the assembler mixes to
// the SHORTEST stream, so a timeline that overruns the voiceover silently loses its
// last images with no error anywhere. Measured that on an eleven-second plan against a
// ten-second voiceover: the final shot simply was not there.
//
// Env: ANTHROPIC_API_KEY, GEMINI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY

export const maxDuration = 120;

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const CLAUDE_MODEL = (process.env.PLANNER_MODEL || "claude-opus-4-8").trim();

// Speech runs at about 150 words a minute for narration — slower than conversation,
// which is what makes it listenable. Used only to ask for roughly the right LENGTH of
// script; the real timing always comes from the transcript afterwards.
const WORDS_PER_MINUTE = 150;

// How long one image holds the screen. Under three seconds and a five-minute video
// needs a hundred images and reads as a slideshow on fast-forward; over about seven
// and a still starts to feel frozen however slowly it drifts.
// MUST match FPS in commercial.js. Shot boundaries are quantised to this, and a
// mismatch reintroduces exactly the drift the quantising exists to remove.
const OUT_FPS = 30;
const qf = (t) => Math.round(t * OUT_FPS) / OUT_FPS;

const SHOT_MIN = 3.5;
const SHOT_MAX = 6.5;
const SHOT_TARGET = 5.0;

const LENGTHS = { 60: "60 seconds", 120: "2 minutes", 300: "5 minutes" };

// The visual world, as a set of choices rather than whatever the writer invents.
//
// Every one of these is CONCRETE — medium, palette, light — because that is what an
// image model can act on. "Cinematic" and "beautiful" are not styles, they are
// adjectives, and fifty images generated against an adjective do not match.
//
// The value is appended verbatim to every prompt in the film, including the character
// portraits, so a cartoon film casts a cartoon.
export const LOOK_PRESETS = {
  film:        "moody 35mm film photography, natural available light, muted earth tones, shallow depth of field, fine grain",
  luxury:      "high-end editorial photography, marble brass and linen, soft directional light, restrained palette of cream camel and black, generous negative space",
  documentary: "candid documentary photography, available light, natural skin tones, unposed, slight motion blur",
  cartoon:     "flat 2D vector illustration, bold clean outlines, limited flat palette, simple geometric shapes, no gradients, no texture",
  anime:       "anime cel illustration, clean confident linework, soft cel shading, expressive faces, painted skies",
  render3d:    "stylised 3D render, matte clay materials, soft global illumination, gentle rim light, muted pastel palette",
  retro:       "1970s magazine print, warm faded inks, visible halftone dots, slightly off-register colour",
  noir:        "high contrast black and white photography, hard single-source light, deep shadows, heavy grain",
};

const overloaded = (s) =>
  /overloaded|high demand|try again later|unavailable|resource[_ ]?exhausted|rate limit|quota/i
    .test(String(s || ""));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getUserId(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", {
      headers: { apikey: SB_ANON, Authorization: "Bearer " + token } });
    const u = await r.json();
    return r.ok && u && u.id ? u.id : null;
  } catch { return null; }
}

async function callClaude(AKEY, { system, content, maxTokens }) {
  let lastErr = "The writer is busy. Please try again in a moment.";
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": AKEY, "anthropic-version": "2023-06-01",
                   "Content-Type": "application/json" },
        // No temperature: Opus 4.8 deprecated it and rejects the request if present.
        body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens || 8000,
                               system, messages: [{ role: "user", content }] }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        lastErr = (d && d.error && d.error.message) || ("Model error " + r.status);
        if (r.status === 429 || r.status >= 500 || overloaded(lastErr)) {
          await sleep(1200 * (i + 1)); continue;
        }
        return { ok: false, error: lastErr };
      }
      const text = (Array.isArray(d.content) ? d.content : [])
        .map((b) => (b && b.type === "text" ? b.text : "")).join("");
      if (!text) { lastErr = "The writer returned nothing."; await sleep(1200 * (i + 1)); continue; }
      return { ok: true, text };
    } catch (e) {
      lastErr = (e && e.message) || "Network error contacting the writer.";
      await sleep(1200 * (i + 1));
    }
  }
  return { ok: false, error: lastErr };
}

// ── step 1: the script ──────────────────────────────────────────────────────

const SCRIPT_SYSTEM = `You write narration for faceless videos — the kind that hold
someone's attention for five minutes with nothing on screen but images and a voice.

WHAT MAKES THESE WORK, and most of them fail at all four:

The first sentence has to earn the second. Not "in this video we'll explore" — a claim,
a number, a question with a real answer coming. Someone decides in three seconds.

It is SPOKEN, not written. Short sentences. Contractions. One idea per sentence. Read
it aloud in your head; if you run out of breath, it is too long. No bullet points, no
headings, no "firstly" — nobody says firstly.

It goes somewhere. Each section should answer a question the last one raised, so the
listener is always mid-thought. A list of facts in any order is what a bad one sounds
like.

It is specific. Numbers, names, cases, dates. "Most restaurants fail" is filler.
"Sixty percent close inside their first year, and the reason is almost never the food"
is a video.

NEVER write: stage directions, speaker labels, timestamps, section headings, "[music]",
or anything that is not the words to be spoken. The entire output is read aloud by a
voice model exactly as written.`;

function scriptPrompt(topic, seconds, tone, chosenLook) {
  const words = Math.round((seconds / 60) * WORDS_PER_MINUTE);
  return `Write narration for a ${LENGTHS[seconds] || seconds + " second"} faceless video.

TOPIC: ${topic}

${tone ? "TONE: " + tone + "\n\n" : ""}Length: about ${words} words. That is a target, not a rule — being 10% out is fine,
being twice as long is not, because the video is cut to the voiceover and a script that
runs long produces a video that runs long.

Return ONLY valid JSON, no markdown fence, no preamble:

{
  "title": "<5 words max, the on-screen opening card. Not a sentence. Not clickbait.>",
  "look": ${chosenLook
    ? `"${chosenLook.replace(/"/g, "'")}"   <- USE THIS EXACTLY. It was chosen by the
            person making the film; do not improve it, do not extend it, do not
            substitute your own. Return it unchanged.>`
    : `"<ONE sentence describing the visual world of this video — medium, palette,
            lighting, era. Every image is generated with this appended, so it is the
            only thing holding fifty pictures together as one video. Be concrete:
            'moody 35mm film photography, muted earth tones, overcast natural light'
            beats 'cinematic and beautiful'.>"`},
  "script": "<the narration, plain text, paragraphs separated by blank lines>"
}`;
}

// ── step 2: shots timed to the voiceover ────────────────────────────────────

// Group the transcript into shots.
//
// Done in code, not by a model. Shot boundaries are arithmetic on timestamps — a model
// asked to do it returns times that drift from the transcript by a few hundred
// milliseconds and every image lands slightly off the sentence it belongs to. The
// model's job is the PICTURES; the clock is not a judgement call.
//
// Boundaries prefer the end of a sentence, then any word gap, then the target length,
// because cutting the image mid-clause is what makes a faceless video feel machine-made.
function groupIntoShots(words, total) {
  const w = (Array.isArray(words) ? words : [])
    .map((x) => ({
      w: String((x && (x.w || x.word || x.text)) || ""),
      s: Number(x && (x.s ?? x.start)) || 0,
      e: Number(x && (x.e ?? x.end)) || 0,
    }))
    .filter((x) => x.w && x.e > x.s)
    .sort((a, b) => a.s - b.s);
  if (!w.length) return [];

  const shots = [];
  let start = 0;
  let i = 0;
  while (i < w.length) {
    const target = start + SHOT_TARGET;
    let cut = null;

    // Look for a sentence end inside the acceptable window.
    for (let k = i; k < w.length; k++) {
      const t = w[k].e;
      if (t < start + SHOT_MIN) continue;
      if (t > start + SHOT_MAX) break;
      if (/[.!?]"?$/.test(w[k].w)) { cut = { t, k }; break; }
      if (!cut || Math.abs(t - target) < Math.abs(cut.t - target)) cut = { t, k };
    }
    // Nothing in the window — take the first word past the minimum rather than
    // running to the end of the video on one image.
    if (!cut) {
      for (let k = i; k < w.length; k++) {
        if (w[k].e >= start + SHOT_MIN) { cut = { t: w[k].e, k }; break; }
      }
    }
    if (!cut) break;

    // EVERY BOUNDARY LANDS ON A FRAME.
    //
    // Shot lengths come from word timings, which are arbitrary decimals — 5.383s is
    // 161.49 frames at 30fps, so ffmpeg rounds it, and the error accumulates down the
    // whole film while the voiceover keeps perfect time. Captions are sliced against
    // the planned times, so they drift off the picture: the same failure the music
    // video planner had, in a pipeline I never applied the fix to.
    //
    // Quantised here, at the source, so every duration is a whole number of frames and
    // there is nothing left to round.
    const cutT = qf(cut.t);
    const text = w.slice(i, cut.k + 1).map((x) => x.w).join(" ");
    shots.push({ start: qf(start), end: cutT, text });
    start = cutT;
    i = cut.k + 1;
  }

  // The tail. The pictures must reach the end of the narration — the assembler mixes
  // to the shortest stream, so stopping at the last word can clip the final syllable.
  if (shots.length) {
    shots[shots.length - 1].end = qf(Math.max(shots[shots.length - 1].end, total));
  }

  // NOW ENFORCE THE CEILING, and this is not cosmetic.
  //
  // Extending that last shot is what breaks it: on a 60-second script the tail came out
  // at 9.8 seconds, and commercial-route.js rejects any still held longer than 8 —
  // meaning the whole render is refused at submission, after the voiceover and every
  // image has already been paid for. A gap between two rules in two files, and the
  // expensive one fires last.
  //
  // Splitting rather than trimming, because trimming loses the end of the narration.
  // The halves share the shot's words, so both get a sensible picture prompt.
  const capped = [];
  for (const sh of shots) {
    const dur = sh.end - sh.start;
    if (dur <= SHOT_MAX + 0.001) { capped.push(sh); continue; }
    const parts = Math.ceil(dur / SHOT_MAX);
    const each = dur / parts;
    for (let k = 0; k < parts; k++) {
      capped.push({
        start: qf(sh.start + k * each),
        end: k === parts - 1 ? sh.end : qf(sh.start + (k + 1) * each),
        text: sh.text,
      });
    }
  }
  return capped.filter((s) => s.end > s.start + 0.5);
}

const round3 = (v) => Math.round(v * 1000) / 1000;

// ── THE BIBLE ───────────────────────────────────────────────────────────────
//
// WHY THIS STEP EXISTS, and skipping it is what made the first version a slideshow.
//
// Asking for one prompt per line gives you a reasonable picture of each line and a
// video that adds up to nothing. Reported from a real run: a script about two women
// building businesses came back as pottery, then cups, then a table, then a man and a
// woman — every image defensible on its own, no thread between the first and the last,
// and a different cast in every frame.
//
// Two things cause that and neither is fixed by writing better prompts.
//
// A script has RECURRING PEOPLE and the shot list does not know it. "A woman" invents
// a new woman every time she is asked for. So the cast is defined once, before any
// prompt is written, and the same exact sentence is pasted into every shot she is in —
// pasted, not paraphrased, because a reworded description is a different person.
//
// And a script has a THROUGH-LINE. If she is walking to the shop in shot four, shot
// five is the shop, not an unrelated still life. That only happens if whatever writes
// shot five can see shots one to four and knows where the story is going.
const BIBLE_SYSTEM = `You are the director of a short film told entirely in still images.

Before any shot is designed you decide two things: WHO is in this film, and WHAT
JOURNEY the pictures take.

CAST. Every person the script refers to more than once is a character. Describe each in
one dense sentence that could be handed to a stranger who has to draw them: apparent
age, build, hair, skin, clothing, and one specific thing that makes them recognisable
at a glance — a yellow apron, a shaved head, wire glasses. No names of real people. The
description gets copied verbatim into every shot they appear in, so it must be complete
and it must never need rewording.

PLACES. The same for any location that recurs. A workshop that changes character every
time it appears reads as a different workshop.

THE ARC. One short paragraph: where the pictures start, what changes in the middle,
where they end. This is a VISUAL journey, not a summary of the script. If the script
argues that shipping beats perfecting, the arc might run from a dim room with one
unfinished object, to a table of imperfect things going out of the door, to a lit shop
full of people. Concrete, physical, in order.`;

function biblePrompt(script, look, topic) {
  return `Here is the full narration for a film told in still images.

TOPIC: ${topic}

VISUAL WORLD: ${look}

SCRIPT:
${script}

Return ONLY valid JSON, no markdown fence:
{
  "characters": [
    {
      "id": "<short lowercase key, e.g. maker_a>",
      "name": "<what to call her in a prompt, e.g. the perfectionist>",
      "look": "<the one dense sentence, copied verbatim into every shot she is in>",
      "portrait": "<a prompt for a single reference portrait of this person alone,
                    plain background, waist up, neutral expression>"
    }
  ],
  "places": [ { "id": "...", "name": "...", "look": "<one sentence>" } ],
  "arc": "<one paragraph, the visual journey in order>"
}

Characters only for people who RECUR. A script with no recurring people returns an
empty array — do not invent a cast for a film about a city.`;
}

const IMAGE_SYSTEM = `You design the shots of a film told entirely in still images.

You are given the cast, the places, the arc, and every shot in order with the line of
narration it sits under. You write one image prompt per shot.

THIS IS ONE FILM, NOT A LIST OF PICTURES. Each shot follows the one before it. If she
picked up a box in shot six, shot seven is her carrying it, not an unrelated still. If
the arc moves from a dim room to a busy shop, the shots move that way too and the light
changes as they go. A viewer should be able to follow what is happening with the sound
off.

COPY THE CAST DESCRIPTIONS EXACTLY. When a character is in a shot, paste their "look"
sentence into the prompt word for word. Do not shorten it, do not reword it, do not
substitute a pronoun. A rewritten description generates a different person, and a film
whose lead changes face every eight seconds is worse than one with no people in it.

The same for places.

NO TEXT ANYWHERE IN THE IMAGE. No letters, numbers, words, signage, logos or captions.
Image models render text as garbled nonsense and it is the single thing that makes this
format look cheap. If the line is about a statistic, illustrate the subject.

THE CAMERA IS GIVEN TO YOU AND IS NOT A SUGGESTION. Every shot has a CAMERA line.
Write the prompt for THAT framing. If it says extreme close-up on hands, the image is
hands filling the frame — not a wide shot of a room with hands in it. This is what stops
a run of lines about one person in one room becoming the same picture eight times, and
it is the single thing most likely to make this film watchable.

DO NOT SIT IN ONE PLACE. If four consecutive shots are set somewhere, move: outside, a
different corner, a different time of day, a detail on a different surface. The
narration moving on is the cue for the pictures to move on.

Each prompt is one paragraph describing a single photographable moment.`;

// FRAMING IS ASSIGNED HERE, NOT REQUESTED.
//
// The system prompt asks for varied framing between neighbouring shots and the model
// agrees and then does not do it — because when nine consecutive lines are about the
// same woman in the same room, nine near-identical prompts are a reasonable reading of
// the brief. Measured on a real render: nine shots in a row of the same workshop from
// the same angle, thirty-six seconds of what looks like one still while the narration
// moved through five separate ideas.
//
// So the camera is decided in code and handed to the model as a requirement. A
// rotation cannot produce two neighbours the same, and it costs nothing — the model is
// still choosing WHAT is in the shot, only not whether to move.
//
// Ordered so consecutive entries differ in scale as well as position: a wide followed
// by a detail reads as a cut, a wide followed by another wide reads as a mistake.
const FRAMINGS = [
  "wide establishing shot, the whole space visible",
  "extreme close-up on hands and what they are doing",
  "medium shot from the side, waist up",
  "overhead looking straight down at the surface",
  "close-up on a face, shallow depth of field",
  "low angle looking up, the subject against the ceiling or sky",
  "detail shot of a single object, everything else out of focus",
  "over-the-shoulder, seeing what the subject sees",
  "wide shot from a doorway, the subject small in the frame",
  "tight two-shot, faces close together",
];

function imagePrompt(shots, bible, look, topic) {
  const cast = (bible.characters || [])
    .map((c) => `  ${c.id} — ${c.name}: ${c.look}`).join("\n") || "  (none)";
  const places = (bible.places || [])
    .map((p) => `  ${p.id} — ${p.name}: ${p.look}`).join("\n") || "  (none)";

  return `A film told in still images about: ${topic}

VISUAL WORLD (every shot is in this world):
${look}

THE ARC:
${bible.arc || ""}

CAST — paste these sentences verbatim when the character appears:
${cast}

PLACES:
${places}

THE SHOTS, in order, with the narration each one sits under:

${shots.map((s, i) => `${i + 1}. [${s.start.toFixed(1)}s] CAMERA: ${FRAMINGS[i % FRAMINGS.length]}\n   "${s.text}"`).join("\n")}

Return ONLY valid JSON, no markdown fence:
{"shots": [{"prompt": "<one paragraph>", "characters": ["<cast id>", ...]}, ...]}

Exactly ${shots.length} entries, in order. "characters" lists which cast ids appear in
that shot, and is an empty array for a shot with nobody in it.`;
}

function parseJson(text) {
  const clean = String(text || "").replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); } catch {}
  const m = clean.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// ── handler ─────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please sign in again." });

    const AKEY = (process.env.ANTHROPIC_API_KEY || "").trim();
    if (!AKEY) return res.status(500).json({ error: "The writer is not configured." });

    // ── write the script ──
    if (body.action === "script") {
      const topic = String(body.topic || "").trim().slice(0, 600);
      if (!topic) return res.status(400).json({ error: "What should the video be about?" });
      const seconds = [60, 120, 300].includes(Number(body.seconds)) ? Number(body.seconds) : 60;
      const tone = String(body.tone || "").trim().slice(0, 200);

      // A chosen look wins outright. Presets and free text arrive the same way — the
      // caller resolves the preset — so a person can type "shot on a disposable camera
      // at a wedding" and it is treated exactly like a built-in.
      const chosenLook = String(body.look || "").trim().slice(0, 400);

      const r = await callClaude(AKEY, {
        system: SCRIPT_SYSTEM,
        content: scriptPrompt(topic, seconds, tone, chosenLook),
        maxTokens: 4000,
      });
      if (!r.ok) return res.status(502).json({ error: r.error });

      const j = parseJson(r.text);
      if (!j || !j.script) return res.status(502).json({ error: "The writer returned something unreadable. Try again." });

      const script = String(j.script).trim();
      return res.status(200).json({
        title: String(j.title || "").trim().slice(0, 60),
        // The chosen look is returned as given rather than as the model echoed it back.
        // Asked to repeat a sentence verbatim a model will still tidy it, and a tidied
        // look is a different look applied to every image in the film.
        look: chosenLook || String(j.look || "").trim().slice(0, 400),
        script,
        // Shown on the button so nobody is surprised by a two-minute video they asked
        // to be thirty seconds.
        estimatedSeconds: Math.round((script.split(/\s+/).length / WORDS_PER_MINUTE) * 60),
      });
    }

    // ── time the shots and design them ──
    if (body.action === "shots") {
      const topic = String(body.topic || "").trim().slice(0, 600);
      const look = String(body.look || "").trim().slice(0, 400);
      const script = String(body.script || "").trim().slice(0, 20000);
      const words = Array.isArray(body.words) ? body.words : [];
      const total = Number(body.duration) || 0;
      if (!words.length) return res.status(400).json({ error: "No word timings — the voiceover hasn't been transcribed yet." });

      const shots = groupIntoShots(words, total);
      if (!shots.length) return res.status(400).json({ error: "Couldn't find any speech in that voiceover." });
      if (shots.length > 60) {
        return res.status(400).json({
          error: "That script is longer than five minutes of narration (" + shots.length +
                 " shots). Trim it and try again." });
      }

      // STEP ONE: who is in this, and where does it go.
      //
      // A failure here is not fatal — an empty bible gives the old behaviour, which is
      // a watchable if disconnected film, rather than no film at all.
      let bible = { characters: [], places: [], arc: "" };
      if (script) {
        const br = await callClaude(AKEY, {
          system: BIBLE_SYSTEM,
          content: biblePrompt(script, look, topic),
          maxTokens: 3000,
        });
        if (br.ok) {
          const bj = parseJson(br.text);
          if (bj && typeof bj === "object") {
            bible = {
              characters: (Array.isArray(bj.characters) ? bj.characters : [])
                .filter((c) => c && c.id && c.look)
                .slice(0, 6)     // past six recurring people nobody is following anyway
                .map((c) => ({
                  id: String(c.id).slice(0, 40),
                  name: String(c.name || c.id).slice(0, 60),
                  look: String(c.look).slice(0, 600),
                  // The look goes on the portrait too. Without it a cartoon film
                  // generates a photographic reference and then passes that photograph
                  // into every cartoon shot, which fights the style in every frame.
                  portrait: String(c.portrait || c.look).slice(0, 600) + (look ? " " + look : ""),
                })),
              places: (Array.isArray(bj.places) ? bj.places : []).slice(0, 6),
              arc: String(bj.arc || "").slice(0, 1500),
            };
          }
        }
      }

      // STEP TWO: the shots, designed against that.
      const r = await callClaude(AKEY, {
        system: IMAGE_SYSTEM,
        content: imagePrompt(shots, bible, look, topic),
        maxTokens: 16000,
      });
      if (!r.ok) return res.status(502).json({ error: r.error });

      const j = parseJson(r.text);
      const designed = (j && Array.isArray(j.shots)) ? j.shots : [];
      if (!designed.length) return res.status(502).json({ error: "Couldn't design the shots. Try again." });

      const byId = new Map(bible.characters.map((c) => [c.id, c]));

      const sources = shots.map((s, i) => {
        const d = designed[i] || {};
        let prompt = String(d.prompt || (s.text.slice(0, 180))).slice(0, 1400);
        // The cast sentence is appended here as well as being asked for in the prompt.
        // The model is told to paste it verbatim and mostly does; belt and braces costs
        // a few tokens and the failure it prevents is a lead who changes face.
        const ids = (Array.isArray(d.characters) ? d.characters : [])
          .map(String).filter((id) => byId.has(id)).slice(0, 3);
        for (const id of ids) {
          const c = byId.get(id);
          if (c && prompt.indexOf(c.look) === -1) prompt += " " + c.look;
        }
        return {
          id: "img" + i, kind: "image",
          prompt: prompt + (look ? " " + look : ""),
          characters: ids,
          url: null,
        };
      });

      const timeline = shots.map((s, i) => ({
        // Six decimals, not three. The boundaries are frame-exact; rounding the
        // duration to milliseconds throws that away for no reason, and it is the same
        // rounding that undid the fix once already in the music video planner.
        src: "img" + i, in: 0, out: Math.round((s.end - s.start) * 1e6) / 1e6,
        // Alternating in / out / in / still. Two neighbours never move the same way,
        // so even when consecutive images resemble each other they cannot read as one
        // shot whose zoom restarted.
        fx: i % 4 === 3 ? [] : (i % 2 === 0 ? ["push"] : ["pull"]),
        at: s.start, text: s.text,
      }));

      return res.status(200).json({
        sources, timeline,
        // Portraits are generated first and passed back as reference images for every
        // shot the character appears in. A written description holds a person together
        // about as well as a police sketch; a reference photo actually does it.
        characters: bible.characters.map((c) => ({ id: c.id, name: c.name, portrait: c.portrait })),
        arc: bible.arc,
        shots: shots.length,
        seconds: round3(shots[shots.length - 1].end),
      });
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    return res.status(500).json({ error: "Server error." });
  }
}
