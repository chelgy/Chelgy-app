// api/musicvideo-classify.js — is anything in this clip timed to the music?
//
// THE QUESTION THIS ANSWERS
// The cut planner needs to know, for every clip, whether its content is tied to a
// moment in the song. Three answers:
//
//   locked  a mouth is forming words, or an action lands on a specific lyric.
//           Plays at its true position in the song or not at all.
//   shift   moving to the music but not to any particular word — dancing, a head
//           nod, hair on the snare. May move, but only in whole bars.
//   free    nothing music-timed. Scenery, hands, objects, a still pose, the back of
//           someone's head. Goes anywhere on the grid.
//
// WHICH WAY TO ERR, AND WHY IT IS THE OPPOSITE OF THE ALIGNMENT RULE
//
// Alignment fails toward FREE: when we cannot tell where a clip sits in the song,
// there is nothing else to do with it.
//
// Vision fails toward LOCKED, and this is the part that is easy to get backwards.
// Calling a singing clip "free" gives the planner PERMISSION TO MOVE IT, and a moving
// mouth in the wrong place is the precise failure this entire tool exists to prevent.
// Calling a b-roll clip "locked" costs only flexibility — it still plays, just pinned
// to a position it was correctly aligned to anyway. One mistake ruins the video, the
// other makes it slightly less flexible. So uncertainty resolves upward here.
//
// WHY GEMINI AND NOT FACE DETECTION
// A face detector answers "is there a face", which is not the question. The question
// is whether what the face is DOING is tied to the audio, and a mouth mid-word looks
// very like a mouth mid-laugh to anything that only knows where eyes are. Standing up
// face-landmark infrastructure to answer it badly costs more than three frames through
// a model that already reads images.
//
// WHY THE BROWSER SENDS THE FRAMES
// captureVideoFrame() in App.jsx already pulls stills from an uploaded video with a
// canvas. Doing it there costs nothing, needs no ffmpeg in a serverless function, and
// the frames are already local — the alternative is uploading, downloading and
// decoding the same footage a second time to learn something the browser could have
// told us for free.
//
// Env: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY

const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();

const GEMINI_PRIMARY = "gemini-flash-latest";
const GEMINI_FALLBACK = "gemini-3.1-flash-lite";

// Caps. This endpoint spends money on someone else's API and takes an authenticated
// but otherwise unmetered request, so the ceiling is here rather than in the caller.
const MAX_CLIPS = 60;
const MAX_FRAMES_PER_CLIP = 3;
const CLIPS_PER_CALL = 5;      // 15 images a call — enough context, short enough to parse
const CONCURRENCY = 4;
const DEADLINE_MS = 15000;     // whole request, not per call — see the note in callGemini

const overloaded = (s) =>
  /overloaded|high demand|try again later|unavailable|resource[_ ]?exhausted|rate limit|quota/i
    .test(String(s || ""));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getUser(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", {
      headers: { apikey: SB_ANON, Authorization: "Bearer " + token },
    });
    const u = await r.json();
    return r.ok && u && u.id ? u : null;
  } catch { return null; }
}

