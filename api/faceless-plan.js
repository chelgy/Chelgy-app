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
const SHOT_MIN = 3.5;
const SHOT_MAX = 6.5;
const SHOT_TARGET = 5.0;

const LENGTHS = { 60: "60 seconds", 120: "2 minutes", 300: "5 minutes" };

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

function scriptPrompt(topic, seconds, tone) {
  const words = Math.round((seconds / 60) * WORDS_PER_MINUTE);
  return `Write narration for a ${LENGTHS[seconds] || seconds + " second"} faceless video.

TOPIC: ${topic}

${tone ? "TONE: " + tone + "\n\n" : ""}Length: about ${words} words. That is a target, not a rule — being 10% out is fine,
being twice as long is not, because the video is cut to the voiceover and a script that
runs long produces a video that runs long.

Return ONLY valid JSON, no markdown fence, no preamble:

{
  "title": "<5 words max, the on-screen opening card. Not a sentence. Not clickbait.>",
  "look": "<ONE sentence describing the visual world of this video — medium, palette,
            lighting, era. Every image is generated with this appended, so it is the
            only thing holding fifty pictures together as one video. Be concrete:
            'moody 35mm film photography, muted earth tones, overcast natural light'
            beats 'cinematic and beautiful'.>",
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

    const text = w.slice(i, cut.k + 1).map((x) => x.w).join(" ");
    shots.push({ start: round3(start), end: round3(cut.t), text });
    start = cut.t;
    i = cut.k + 1;
  }

  // The tail. The pictures must reach the end of the narration — the assembler mixes
  // to the shortest stream, so stopping at the last word can clip the final syllable.
  if (shots.length) {
    shots[shots.length - 1].end = round3(Math.max(shots[shots.length - 1].end, total));
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
        start: round3(sh.start + k * each),
        end: round3(k === parts - 1 ? sh.end : sh.start + (k + 1) * each),
        text: sh.text,
      });
    }
  }
  return capped.filter((s) => s.end > s.start + 0.5);
}

const round3 = (v) => Math.round(v * 1000) / 1000;

const IMAGE_SYSTEM = `You write image prompts for a faceless video. One prompt per shot,
each illustrating what is being said at that moment.

RULES THAT MATTER MORE THAN THE WRITING:

No text, letters, numbers, words, signage, logos or captions anywhere in the image.
Image models render text as garbled nonsense and it is the single thing that makes a
faceless video look cheap. If a shot is about a statistic, illustrate the SUBJECT, not
the number.

No faces that need to be a specific person, and no recognisable public figures.

Illustrate, do not decorate. If the line is about a factory closing, show the factory —
not an abstract swirl of colour. The picture should make the line land harder.

Vary the framing across consecutive shots. Wide, then close, then overhead. Three
similar compositions in a row reads as one long shot with a stutter.

Each prompt is one sentence, concrete, describing a single photographable scene.`;

function imagePrompt(shots, look, topic) {
  return `A faceless video about: ${topic}

VISUAL WORLD (append this to every prompt, it is what holds the video together):
${look}

Write one image prompt per shot below, in order.

${shots.map((s, i) => `${i + 1}. [${s.start.toFixed(1)}s] ${s.text}`).join("\n")}

Return ONLY valid JSON, no markdown fence:
{"prompts": ["<shot 1>", "<shot 2>", ...]}

Exactly ${shots.length} prompts, in order.`;
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

      const r = await callClaude(AKEY, {
        system: SCRIPT_SYSTEM,
        content: scriptPrompt(topic, seconds, tone),
        maxTokens: 4000,
      });
      if (!r.ok) return res.status(502).json({ error: r.error });

      const j = parseJson(r.text);
      if (!j || !j.script) return res.status(502).json({ error: "The writer returned something unreadable. Try again." });

      const script = String(j.script).trim();
      return res.status(200).json({
        title: String(j.title || "").trim().slice(0, 60),
        look: String(j.look || "").trim().slice(0, 400),
        script,
        // Shown on the button so nobody is surprised by a two-minute video they asked
        // to be thirty seconds.
        estimatedSeconds: Math.round((script.split(/\s+/).length / WORDS_PER_MINUTE) * 60),
      });
    }

    // ── time the shots and write their pictures ──
    if (body.action === "shots") {
      const topic = String(body.topic || "").trim().slice(0, 600);
      const look = String(body.look || "").trim().slice(0, 400);
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

      const r = await callClaude(AKEY, {
        system: IMAGE_SYSTEM,
        content: imagePrompt(shots, look, topic),
        maxTokens: 8000,
      });
      if (!r.ok) return res.status(502).json({ error: r.error });

      const j = parseJson(r.text);
      const prompts = (j && Array.isArray(j.prompts)) ? j.prompts : [];
      if (!prompts.length) return res.status(502).json({ error: "Couldn't write the image prompts. Try again." });

      // A short list is padded from the shot's own words rather than dropping the
      // shot. A video missing its last four pictures is a broken video; a plainer
      // prompt is a plainer picture.
      const sources = shots.map((s, i) => ({
        id: "img" + i,
        kind: "image",
        prompt: String(prompts[i] || (s.text.slice(0, 180) + ". " + look)).slice(0, 900) +
                (look ? " " + look : ""),
        url: null,
      }));

      const timeline = shots.map((s, i) => ({
        src: "img" + i,
        in: 0,
        out: round3(s.end - s.start),
        // Alternating drift, so consecutive stills don't move identically. `push` is
        // the gentle 12% zoom; every fourth shot gets no move at all, which stops the
        // whole video breathing in unison.
        fx: i % 4 === 3 ? [] : ["push"],
        at: s.start,
        text: s.text,
      }));

      return res.status(200).json({
        sources, timeline,
        shots: shots.length,
        seconds: round3(shots[shots.length - 1].end),
      });
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    return res.status(500).json({ error: "Server error." });
  }
}