// Same shape and same retry behaviour as studio-plan.js. Copied deliberately rather
// than shared: these are separate serverless functions and a shared module between
// them is a deploy-coupling nobody asked for.
async function callGemini(GKEY, payload, deadline) {
  const models = [GEMINI_PRIMARY, GEMINI_PRIMARY, GEMINI_PRIMARY, GEMINI_FALLBACK];
  let lastErr = "The classifier is busy. Please try again in a moment.";
  for (let i = 0; i < models.length; i++) {
    // THE BUDGET IS ENFORCED ON THE REQUEST, not just checked before it.
    //
    // Checking the clock only between attempts still allows an attempt to START one
    // second inside the budget and then run for five more — measured at 24s against a
    // 20s budget, which on a serverless function is a 504 and no answer at all. The
    // remaining time is therefore handed to the fetch as an abort signal, so the
    // ladder cannot outlive its budget no matter where it is when the clock runs out.
    const remaining = deadline - Date.now();
    if (remaining < 2000) return { ok: false, error: lastErr };
    try {
      const gr = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + models[i] + ":generateContent",
        { method: "POST",
          headers: { "x-goog-api-key": GKEY, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(remaining) });
      const gdata = await gr.json().catch(() => ({}));
      if (!gr.ok) {
        lastErr = (gdata && gdata.error && gdata.error.message) || ("Model error " + gr.status);
        if (gr.status === 503 || gr.status === 429 || gr.status >= 500 || overloaded(lastErr)) {
          await sleep(Math.min(1200 * (i + 1), Math.max(0, deadline - Date.now()))); continue;
        }
        return { ok: false, error: lastErr };
      }
      let text = "";
      try { text = gdata.candidates[0].content.parts[0].text; } catch {}
      if (!text || overloaded(text)) {
        lastErr = "The model is experiencing high demand.";
        await sleep(Math.min(1200 * (i + 1), Math.max(0, deadline - Date.now()))); continue;
      }
      return { ok: true, text };
    } catch (e) {
      lastErr = (e && e.message) || "Network error contacting the classifier.";
      if (Date.now() > deadline) return { ok: false, error: lastErr };
      await sleep(Math.min(1200 * (i + 1), Math.max(0, deadline - Date.now())));
    }
  }
  return { ok: false, error: lastErr };
}

const PROMPT = `You are looking at still frames from clips shot for a music video. The
song was playing out loud while every clip was filmed, so anything on camera may be
timed to the music: singing, dancing, acting out the lyrics, or nothing at all.

For EACH clip, decide which of three classes it belongs to.

"locked" — a person's mouth is visibly forming words, OR someone is acting out
something that would land on a specific moment of the song (throwing something,
pointing, a reaction). These frames only make sense at one exact moment of the track.

"shift" — someone is clearly moving TO the music, but not to any particular word:
dancing, bouncing, walking in rhythm, hair or clothing swinging, a head nod. The
motion is rhythmic but not tied to a lyric.

"free" — nothing that depends on the music. Scenery, buildings, hands doing something,
objects, food, a car, someone standing still, someone facing away, a static pose, a
closed mouth held throughout.

WHICH WAY TO GUESS WHEN YOU ARE NOT SURE, and this matters more than getting the
middle cases right: choose the HIGHER class. If a mouth might be open in speech,
choose "locked". If a person might be moving to a beat, choose "shift". A wrongly
locked clip costs nothing; a wrongly freed one will be placed at the wrong moment and
the video will look broken.

Return ONLY a JSON array, no preamble, no markdown:
[{"id":"<clip id>","klass":"locked|shift|free","singing":true|false,"note":"<six words max>"}]

One object per clip, in the order given.`;

function parseArray(text) {
  const clean = String(text || "").replace(/```json|```/g, "").trim();
  try {
    const v = JSON.parse(clean);
    return Array.isArray(v) ? v : null;
  } catch {}
  // Model wrapped it in an object, or added a stray line. Take the first array.
  const m = clean.match(/\[[\s\S]*\]/);
  if (m) { try { const v = JSON.parse(m[0]); return Array.isArray(v) ? v : null; } catch {} }
  return null;
}

const VALID = ["locked", "shift", "free"];

async function classifyBatch(GKEY, batch, deadline) {
  // Past the deadline there is no point asking — the request will be killed before
  // the answer lands. Safe defaults now beat a 504 and no answer at all.
  if (Date.now() > deadline) {
    return batch.map((c) => ({
      id: c.id, klass: "locked", singing: true, note: "timed out", fallback: true,
    }));
  }
  const parts = [{ text: PROMPT }];
  for (const c of batch) {
    parts.push({ text: "\n--- clip id: " + c.id + " ---" });
    for (const f of c.frames) {
      const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(String(f || ""));
      if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
    }
  }

  const r = await callGemini(GKEY, {
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseMimeType: "application/json",
      // Low, not zero. This is a judgement call with a right answer, not a creative
      // one, and the failure mode we care about is inconsistency between clips.
      temperature: 0.1,
      maxOutputTokens: 2048,
    },
  }, deadline);

  const byId = new Map();
  if (r.ok) {
    const arr = parseArray(r.text);
    if (arr) {
      for (const row of arr) {
        const id = String((row && row.id) || "");
        if (!id) continue;
        // Lower-cased first: the model returns "LOCKED" often enough that treating it
        // as an unknown class and falling back would fire on a correct answer.
        const raw = String((row && row.klass) || "").toLowerCase().trim();
        const klass = VALID.includes(raw) ? raw : "locked";
        byId.set(id, {
          klass,
          singing: row.singing === true || klass === "locked",
          note: String(row.note || "").slice(0, 60),
        });
      }
    }
  }

  // ANY clip the model didn't answer for comes back LOCKED, not free.
  //
  // A dropped clip, an unparseable response, an overloaded model — all of it lands
  // here, and all of it has to fail in the safe direction. Locked is the class that
  // cannot be moved, so an unclassified clip is pinned to the position alignment
  // found for it. If alignment ALSO failed, the worker demotes it to free anyway,
  // which is the correct end state for a clip we know nothing about.
  return batch.map((c) => ({
    id: c.id,
    ...(byId.get(c.id) || { klass: "locked", singing: true, note: "not classified", fallback: true }),
  }));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const token = (body.access_token ||
      (req.headers.authorization || "").replace(/^Bearer\s+/i, "")).trim();
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: "Please log in again." });

    const GKEY = (process.env.GEMINI_API_KEY || "").trim();
    if (!GKEY) return res.status(500).json({ error: "Classifier is not configured." });

    const clips = (Array.isArray(body.clips) ? body.clips : [])
      .slice(0, MAX_CLIPS)
      .map((c) => ({
        id: String((c && c.id) || "").slice(0, 80),
        frames: (Array.isArray(c && c.frames) ? c.frames : [])
          .filter((f) => typeof f === "string" && f.startsWith("data:image/"))
          .slice(0, MAX_FRAMES_PER_CLIP),
      }))
      .filter((c) => c.id);

    if (!clips.length) return res.status(400).json({ error: "No clips to look at." });

    // A clip whose frames never arrived is not sent to the model at all — there is
    // nothing to look at — and takes the same safe default as an unanswered one.
    const withFrames = clips.filter((c) => c.frames.length);
    const withoutFrames = clips.filter((c) => !c.frames.length).map((c) => ({
      id: c.id, klass: "locked", singing: true, note: "no frames", fallback: true,
    }));

    const batches = [];
    for (let i = 0; i < withFrames.length; i += CLIPS_PER_CALL) {
      batches.push(withFrames.slice(i, i + CLIPS_PER_CALL));
    }

    // A HARD OVERALL DEADLINE, because the retry ladder is generous by design.
    //
    // Three retries with backoff is twelve seconds for one batch that never succeeds,
    // and a big upload is several rounds of those. Measured against a stubbed model
    // that always 500s: thirty clips took twenty-four seconds, which on a serverless
    // function is a 504 — the caller gets nothing, not even the safe defaults this
    // whole file is built to produce. The budget is spent, then every remaining batch
    // returns its default immediately.
    const deadline = Date.now() + DEADLINE_MS;
    const results = [];
    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      const slice = batches.slice(i, i + CONCURRENCY);
      const done = await Promise.all(slice.map((b) => classifyBatch(GKEY, b, deadline)));
      for (const d of done) results.push(...d);
    }

    const all = [...results, ...withoutFrames];
    const counts = all.reduce((m, r) => { m[r.klass] = (m[r.klass] || 0) + 1; return m; }, {});
    const fellBack = all.filter((r) => r.fallback).length;

    return res.status(200).json({
      clips: all,
      counts,
      // Surfaced rather than swallowed. If half the clips fell back to the safe
      // default the edit will be stiff, and that has a cause worth showing.
      fellBack,
      ...(fellBack ? { notice: fellBack + " clip" + (fellBack > 1 ? "s" : "") +
        " couldn't be read, so they're pinned to their position in the song." } : {}),
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error." });
  }
}
