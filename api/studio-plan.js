// Chelgy AI Video Editor — STEP 2: plan the edit.
// Gemini reads the word-timestamped transcript and decides which segments to
// KEEP (cutting filler words, false starts, long dead air and rambling), plus
// writes a short on-screen title. Returns strict JSON the render step consumes.
// Credits are charged at the render step, not here.
//
// WHICH MODEL DECIDES THE CUT
// Claude plans the edit; Gemini is kept as an automatic fallback. Deciding what to
// keep and what to throw away is an editorial judgement made from a transcript and
// an activity track, and it is the single highest-leverage call in the whole tool —
// everything downstream just executes it faithfully.
//
// Gemini is NOT removed, for two reasons. If Claude is down or shedding load, the
// editor still works instead of failing outright. And if the planning gets worse
// rather than better, switching back is one environment variable rather than a
// revert.
//
// Set PLANNER_ENGINE=gemini in Vercel to go back. Nothing else changes: the prompt,
// the JSON contract and every sanitising rule below are shared, so the two engines
// are genuinely comparable rather than two different pipelines.
//
// PLANNER_FALLBACK=off pins the planner to PLANNER_ENGINE alone — without it, a
// failure on the chosen engine is retried on the other one.
// The response reports which engine actually planned the edit, so a fallback is
// visible rather than silent.
//
// Env: ANTHROPIC_API_KEY, GEMINI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY
//      optional: PLANNER_ENGINE ("claude" | "gemini"), PLANNER_MODEL

// 300s, up from 60. The planner now reads up to ~85 minutes of transcript, and a long
// read plus a long JSON answer can comfortably exceed a minute — at which point Vercel
// kills the function and the customer loses an edit they already waited through an
// upload and a transcription for. 300 is the Vercel Pro ceiling; on Hobby the maximum
// is 60 and the build will reject this, in which case put it back and lower WORD_LIMIT.
export const maxDuration = 300;

// This is a Pages Router API route, which defaults the request body to 1 MB. A
// long-form multi-clip edit sends the whole word-timestamped transcript plus up
// to MAX_FRAMES base64 stills, which clears 1 MB easily — and Next rejects the
// POST with a 413 BEFORE this handler runs, so the frame cap below never gets a
// chance to trim it. The frontend only sees "couldn't reach the edit planner".
// 4.5 MB is Vercel's platform ceiling for a serverless request body; we can't go
// higher. If an edit ever exceeds it, the fix is to stop inlining frames as
// base64 and hand the planner storage URLs instead — not a bigger number here.
export const config = { api: { bodyParser: { sizeLimit: "4.5mb" } } };

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();

async function getUserId(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, Authorization: "Bearer " + token } });
    const u = await r.json();
    return r.ok && u && u.id ? u.id : null;
  } catch { return null; }
}


// ── Resilient Gemini call: retries the primary model, and if it's shedding load
// (503/429, or an overloaded/high-demand message returned even inside a 200),
// automatically falls back to a stable pinned model so callers never see it.
const GEMINI_PRIMARY = "gemini-flash-latest";
const GEMINI_FALLBACK = "gemini-3.1-flash-lite"; // stable Gemini 3, low-demand safety net (longer runway than 2.5)
const overloaded = (s) => /overloaded|high demand|try again later|unavailable|resource[_ ]?exhausted|rate limit|quota/i.test(String(s || ""));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callGemini(GKEY, payload) {
  const models = [GEMINI_PRIMARY, GEMINI_PRIMARY, GEMINI_PRIMARY, GEMINI_FALLBACK]; // 3 tries on primary, then fallback
  let lastErr = "The editor is busy. Please try again in a moment.";
  for (let i = 0; i < models.length; i++) {
    try {
      const gr = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + models[i] + ":generateContent",
        { method: "POST", headers: { "x-goog-api-key": GKEY, "Content-Type": "application/json" }, body: JSON.stringify(payload) }
      );
      const gdata = await gr.json().catch(() => ({}));
      if (!gr.ok) {
        lastErr = (gdata && gdata.error && gdata.error.message) || ("Model error " + gr.status);
        // Retryable server/capacity errors → wait and try next; hard errors → stop.
        if (gr.status === 503 || gr.status === 429 || gr.status >= 500 || overloaded(lastErr)) { await sleep(1200 * (i + 1)); continue; }
        return { ok: false, error: lastErr };
      }
      let text = "";
      try { text = gdata.candidates[0].content.parts[0].text; } catch {}
      // Model returned 200 but the *content* is a "high demand" apology, not real output.
      if (!text || overloaded(text)) { lastErr = "The model is experiencing high demand."; await sleep(1200 * (i + 1)); continue; }
      return { ok: true, text };
    } catch (e) {
      lastErr = (e && e.message) || "Network error contacting the editor.";
      await sleep(1200 * (i + 1));
    }
  }
  return { ok: false, error: lastErr };
}

// ── Claude, with the same retry behaviour ──
//
// Two differences from the Gemini call worth knowing about.
//
// There's no "respond only in JSON" switch, so the assistant turn is PREFILLED with
// an opening brace. The model can only continue from there, which makes a preamble
// like "Here's the plan:" structurally impossible rather than merely discouraged.
// The brace is added back before parsing.
//
// And max_tokens has to be generous. A long vlog can produce sixty or more keep
// segments plus cards and b-roll, and a truncated response is not a slightly shorter
// edit — it's unparseable JSON and a failed plan.
// Opus, deliberately, and it is the one place in this app where the most capable
// model is worth what it costs.
//
// Everything downstream executes this decision faithfully — the render server cuts
// exactly where it is told, the captions follow, the grade follows. A bad judgement
// here isn't a slightly worse video, it's eleven minutes of someone's footage
// returned as seventeen seconds. There is no second chance later in the pipeline to
// notice the edit was wrong.
//
// Against a 4,000-credit cinematic edit the difference in model cost is small, and
// it is spent on the only step that requires taste rather than execution.
//
// PLANNER_MODEL overrides this in Vercel without a deploy.
const CLAUDE_MODEL = (process.env.PLANNER_MODEL || "claude-opus-4-8").trim();

async function callClaude(AKEY, { system, content }) {
  let lastErr = "The editor is busy. Please try again in a moment.";
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": AKEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          // No temperature: Opus 4.8 deprecated it and rejects the request if present.
          model: CLAUDE_MODEL,
          max_tokens: 8000,
          system,
          messages: [
            { role: "user", content }
          ]
        })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        lastErr = (d && d.error && d.error.message) || ("Model error " + r.status);
        if (r.status === 429 || r.status >= 500 || overloaded(lastErr)) { await sleep(1200 * (i + 1)); continue; }
        return { ok: false, error: lastErr };
      }
      const text = (Array.isArray(d.content) ? d.content : [])
        .map((b) => (b && b.type === "text" ? b.text : "")).join("");
      if (!text) { lastErr = "The editor returned nothing."; await sleep(1200 * (i + 1)); continue; }
      return { ok: true, text };
    } catch (e) {
      lastErr = (e && e.message) || "Network error contacting the editor.";
      await sleep(1200 * (i + 1));
    }
  }
  return { ok: false, error: lastErr };
}

// ── The activity track, in a form a model can actually USE ───────────────────
//
// This used to be handed over as one comma-separated digit per second — six hundred
// of them for a ten-minute video, with no timestamps anywhere, prefixed only by
// "second 0 first". To act on it the model had to COUNT COMMAS to work out which
// second a value belonged to, which language models are famously unreliable at.
//
// Meanwhile every word in the transcript arrives with an exact start and end. So the
// only thing the planner could anchor a keep range to with any confidence was SPEECH
// — and silent footage (eating, walking, driving, showing something) fell out of
// every edit no matter how firmly the rules below insisted on keeping it. The rules
// were never the problem; they described a judgement the model had no way to locate
// in time.
//
// Run-length encoded into labelled spans, "keep 41-78s" becomes something it can read
// straight off a line instead of deducing. Same data, same measurement — addressable.
//
// -1 means UNMEASURED, not idle. See the note where it is emitted below.
function activitySpans(activity) {
  const raw = (Array.isArray(activity) ? activity : []).map((v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return -1;
    return n < 0 ? -1 : Math.min(9, Math.round(n));
  });
  if (!raw.length) return "";

  // Median-of-3 smoothing. One flickering second is measurement noise rather than a
  // change in what is happening, and without this the encoding shatters into hundreds
  // of one-second spans — no more readable than the digits were. Unmeasured seconds
  // are never smoothed into or out of, so a gap stays exactly as wide as it really is.
  const sm = raw.map((v, i) => {
    if (v < 0) return -1;
    const w = [raw[i - 1], v, raw[i + 1]].filter((x) => typeof x === "number" && x >= 0).sort((x, y) => x - y);
    return w.length ? w[Math.floor(w.length / 2)] : v;
  });

  const band = (v) =>
    v < 0 ? "UNMEASURED" :
    v <= 1 ? "still" :
    v <= 3 ? "incidental" :
    v <= 6 ? "ACTION" : "STRONG ACTION";

  const rows = [];
  let start = 0;
  for (let i = 1; i <= sm.length; i++) {
    if (i === sm.length || band(sm[i]) !== band(sm[start])) {
      const slice = raw.slice(start, i).filter((v) => v >= 0);
      const peak = slice.length ? Math.max(...slice) : -1;
      const b = band(sm[start]);
      const last = rows[rows.length - 1];
      // Absorb sub-2s slivers into the run before them — at one value per second a
      // single-second dip is not a real change of state. Never absorb across an
      // UNMEASURED boundary: that distinction is the whole point of the sentinel.
      if (last && i - start < 2 && last.band !== "UNMEASURED" && b !== "UNMEASURED") {
        last.e = i;
        last.peak = Math.max(last.peak, peak);
      } else {
        rows.push({ s: start, e: i, band: b, peak });
      }
      start = i;
    }
  }

  return rows
    .map((r) => r.s + "-" + r.e + "s: " + r.band + (r.peak >= 0 ? " (peak " + r.peak + ")" : ""))
    .join("\n");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const words = Array.isArray(body.words) ? body.words : [];
    const duration = Number(body.duration) || 0;
    const frame = typeof body.frame === "string" ? body.frame : null; // small JPEG data URL of one frame

    // A TIMESTAMPED STRIP OF THE FOOTAGE, for the styles where the pictures ARE the job.
    //
    // The activity track answers "how much is moving", which is the right question for
    // fashion's cuts and the wrong one for everything aesthetic: it cannot tell a
    // kitchen from a bathroom, or a good frame from a dull one. A transcript cannot
    // either, and a property tour's montage blocks are silent by design.
    //
    // So these two styles get to LOOK. Each frame is labelled with its timestamp on the
    // same timeline as the word timings, so anything the model notices can be quoted
    // straight back as a keep range or an effect position.
    //
    // Capped because every frame is tokens on every edit forever. 32 across a whole
    // video is roughly one every few seconds — enough to tell rooms and outfits apart,
    // which is all that is being asked.
    const MAX_FRAMES = 32;
    const frames = Array.isArray(body.frames)
      ? body.frames
          .filter((f) => f && typeof f.data === "string" && /^data:/.test(f.data) && Number.isFinite(Number(f.t)))
          .slice(0, MAX_FRAMES)
          .map((f) => ({ t: Math.max(0, Number(f.t)), data: f.data }))
      : [];
    const canSee = frames.length > 0;
    // THE SINGLE MOST IMPORTANT LINE FOR DIAGNOSING A BAD EDIT.
    //
    // Everything the frame-based styles do — placing effects on visible changes,
    // telling rooms apart to use every clip, judging which shots are steady — is
    // gated on `canSee`. If the app sends no frames, the planner silently drops to a
    // blind fallback that can do none of it, and the result is exactly the reported
    // symptom set: no effects, clips skipped, shaky shots kept. No error is raised
    // because a blind plan is still a valid plan.
    //
    // The frames come from the browser sampling the uploaded footage, which is the
    // fragile step — Safari cannot always seek Sony files. So this logs, on EVERY
    // edit, whether the planner could actually see. A tour that comes back wrong and
    // shows `canSee=false` here is a frame-sampling failure in the app, not a prompt
    // problem, and no amount of prompt tuning will touch it.
    console.log("[plan] " + (body.style || "?") + ": frames received=" +
                (Array.isArray(body.frames) ? body.frames.length : 0) +
                ", valid=" + frames.length + ", canSee=" + canSee);
    // Every style the planner knows. A style missing from this list does not error —
    // it silently becomes talkinghead, which is worse: fashion arrived here, was
    // quietly renamed, and was then rejected for having no transcript by a check its
    // own exemption sat two lines below. The symptom pointed at the exemption; the
    // cause was a list nobody thought to update.
    //
    // Anything added to the style picker must be added here in the same breath.
    // ── ONE TABLE, NOT NINE SCATTERED CONDITIONS ─────────────────────────────
    //
    // Every style bug today has been the same shape: a list written before a style
    // existed, never updated, silently treating the newcomer as a talking head. The
    // render whitelist ate fashion. The schema branch gave property and founder chapter
    // cards they should never have had. Each one looked like a different bug and each
    // one was this.
    //
    // A capability table cannot drift the same way, because adding a style means adding
    // a ROW, and a missing row is loud rather than silent.
    //
    //   chapters  — asked for title cards, and allowed to keep them
    //   broll     — asked for generated inserts
    //   activity  — given the movement track in its prompt
    //   needsWords— refuses without a transcript
    //   fx        — the transition vocabulary it may use, or null
    const STYLE_SPEC = {
      talkinghead:  { chapters: false, broll: false, activity: false, needsWords: true,  fx: null },
      vlog:         { chapters: true,  broll: false, activity: true,  needsWords: true,  fx: null },
      tutorial:     { chapters: true,  broll: true,  activity: false, needsWords: true,  fx: null },
      process:      { chapters: true,  broll: true,  activity: true,  needsWords: false, fx: null },
      cinematic:    { chapters: true,  broll: true,  activity: true,  needsWords: true,  fx: null },
      showcase:     { chapters: false, broll: false, activity: false, needsWords: false, fx: null },
      fashion:      { chapters: false, broll: false, activity: true,  needsWords: false, fx: ["slowmo", "ramp"] },
      entrepreneur: { chapters: false, broll: false, activity: false, needsWords: true,  fx: ["whip", "push", "flash", "drain", "echo"] },
      realestate:   { chapters: false, broll: false, activity: true,  needsWords: false, fx: ["roll", "push", "flash", "slowmo"] },
    };

    // AN UNKNOWN STYLE IS AN ERROR, NOT A TALKING HEAD.
    //
    // Silently substituting is what made every one of these failures invisible: the
    // render succeeded, it just was not the thing that was asked for. A clear refusal
    // costs one confusing minute; a silent substitution costs a day of wondering why
    // the edit is wrong.
    const style = body.style && STYLE_SPEC[body.style] ? body.style : (body.style ? null : "talkinghead");
    if (!style) {
      return res.status(400).json({ error: "Unknown video style \"" + String(body.style).slice(0, 40) + "\". This is a bug on our side, not yours — please tell us." });
    }
    const SPEC = STYLE_SPEC[style];
    // The activity track: one integer per second of the GLOBAL timeline, 0 (nothing
    // moving) to 9 (a lot). Measured on the render box from the footage itself, not
    // guessed and not generated by a model.
    const activity = Array.isArray(body.activity) ? body.activity : null;
    // The DIRECTOR'S NOTE: the person's own instructions for how they want this cut.
    // Plain English, from the "how do you want this edited?" box or written by the
    // script writer. Everything else in this prompt is what the editor infers; this
    // is what the person actually asked for, and it OUTRANKS the generic style rules
    // wherever the two disagree. Capped like every other free-text field that reaches
    // a model — it's untrusted input steering a paid render.
    const directorNote = String(body.note || "").trim().slice(0, 1200);
    // YOUR OWN b-roll: clips the person shot to SHOW something rather than to say
    // something. They carry no transcript (their words are stripped client-side before
    // the plan, deliberately), so the LABEL is the only thing describing them. Placing
    // them is a language task — match "the food arriving" to the moment in the talking
    // footage where that belongs — which is the one thing a model is dependable at.
    const brollClips = (Array.isArray(body.brollClips) ? body.brollClips : [])
      .map(b => ({
        clip: Math.max(0, Math.floor(Number(b && b.clip) || 0)),
        label: String((b && b.label) || "").trim().slice(0, 80),
        dur: Math.max(0, Number(b && b.dur) || 0)
      }))
      .filter(b => b.dur > 0.5)
      .slice(0, 20);
    // A process video can be almost entirely silent, so it is the one style that may
    // be planned with no transcript at all.
    // Fashion joins process as a style that can be planned with no transcript at all.
    // An outfit film has nobody talking in it by definition - requiring speech would
    // reject exactly the footage the style exists for.
    if (!words.length && SPEC.needsWords) return res.status(400).json({ error: "Missing transcript." });

    const GKEY = (process.env.GEMINI_API_KEY || "").trim();
    const AKEY = (process.env.ANTHROPIC_API_KEY || "").trim();
    const engine = (process.env.PLANNER_ENGINE || "claude").trim().toLowerCase() === "gemini" ? "gemini" : "claude";
    // Only a total absence of BOTH is fatal. Either one on its own can plan an edit.
    if (!GKEY && !AKEY) return res.status(500).json({ error: "The editor is not configured." });

    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again." });

    // Compact word list: "word|start|end" per line (caps prompt size on long videos).
    // How much of the transcript the planner is allowed to see.
    //
    // This was 4000, which is only ~29 minutes of speech — and it truncated SILENTLY,
    // so a 45-minute upload was planned from its first 29 minutes and the rest simply
    // never appeared in the edit. The input was never the real constraint: 4000 words
    // is ~28K tokens against a context window of roughly a million.
    //
    // 12000 (~85 minutes) is the compromise, and the limits it respects are the ones
    // further down, not the context window:
    //   · the function timeout (maxDuration above) — a bigger transcript takes longer
    //     to read and answer, and a killed function loses the whole edit,
    //   · the OUTPUT budget — a long video means more keep ranges to write out.
    // Raise it further only alongside those two.
    const WORD_LIMIT = 12000;
    const truncated = words.length > WORD_LIMIT;
    if (truncated)
      console.warn("[plan] transcript truncated: " + words.length + " words, planning from the first " + WORD_LIMIT + " (~" + Math.round(WORD_LIMIT/140) + " min). The tail will not appear in the edit.");
    const lines = words.slice(0, WORD_LIMIT).map(w => w.w + "|" + w.s + "|" + w.e).join("\n");

    const editorRole = style === "vlog"
      ? "You are a professional video editor AND colorist cutting a VLOG (real-world, day-in-the-life footage where the person talks while moving through places)."
      : style === "tutorial"
      ? "You are a professional video editor AND colorist cutting a TUTORIAL (one person teaching, sit-down, possibly with a screen). Clarity beats pace."
      : style === "process"
      ? "You are a professional video editor AND colorist cutting a PROCESS video — cooking, cleaning, a build, a craft, a get-ready-with-me. Someone is DOING something, and the doing is the point. Long stretches have no talking at all and are the best material in the video, not gaps in it."
      : style === "cinematic"
      ? "You are a professional video editor AND colorist cutting a CINEMATIC STORYTELLING piece in the energy of a Scorsese picture — voiceover-driven, kinetic, confessional first-person. Momentum is everything."
      : style === "entrepreneur"
      ? "You are a professional video editor AND colorist cutting a FOUNDER FILM — one person talking about their business, to camera, across several setups. It should feel confident and expensive: every cut lands on a finished thought, never inside one."
      : style === "realestate"
      ? "You are a professional video editor AND colorist cutting a PROPERTY TOUR. It alternates between the agent presenting to camera and fast silent bursts of the property itself. The silent stretches are the tour and are the most valuable footage in the video, not gaps in it."
      : "You are a professional video editor AND colorist cutting a talking-head video (one person speaking to camera).";

    const tutorialRules =
        "Decide which time segments to KEEP so the tutorial is clear and easy to follow:\n" +
        "- REMOVE filler words (um, uh), false starts, repeated takes (keep the best take), and dead air over ~2.5s — but keep short thinking pauses; tutorials should feel calm, not rushed.\n" +
        "- KEEP the natural flow: never cut mid-word; start each kept segment ~0.15s before its first word and end ~0.35s after its last word.\n" +
        "- Merge keeps that are less than 1s apart into one segment. No kept segment shorter than 1s.\n" +
        "- A good tutorial cut usually keeps 80-95% of clear teaching.\n" +
        "- ALSO identify 2-6 SCENE INTROS: natural section starts in the teaching. Each label is a short cinematic intro to what comes next (2-5 words, title case) — like 'Setting Up', 'The First Step', 'The Common Mistake', 'Bringing It Together'. NEVER use the word Chapter. Give each one's start time (seconds, ORIGINAL timeline, at a sentence boundary).\n";
    const cinematicRules =
        "Decide which time segments to KEEP so the piece is KINETIC and relentless — Scorsese energy:\n" +
        "- Cut hard: remove all filler, hesitation, false starts, dead air over ~1.5s, and anything that slows momentum. Keep only the strongest 60-85% of the material.\n" +
        "- Never cut mid-word; start keeps ~0.1s before the first word, end ~0.2s after the last.\n" +
        "- Merge keeps under 0.4s apart. No kept segment shorter than 1s.\n" +
        "- ALSO identify 0-4 SCENE INTROS where the story clearly turns (a time jump, a place change, a twist). Short cinematic card labels (2-5 words, title case) in the storyteller's own words — like 'Three Months Earlier', 'The Turning Point', 'Back In Miami'. NEVER the word Chapter. Give each start time (seconds, ORIGINAL timeline).\n" +
        "- ALSO identify 2-4 B-ROLL moments: points where the speaker references something visual (a place, an object, a scene, a memory) and a full-screen cinematic photograph should cut in over their voice. For each give: s (seconds, ORIGINAL timeline, at the moment the thing is mentioned) and prompt (a vivid photography brief for that image — subject, setting, lighting, mood; absolutely no text or words in the image). Describe the scene NEUTRALLY, as a straight photograph: do NOT ask for a warm, cinematic, filmic, teal-and-orange or otherwise graded look. The render applies the film-look LUT to these inserts itself, so a pre-graded image would be graded twice and would jump out against the surrounding footage.\n";
    // FASHION — an outfit film. No speech, no captions, no labels: rhythm and shape.
    //
    // Every other style here cuts on MEANING — what was said, what was done. This one
    // cuts on TIME. The reference it comes from runs 22 shots in 15 seconds, most of
    // them under half a second, and what makes it work is not any individual shot but
    // the rate at which they arrive.
    //
    // So the rules are almost the inverse of talking-head. Do not preserve a thought.
    // Do not keep a moment because it is complete. Take the frames where the subject
    // is MOVING, hold them briefly, and cut. A shot that outstays its welcome is the
    // only real failure in this format.
    //
    // The loop is not a flourish. Opening and closing on the same framing is what lets
    // it play twice on a feed with no visible seam, and it is most of why the reference
    // feels finished rather than merely fast.
    const fashionRules =
        "This is an OUTFIT FILM. Nobody is talking and nothing needs explaining. You are cutting for RHYTHM.\n" +
        "\n" +
        "You have ONE signal: the ACTIVITY TRACK above - how much of the picture is moving, second by second. Use it the way a dancer uses a beat.\n" +
        "\n" +
        "THE RULES:\n" +
        "- SHORT. Most segments should be 0.3 to 1.2 seconds. A few may run to 2 seconds for a held pose. Nothing longer, ever.\n" +
        "- Keep the moments with the MOST movement - a turn, a step, a bag swinging, fabric catching. Movement is the subject here.\n" +
        "- Cut a walk into several pieces from different points rather than keeping one long walk. The same ten seconds of footage should become six cuts, not one.\n" +
        "- Alternate wide and close where the footage allows it. Two wides in a row read as a mistake.\n" +
        "- Drop anything static, anything where they are adjusting themselves or looking at the camera between takes, and anything out of focus unless the blur is directional and looks deliberate.\n" +
        "- THE LOOP: the FIRST and LAST segments must come from the same framing - ideally the same shot, near its start and near its end. Played on repeat this hides the join entirely.\n" +
        "- Aim for 18 to 30 segments in a 15 to 25 second film. If the footage cannot support that many, use what there is rather than padding with long holds.\n";

    const entrepreneurRules =
        "This is a FOUNDER FILM — one person talking to camera about their business, cut to feel confident and expensive.\n" +
        "\n" +
        "The TRANSCRIPT is the whole signal. Cut on MEANING, not on rhythm.\n" +
        "\n" +
        "THE RULES:\n" +
        "- CUT ON COMPLETE THOUGHTS. A new segment starts when a sentence or a clear idea starts, never mid-clause. This is the single most important rule here: the reference changes setup after every finished thought and never inside one.\n" +
        "- Segments run 1.5 to 7 seconds; most sit between 2 and 5. Aim for 8 to 12 segments in 30 seconds. This is NOT a fast montage — a talking film cut every half second reads as panic.\n" +
        "- REMOVE filler (um, uh, filler 'like'), false starts, repeated takes (keep the best), and any pause over ~1.5 seconds where nothing is said and nothing is shown.\n" +
        "- Never cut mid-word. Start each segment ~0.15s before its first word and end ~0.35s after its last, so the delivery lands before the picture changes.\n" +
        "- DO NOT TRY TO ARRANGE THE SHOTS. You cannot see the footage — you have the words and nothing else. The person filming this worked from a script and already positioned themselves for each line, so the sequence of setups is a decision they have made. Your job is to assemble what they said, in order, cleanly. Any attempt to order or vary the visuals here is guesswork and makes the edit worse.\n" +
        "- THE PAYOFF LINES EARN THEIR OWN SEGMENT. Where a sentence turns on one idea, give that idea its own cut rather than burying it mid-segment.\n" +
        "- THE LOOP: the LAST segment should come from the SAME framing as the FIRST, so the film restarts without a visible ending. Prefer the opening setup near its end.\n";

    const fashionSeeing = canSee && style === "fashion"
      ? "\nYOU CAN SEE THE FOOTAGE. Nothing here replaces the activity track — it decides WHERE the movement is and it is more precise than sampled frames. The pictures add the judgement it cannot make:\n" +
        "- Between two moments with similar movement, keep the one that LOOKS better. Framing, light, whether the outfit reads clearly, whether the pose has landed.\n" +
        "- Drop moments where the movement is real but the frame is not worth showing — the subject half out of shot, an unflattering angle, a dead background.\n" +
        "- The opening and closing shot should be the two strongest frames in the footage, not merely the first and last movement.\n"
      : "";

    // PURE MONTAGE. The presenter half is deliberately gone.
    //
    // This used to describe a film that ALTERNATES a presenter talking to camera with
    // silent bursts of the property, with a fallback branch for when nobody speaks.
    // Two problems. The app no longer sends a transcript for this style at all, so the
    // presenter half was unreachable in every case — and leaving it in the prompt gave
    // the model a structure it could not build and no way to tell which half applied.
    // A tour is a thing you WATCH. Fashion Film proves the shape works: no transcript,
    // frames only, and the most coherent edits the tool makes.
    const realestateRules =
        "This is a PROPERTY FILM, and it is SILENT. Nobody narrates it. You are cutting pictures to music.\n" +
        "\n" +
        "There is no transcript and there is no presenter. Do not look for one, do not structure the film around one, and do not leave gaps for one.\n" +
        "\n" +
        "THE SHAPE:\n" +
        "- Short shots, 0.5 to 2.0 seconds each, cut one after another.\n" +
        "- Different rooms and different scales. A wide, then a detail, then somewhere else. Two shots of the same worktop back to back waste the film.\n" +
        "- OPEN on the exterior or the approach if one exists.\n" +
        "- CLOSE on the widest, most impressive frame available — the fullest view of the property.\n" +
        "- THE LOOP: prefer an opening shot that could follow the closing one without a jolt.\n" +
        "- Aim for 25 to 35 segments in a 60 second film.\n" +
        "\n" +
        "USE EVERY PIECE OF FOOTAGE YOU WERE GIVEN. THIS IS NOT OPTIONAL.\n" +
        "- The footage is several separate recordings laid end to end into one timeline. Most are only a few seconds long, and each one was shot because it shows something the others do not.\n" +
        "- Take AT LEAST ONE shot from every part of the timeline. Walk the whole duration from 0 to the end and satisfy yourself that no stretch longer than a few seconds has been skipped entirely.\n" +
        "- Skipping a stretch means a room the owner filmed never appears in their tour. That is the worst thing you can do here.\n" +
        "- MANY OF THESE RECORDINGS ARE ONE OR TWO SECONDS LONG. That is normal and deliberate — each one is a single move through a doorway, or one look at a detail. A one second recording is NOT too short to use.\n" +
        "- On a recording of one or two seconds, KEEP IT ALMOST WHOLE. Trim only the jolt at the very start or end of the move and keep the rest as one shot. Do not hunt for a shorter shot inside it — on a clip that brief, the whole clip IS the shot.\n" +
        "- A kept shot may be as short as 0.5 seconds. Below half a second it is a flicker rather than a shot, so leave those out.\n" +
        "\n" +
        "PREFER SMOOTH FOOTAGE. THIS IS WHAT MAKES IT LOOK EXPENSIVE.\n" +
        "- The frames are your evidence. A gliding move — the camera travelling steadily through a doorway, panning evenly across a room, floating toward a detail — is the material this style is made of. Keep those.\n" +
        "- Jerky, snatched or corrective movement is a reject. So is the moment a move starts or stops, where the camera jolts. Trim into the middle of a move where it has settled, not the ends.\n" +
        "- Given two shots of the same room, ALWAYS keep the steadier one.\n" +
        "- A locked-off still shot is good. Motion is not the goal — CONTROLLED motion is. Do not mistake a shaky camera for an interesting one.\n" +
        "- YOU CAN SEE SHAKE IN A STILL FRAME, and this is how. A jolted handheld frame carries directional MOTION BLUR — edges smeared, a doorframe or worktop doubled. A tilted horizon, a wall leaning when it should be upright, is a camera being fought rather than carried. A steady frame is crisp: clean edges, level verticals.\n" +
        "- Compare consecutive frames from the same stretch. A carried camera moves the scene a little and in ONE consistent direction. A shaken one jumps position and angle unpredictably between frames. Keep the first, cut the second.\n" +
        "- When every shot of a room is soft or crooked, keep the least bad one and keep it SHORT. Do not drop the room — the owner filmed it and it belongs in the tour.\n";

    const processRules =
        "You have TWO tracks to cut from, and this is the whole job:\n" +
        "- The TRANSCRIPT below, as usual. This is the stronger of the two signals: if someone is talking, that moment matters.\n" +
        "- THE FRAMES, if they are attached. These cover what the transcript cannot: the silent working stretches, which in this style are most of the video. The activity track says a lot is moving but not what — it cannot separate washing up from wiping a counter from putting shopping away. Where someone SAYS what they are doing, that still wins; the frames confirm it, extend it across the silence that follows, and name the steps nobody narrated.\n" +
        "- An ACTIVITY TRACK: how much of the picture is moving, measured from the footage itself, given above as timestamped spans with a peak value of 0 to 9. still means genuinely nothing is moving — an empty counter, an abandoned tripod, someone out of frame. ACTION (4-6) is a person working within a fixed shot: hands chopping, wiping, folding, assembling. STRONG ACTION (7-9) is large movement — the camera moving, or something carried across the frame. The span times are on the same timeline as the word timings, so an ACTION span is a keep range you can quote directly. UNMEASURED means the read failed for that stretch, NOT that nothing happened — keep those unless speech says otherwise.\n" +
        "\n" +
        "THE RULE THAT MATTERS: silence is NOT dead air in this video. A silent stretch with HIGH activity is the most valuable footage there is — it is the actual work being done, and it must be KEPT even though nobody is speaking over it. A silent stretch with activity at or near 0 is genuinely dead and should go.\n" +
        "\n" +
        "- KEEP: anything with activity 4 or above, talking or not. This is the process itself.\n" +
        "- KEEP: talking, on the usual terms — cut filler, false starts, repeated takes.\n" +
        "- CUT: silence where activity is 0-1 for more than ~2s. Nothing is happening and nobody is talking.\n" +
        "- NEVER cut a segment just because activity is low while the person is TALKING. Speech is proof that something is happening even when the picture is still — a locked-off camera on someone explaining a step is exactly what this style is for. Talking is only ever cut on the usual grounds: filler words, false starts, a repeated take.\n" +
        "- Spoken context beats the number, and it points in all three directions: 'let me show you' / 'now we cook' protects what FOLLOWS; 'here we go' protects what SURROUNDS; 'that took two hours' / 'so that's done' protects what came BEFORE, because the words arrive after the work. That last one is the easiest to miss.\n" +
        "- COMPRESS, don't delete, repetitive work. Thirty seconds of continuous chopping at activity 6 does not need to survive whole — keep 6-10 seconds of it and move on. The viewer needs to see that it happened, not watch all of it.\n" +
        "- Never cut mid-word. Start keeps ~0.15s before the first word, end ~0.3s after the last.\n" +
        "- Merge keeps less than 1.5s apart. No kept segment shorter than 1s.\n" +
        "- ALSO identify 2-6 SCENE INTROS at real stage changes in the process — 'Prepping The Base', 'Into The Oven', 'The Messy Part', 'Finishing Touches'. 2-5 words, title case. NEVER the word Chapter. Give each start time in seconds on the ORIGINAL timeline.\n" +
        "- ALSO identify 0-3 B-ROLL moments where a full-screen photograph would help — an ingredient, a finished result, a tool being referenced. Same neutral photographic brief as always, no grading language.\n";

    // The same two-track thinking as processRules, condensed, for styles that keep
    // their own character but should still respect what the FOOTAGE shows. Prepended
    // rather than replacing, so a vlog stays a vlog.
    //
    // This exists because a gym-and-cooking vlog came back as nothing but talking: the
    // activity track was only ever wired to "process", so every other style judged the
    // edit on speech alone and threw away the doing.
    const activityPreamble =
        "\nTHE ACTIVITY TRACK — THESE RULES OVERRIDE THE PACING RULES ABOVE WHERE THEY CONFLICT:\n" +
        "You ALSO have an ACTIVITY TRACK: how much of the picture is moving, measured from the footage itself, given above as timestamped spans with a peak value of 0 to 9. still/incidental are low; ACTION and STRONG ACTION are the person genuinely doing something.\n" +
        "- Those span times are on the same timeline as the word timings, so an ACTION span is a keep range you can quote directly. Do not go looking for words to justify it — the span IS the justification.\n" +
        "- UNMEASURED means the motion read failed for that stretch of footage. It does NOT mean nothing happened there. Judge those spans on speech and context alone and lean towards KEEPING them; never cut footage merely because it is unmeasured.\n" +
        "- Silence is NOT automatically dead air. A quiet stretch with activity 4 or above is the person DOING something — cooking, training, showing, making — and in this kind of video that is the most valuable footage there is. KEEP it.\n" +
        "- SPOKEN CONTEXT BEATS THE NUMBER. When the speech names an activity, the silent footage next to it IS that activity, and the words tell you what you are looking at. Keep it even at moderate activity, because you know what it is.\n" +
        "  Look in all three directions, not just forwards:\n" +
        "  · BEFORE it happens — 'I'm about to sit down and eat', 'I'm going to the gym', 'let me show you' -> keep what FOLLOWS.\n" +
        "  · AS it happens — 'here we go', 'watch this', 'okay so I'm just mixing this in' -> keep what SURROUNDS it.\n" +
        "  · AFTER it happened — 'I just finished running', 'that took me two hours', 'so that's done' -> keep what came BEFORE, because that footage is the thing being talked about. This is the one most easily missed: the words arrive after the action.\n" +
        "  An announcement is a promise the edit has to deliver on. Cutting straight from 'I'm about to eat' to the next sentence breaks it, and so does cutting the run that 'I just finished running' refers to.\n" +
        "- The bands, so there is no grey area: 0-1 is nothing happening; 2-3 is incidental movement (a hand shifting, the camera drifting) and is NOT action; 4 and above is the person genuinely doing something.\n" +
        "- CUT silence in the 0-3 band by the normal pacing rules. Only 4 and above is protected. Incidental movement is still dead air.\n" +
        "- NEVER cut a segment just because activity is low while the person IS talking. Speech is proof the moment matters.\n" +
        "- COMPRESS rather than delete repetitive action: 40 seconds of the same motion at activity 6 can become 8-10 seconds and move on.\n" +
        "- Where a pacing rule above says to cut silence or dead air by DURATION, read it as applying to silence with activity 0-3. Silence at 4 or above is content, not slack, however long it runs.\n" +
        "- None of this changes how SPEECH is treated. Filler words, hesitation, false starts and repeated takes are cut exactly as instructed above regardless of what the activity track says — a high number during an 'um' does not save it.\n\n";

    // Belt and braces: if the track never arrived, do not run the process rules.
    // They instruct the model to cut silence with low activity, and with no track to
    // read that becomes "cut all silence" — which is the whole video in a cooking or
    // cleaning edit. Fall back to vlog behaviour, which protects quiet moments.
    const haveActivity = !!(activity && activity.length);
    const processUsable = style === "process" && haveActivity;
    // vlog and cinematic keep their own rules but gain the motion reading on top.
    const activityOn = haveActivity && SPEC.activity && style !== "process" && style !== "fashion";
    // The activity rules go AFTER the style rules, not before.
    //
    // Prepending them didn't work: cinematic's own rules say "cut hard... dead air over
    // ~1.5s... anything that slows momentum", and a later instruction in a prompt tends
    // to beat an earlier one. So the track arrived, was described, and was then
    // overruled a paragraph later — a gym-and-cooking edit still came back as talking
    // heads. Last word plus an explicit statement of precedence.
    // Applied to EVERY style, after the style's own rules.
    //
    // "false starts" was one clause inside a five-item list, sitting next to two full
    // bullets about closing gaps — so the model spent its attention on pacing and left
    // the stutters in. Edits came back saying "Find the- find the brands that need
    // marketing, do the- do the thing that makes you happy": both attempts intact.
    //
    // The fix is not more emphasis, it is a WORKED EXAMPLE. A restart has a signature
    // in the transcript — the same two or three words appearing twice in a row — and
    // naming that signature turns a judgement call into pattern matching, which is the
    // thing these models are reliably good at.
    const restartRule =
      "\nRESTARTS AND STUTTERS — this applies whatever the style:\n" +
      "- When someone starts a phrase, breaks off, and starts it again, cut the ABANDONED attempt completely and keep only the finished one.\n" +
      "- In the transcript a restart looks like the same short run of words appearing twice, back to back. For example: \"find the ... find the brands that need marketing\" or \"do the ... do the thing that makes you happy\". The first attempt is the mistake. Cut from where it begins to where the successful attempt begins.\n" +
      "- Do the same for a word begun and re-begun (\"mar- marketing\"), and for a sentence restarted with different wording (\"I think that- what I mean is\") — keep the version the speaker settled on, which is almost always the LAST one.\n" +
      "- This is not the same as repetition for emphasis. \"It is really, really good\" is deliberate and stays.\n";

    const cutRules =
      (style === "fashion" ? (fashionRules + fashionSeeing) : style === "entrepreneur" ? entrepreneurRules : style === "realestate" ? realestateRules : processUsable ? processRules : style === "cinematic" ? cinematicRules : style === "tutorial" ? tutorialRules : style === "vlog"
      ? ("Decide which time segments to KEEP so the vlog is punchy and keeps moving — but respect that vlogs have VISUAL moments:\n" +
         "- IMPORTANT: in a vlog, silence is NOT automatically dead air — quiet gaps under ~4 seconds are usually the person showing something, walking, or letting a moment breathe. KEEP those (extend the surrounding kept segment across them) unless they clearly drag.\n" +
         "- REMOVE filler words (um, uh, like when used as filler), false starts, repeated takes (keep the best take), and only truly long dead air (over ~4-5s of nothing).\n" +
         "- KEEP the natural flow: never cut mid-word; start each kept segment ~0.15s before its first word and end ~0.4s after its last word (vlogs breathe a little more).\n" +
         "- Merge keeps that are less than 4s apart into one segment (bridging the visual moments between them). No kept segment shorter than 1s.\n" +
         "- A good vlog cut usually keeps 75-92% of decent footage.\n" +
         "- ALSO identify 0-5 SCENE INTROS where the day clearly moves to a new moment — a place change, a time jump, a new activity. Each label is a short cinematic card introducing what comes next, in the vlogger's own context — like 'Arriving Home', 'The Next Day', 'Monday, 8:45 AM', 'Back In The Studio'. Use time/place words the speaker actually says when possible. NEVER use the word Chapter. Give each one's start time (seconds, ORIGINAL timeline). If the vlog has no clear scene changes, return an empty list.\n")
      : ("Decide which time segments to KEEP so the final cut is TIGHT and punchy — this is one person talking to camera and the pacing should feel deliberate, never slack:\n" +
         "- REMOVE filler words (um, uh, like when used as filler), false starts, repeated takes (keep the best take), and ANY pause longer than about half a second between phrases. Dead air between sentences is the main thing that makes a talking-head video drag — cut it out so one thought lands straight into the next.\n" +
         "- Close the GAPS between kept phrases hard. The single most common complaint is too much silence between breaths and sentences; leave only a natural beat, not a held pause. When someone finishes a sentence and there's a gap before the next, tighten it right up.\n" +
         "- Never cut mid-word, but cut CLOSE: start each kept segment ~0.08s before its first word and end ~0.12s after its last word. A short tail keeps it clean without leaving trailing silence.\n" +
         "- Merge keeps less than 0.3s apart into one segment. No kept segment shorter than 1s.\n" +
         "- Be decisive: a tight talking-head cut usually keeps 65-85% of a well-delivered video, less if it's rambly. When in doubt between leaving a pause and cutting it, CUT it.\n"))
      + restartRule
      + (activityOn ? activityPreamble : "");

    const prompt =
      editorRole + "\n" +
      (directorNote
        ? ("\n=== THE CREATOR'S OWN DIRECTION FOR THIS VIDEO ===\n" +
           "The person who shot this told you exactly how they want it edited. This is the single most important input you have. Follow it wherever it's specific, and let it OVERRIDE the general style rules below whenever the two disagree — if they say keep something the rules would cut, keep it; if they say cut something the rules would keep, cut it; if they name a title or a mood or where b-roll should go, do that. Only fall back to the general rules for anything their direction doesn't cover.\n" +
           "Their direction:\n\"" + directorNote + "\"\n" +
           "=== END OF THE CREATOR'S DIRECTION ===\n\n")
        : "") +
      "Below is the transcript as word|startSeconds|endSeconds lines. Total length: " + duration + "s.\n" +
      // Chapter labels are the thing most damaged by planning blind: they are asserted
      // as fact on screen, so a wrong one is not a duller edit, it is a caption that
      // says something the video does not show.
      (canSee
        ? ("USE EVERY SIGNAL. EACH ONE KNOWS SOMETHING THE OTHERS DO NOT.\n" +
           "- SPEECH names things a picture cannot. What something IS, what is ABOUT to happen, why it matters. \"I'm about to mash the potatoes\" tells you what the next stretch is before anything visible has happened, and no frame could. When someone says what they are doing, believe them — they know and you are looking at one sampled moment of it.\n" +
           "- FRAMES show what is actually happening, and they cover the silent stretches where the transcript says nothing at all. Someone working quietly is not doing nothing.\n" +
           "- THE ACTIVITY TRACK says WHERE the action is, more precisely than either.\n" +
           "\n" +
           "COMBINE THEM. Where two disagree, prefer the one that can actually know: a spoken \"mashing the potatoes\" beats an ambiguous frame of a pan, and a clear frame of a sink full of plates beats ninety seconds of silence. Use the frames to CONFIRM or CORRECT what the words suggest, not to replace them.\n" +
           "\n" +
           "Any label, title or chapter must be supported by at least one of these. If none of them makes an activity clear, write a plainer label that is true rather than a specific one that might not be — \"kitchen\" beats a confident guess at the wrong task. Being confidently specific with nothing to go on is the one failure that shows on screen.\n\n")
        : "") +
      (canSee
        ? ("YOU CAN SEE THIS FOOTAGE. " + frames.length + " frames are attached, each labelled with its timestamp on the same timeline as everything else above.\n" +
           "Use them. This is the difference between arranging a video and editing one:\n" +
           "- Judge frames on how they LOOK. Composition, light, colour, whether the subject is well placed, whether the shot is worth showing. A technically busy shot that looks bad is not a keep.\n" +
           "- Notice what each shot actually CONTAINS, and let that drive both what you keep and where anything lands. A detail shot of a countertop and a wide shot of a room are different material and want different treatment.\n" +
           "- Prefer the better-looking of two similar moments. That judgement is the whole point of attaching these.\n" +
           "- The frames are samples, not every frame. Something can happen between two of them, so treat them as evidence rather than as the complete record.\n\n")
        : "") +
      (frame ? "A still frame from the footage is attached — use it ONLY for the color analysis below.\n" : "") +
      (activity && activity.length
        ? ("\nACTIVITY TRACK — measured from the footage itself, one reading per second, " +
           "collapsed into spans. Times are seconds on the ORIGINAL timeline, the same " +
           "scale as the word timings above, so you can quote them directly in `keep`.\n" +
           "Bands: still = nothing moving · incidental = a hand shifting or the camera " +
           "drifting · ACTION = the person genuinely doing something · STRONG ACTION = a lot " +
           "of movement. `peak` is the highest reading inside that span, 0-9.\n" +
           activitySpans(activity) + "\n")
        : "") +
      "\n" + cutRules +
      "- Segments must be in chronological order, non-overlapping, within 0.." + duration + ".\n\n" +
      (brollClips.length
        ? ("YOUR B-ROLL CLIPS — footage this person shot to SHOW something, not to say something:\n" +
           brollClips.map(b => "  clip " + b.clip + " · " + Math.round(b.dur) + "s · \"" + (b.label || "(no label)") + "\"").join("\n") + "\n\n" +
           "These are NOT in the transcript and are NOT part of `keep` — they are separate footage waiting to be placed. Return `brollPlace`: a list of where each one belongs, with:\n" +
           "- clip: the clip number from the list above.\n" +
           "- at: the second on the ORIGINAL timeline where it should cut in. Place it where the story ARRIVES at that thing — right after they announce it, mention it, or react to it. \"We finally got here\" is where the arrival shot goes; \"look at this\" is where the thing being looked at goes; \"that was so good\" means the footage belongs just BEFORE, because they are talking about something you have already shown.\n" +
           "- s and e: which part of that clip to use, in seconds from ITS OWN start. This is the stylistic call and it is yours to make. A shot needs long enough to read and no longer — roughly 2-5s for a look at something, longer only when the footage genuinely develops (a dish being set down, a door opening onto a room). Take the strongest few seconds; you do not have to use a clip whole, and a 40s clip almost never earns 40s.\n" +
           "- Order them the way the day happened: arriving before eating, eating before leaving.\n" +
           "- Use each clip ONCE. Skip any that has no natural home rather than forcing it — a b-roll shot dropped somewhere arbitrary reads as a mistake.\n" +
           "- A labelled clip is a promise the edit should keep. If they shot it and named it, they want it in.\n\n")
        : "") +
      "Also write:\n" +
      "- title: a short punchy on-screen opening title for this video (max 6 words, no quotes, no emojis).\n" +
      "- music: a brief for an ORIGINAL INSTRUMENTAL SCORE to sit quietly under this person's voice for the whole video. " +
        "Write it as a composer's brief, not a mood word: name the genre, the instruments, the tempo in BPM, and the emotional register, " +
        "and base it on what this person is ACTUALLY TALKING ABOUT in the transcript above. A piece about losing everything and starting " +
        "again does not get the same score as a studio tour. Max 60 words. It must be instrumental — never ask for vocals, lyrics or singing. " +
        "It must be an UNDERSCORE: steady, restrained, no drops, no dramatic build-and-release, nothing that would fight the edit or pull " +
        "attention off the voice.\n\n" +
      "COLOR ANALYSIS (as a colorist" + (frame ? ", from the attached frame" : ", assume neutral if no frame") + "):\n" +
      "- temperature: is the footage's white balance warm, neutral, or cool?\n" +
      "- exposure: is it dark, balanced, or bright?\n" +
      "(The render will adapt the cinematic grade to this so the look is applied correctly instead of blindly.)\n\n" +
      "THE TITLE IS TWO LINES, and they do different jobs:\n" +
      "- \"title\": the video TYPE, as a label. 2-4 words, no punctuation. 'DAILY VLOG', 'MIAMI TRIP', 'STUDIO DAY', 'GRWM'. It is set in a heavy display face and always shown in capitals, so keep it short — a long one shrinks to fit and loses its impact.\n" +
      "- \"subtitle\": what this particular video is ABOUT, in the person's own register. 3-8 words, sentence case, no full stop. 'life as an entrepreneur', 'the day everything went wrong', 'how I actually plan my week'.\n" +
      "Together they read as a label over a line: DAILY VLOG / life as an entrepreneur. Do not repeat the type inside the subtitle.\n\n" +
      "Respond with ONLY this JSON, nothing else:\n" +
      ((SPEC.chapters && SPEC.broll)
        ? '{"keep":[{"s":number,"e":number}],"title":"string","subtitle":"string","chapters":[{"s":number,"label":"string"}],"broll":[{"s":number,"prompt":"string"}],"music":{"prompt":"string"},"look":{"temperature":"warm|neutral|cool","exposure":"dark|balanced|bright"}}\n\n'
        : SPEC.chapters
        ? '{"keep":[{"s":number,"e":number}],"title":"string","subtitle":"string","chapters":[{"s":number,"label":"string"}],"music":{"prompt":"string"},"look":{"temperature":"warm|neutral|cool","exposure":"dark|balanced|bright"}}\n\n'
        : '{"keep":[{"s":number,"e":number}],"title":"string","subtitle":"string","music":{"prompt":"string"},"look":{"temperature":"warm|neutral|cool","exposure":"dark|balanced|bright"}}\n\n') +
      // EFFECT PLACEMENT, BY THE PLANNER, FROM WHAT IS BEING SAID.
      //
      // These effects used to be assigned by POSITION — every fourth cut, every fifth
      // cut — which means nothing knows what is in the shot. A speed ramp landed on
      // whichever shot happened to be fourth rather than on the kitchen reveal that
      // earns it. That is decoration, not editing, and it reads as random because it is.
      //
      // The planner cannot see the footage, but it can read the words, and for these two
      // styles the words say what is on screen: "quartz countertops" means the next shot
      // is a countertop. So the planner places the effects and the renderer stops
      // guessing. Where the words say nothing, no effect — silence is the correct answer.
      // FASHION'S SPEED, CHOSEN FROM THE PICTURES.
      //
      // This used to fire on every ninth shot regardless of what was in it, which is the
      // same blind placement that made the other styles feel arbitrary. Fashion can see
      // the footage now, so the moment worth holding is a thing it can actually judge:
      // the turn, the flare of a hem, the moment a look lands.
      //
      // Only speed. Fashion's other effects — the burns, the grain, the echo — are
      // TEXTURE rather than commentary. They are not about anything, so spacing them
      // evenly is right, the way a film lab would.
      ((style === "fashion")
        ? ("\nALSO RETURN \"fx\": the moments worth slowing down. AT MOST THREE IN THE WHOLE FILM, and two is usually better.\n" +
           "- at: the second on the ORIGINAL timeline. It must be inside a segment you kept.\n" +
           "- effect: \"slowmo\" for a held half-speed shot, or \"ramp\" for a shot that rushes in and settles.\n" +
           "- USE THE FRAMES. Slow the moment that is worth looking at longer — a turn, a hem or a coat opening out, the moment the whole outfit reads, a piece of movement that is genuinely beautiful. Not merely the moment with the most motion in it: the activity track already found those and most of them are not worth holding.\n" +
           "- ramp suits an entrance or a reveal; slowmo suits the peak of a movement.\n" +
           "- Return an empty list if nothing in this footage deserves it. Most footage does not, and slowing an ordinary moment makes it look longer rather than better.\n\n")
        : "") +
      ((style === "entrepreneur" || style === "realestate")
        ? ("\nALSO RETURN \"fx\": where the transitions go. AT MOST ONE PER FIVE SECONDS OF FINISHED VIDEO, and fewer is better.\n" +
           "- at: the second on the ORIGINAL timeline. It must be the START of something you kept, because a transition belongs at a cut, not in the middle of a shot.\n" +
           "- effect: exactly one of " + (style === "realestate"
              ? "\"roll\" | \"push\" | \"flash\" | \"slowmo\""
              : "\"whip\" | \"push\" | \"flash\" | \"drain\" | \"echo\"") + ".\n" +
           (style === "realestate"
             ? "- roll: the camera turning. Use it MOVING BETWEEN SPACES — outside to inside, one room to the next, through a doorway. The reference rolls clockwise on the driveway and resolves inside the living room.\n" +
               "- push: a fast push with blur. Use it ARRIVING somewhere — landing in a room, or coming to rest on a detail like a tap, a range, a pendant light.\n" +
               "- flash: a bright exposure ramp. Use it ONLY where the picture crosses between interior and exterior, either direction. The brightness genuinely changes there, so it reads as the light rather than as an effect.\n" +
               "- slowmo: the single best-looking frame in the whole tour — the pool, the view, the main living space. Once, at most twice.\n"
             : "- whip: a fast blurred camera snap. Use it where the argument turns — a but, a however, a contradiction.\n" +
               "- push: a fast push with blur. Use it arriving at the most important claim in a sentence.\n" +
               "- flash: a bright exposure ramp. Use it on the hardest break between two ideas.\n" +
               "- drain: colour draining to black and white. Use it leaving a sombre or negative idea.\n" +
               "- echo: a ghosted trail of the subject. Striking and expensive-looking; use it ONCE in the whole film, on the biggest moment.\n") +
           (style === "realestate"
             ? "- THE PICTURES DECIDE. Look at what CHANGES between one shot and the next: a different room, a doorway, inside to outside, ground level to aerial, a wide to a detail. Those changes are where a transition belongs, and you can see every one of them in the frames.\n" +
               "- AN EFFECT NAMES A SHOT, NOT A MOMENT IN TIME. Set `at` to the EXACT start second of the kept segment the effect plays on — copy the number from your own keep list, do not estimate it. An effect a fraction of a second off lands on the shot before or after and decorates the wrong thing.\n" +
               "- CHOOSE THE EFFECT FROM WHAT THAT SHOT SHOWS. A roll where the camera turns into a new space. A push where it arrives and settles on a detail. A flash ONLY where the picture genuinely crosses between interior and exterior. Slowmo on the single best-looking shot in the tour.\n" +
               "- If the effect does not match what is visible in that exact shot, leave it out. A push on a static wall, or a flash on two indoor shots, reads as a fault rather than a flourish — worse than a plain cut.\n" +
               "- A one minute tour should carry FOUR to EIGHT of these. Returning none means you have not looked at the frames — every property tour moves between spaces, and that is what these mark.\n" +
               "- Still leave plenty of plain hard cuts. Within a run of shots of the same room, plain cuts are right.\n\n"
             : "- THE WORDS DECIDE HERE. This is a person talking to camera, so the argument is the only structure there is. Place an effect where the speech gives you a reason — a turn, a contradiction, the line that matters — and nowhere else. A plain hard cut is the correct edit for most cuts.\n" +
               "- Return an empty list if nothing in this script earns one.\n\n"))
        : "") +
      // SOUND EFFECTS, appended for the styles that carry them.
      //
      // Asked for HERE rather than in a separate vision call, because this request
      // already has everything needed: the activity track says when something moved,
      // and a still frame says what the video looks like. A second model call to name
      // sounds would cost real money on every edit forever, for information already on
      // the table.
      //
      // Times are on the ORIGINAL timeline, like `keep` and `chapters`, and get remapped
      // to the finished edit downstream. Six is a hard ceiling: the fashion reference
      // uses a handful of accents across a whole film, and a sound on every movement
      // stops reading as design and starts reading as a soundboard.
      ((style === "fashion" || style === "entrepreneur" || style === "realestate")
        ? ("\nALSO RETURN \"sfx\": up to 6 sound effects that land on real movement.\n" +
           "- at: the second on the ORIGINAL timeline where the sound should hit. It must fall INSIDE a segment you kept, or it will never be heard.\n" +
           "- sound: a short plain description of the sound that movement makes — \"fabric whoosh\", \"heel step on concrete\", \"door swinging open\". Five words at most. Describe the SOUND, not the picture.\n" +
           "- Pick the moments with the MOST movement" + (activityOn || style === "fashion" ? " using the activity track above" : "") + ". A sound over stillness is worse than silence.\n" +
           "- Never two closer than half a second apart. One gesture is one sound, not a burst.\n" +
           "- Return an empty list if nothing in this footage genuinely makes a sound. That is a normal answer.\n" +
           "- ALSO RETURN \"ambience\": one short description of the room tone this footage was shot in — \"quiet apartment room tone\", \"busy city street\", \"echoing indoor pool\". This is a single continuous bed under the whole video, not an event. Empty string if the footage has no obvious sense of place.\n\n")
        : "") +
      // Appended rather than folded into the shapes above so it travels with whichever
      // style the person picked, instead of needing a fourth and fifth variant.
      (brollClips.length
        ? 'ALSO include this key in that same object: "brollPlace":[{"clip":number,"at":number,"s":number,"e":number}]\n\n'
        : "") +
      "TRANSCRIPT:\n" + lines;

    const parts = [];
    if (frame) {
      const m = frame.match(/^data:(.*?);base64,(.*)$/);
      if (m) parts.push({ inlineData: { mimeType: m[1] || "image/jpeg", data: m[2] || "" } });
    }
    // A LABEL BEFORE EACH IMAGE. Without it the model sees a pile of pictures with no
    // way to say when any of them happened, which makes the timestamps it returns
    // guesses — and a keep range built on a guessed timestamp cuts the wrong moment.
    for (const f of frames) {
      const m = f.data.match(/^data:(.*?);base64,(.*)$/);
      if (!m) continue;
      parts.push({ text: "Frame at " + f.t.toFixed(1) + "s:" });
      parts.push({ inlineData: { mimeType: m[1] || "image/jpeg", data: m[2] || "" } });
    }
    parts.push({ text: prompt });

    // The same prompt, the same frame, the same JSON contract — only the engine
    // differs. That is what makes the two comparable instead of two pipelines.
    const runGemini = () => callGemini(GKEY, {
      contents: [{ parts }],
      // maxOutputTokens was never set, so this ran on the model default. A long video
      // produces a lot of keep ranges, and a truncated response is unparseable JSON —
      // which surfaces as "couldn't produce a valid plan" rather than as a length
      // problem. Set explicitly so the ceiling is visible and matches Claude's 8000.
      // 32768, up from 8192. THIS WAS SILENTLY DELETING EVERY TRANSITION.
      //
      // A property tour asks for 25-35 keep segments, then 4-8 fx, then up to 6 sfx,
      // then ambience — in that order. 8192 tokens covered the keep array and ran out
      // partway through what followed. The response then failed to parse, the salvage
      // path below recovered `keep` and nothing else, and the edit rendered with no
      // effects at all. No error, because from the renderer's side an empty fx list is
      // indistinguishable from a film that wanted none.
      //
      // The ceiling was set to 8192 to match Claude's, which is a reason to make them
      // agree, not a reason to keep a number that truncates the styles that need the
      // most output.
      generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 32768 }
    });
    const runClaude = () => {
      const content = [];
      if (frame) {
        const m = frame.match(/^data:(.*?);base64,(.*)$/);
        if (m) content.push({ type: "image", source: { type: "base64", media_type: m[1] || "image/jpeg", data: m[2] || "" } });
      }
      for (const f of frames) {
        const m = f.data.match(/^data:(.*?);base64,(.*)$/);
        if (!m) continue;
        content.push({ type: "text", text: "Frame at " + f.t.toFixed(1) + "s:" });
        content.push({ type: "image", source: { type: "base64", media_type: m[1] || "image/jpeg", data: m[2] || "" } });
      }
      content.push({ type: "text", text: prompt });
      return callClaude(AKEY, {
        system: "You are planning a video edit. Reply with ONE JSON object and nothing else — no preamble, no explanation, no markdown fences.",
        content
      });
    };

    let plannedBy = engine;
    let g = engine === "claude" && AKEY ? await runClaude() : await runGemini();

    // Fall back rather than fail — but only to an engine that is actually wanted.
    //
    // The original intent was that a customer who has waited through an upload and a
    // transcription shouldn't lose the edit because one provider is having a bad ten
    // minutes. The catch: the fallback ran regardless of PLANNER_ENGINE, so setting
    // that to "gemini" only changed which engine went FIRST. A Gemini failure still
    // produced a Claude-planned edit, silently and with different cut behaviour.
    //
    // PLANNER_FALLBACK=off disables the second attempt entirely: one engine, and a
    // clean error if it fails, rather than an edit planned by something you turned off.
    const fallbackOff = (process.env.PLANNER_FALLBACK || "").trim().toLowerCase() === "off";
    if (!g.ok && !fallbackOff) {
      const other = plannedBy === "claude" ? "gemini" : "claude";
      const canFallBack = other === "gemini" ? !!GKEY : !!AKEY;
      if (canFallBack) {
        console.warn("[plan] " + plannedBy + " failed (" + g.error + ") — falling back to " + other);
        g = other === "gemini" ? await runGemini() : await runClaude();
        if (g.ok) plannedBy = other;
      }
    } else if (!g.ok) {
      console.warn("[plan] " + plannedBy + " failed (" + g.error + ") — fallback disabled, not retrying on the other engine");
    }
    if (!g.ok) {
      return res.status(502).json({ error: g.error });
    }
    // ── Parse, and when that fails, SAY WHY ──────────────────────────────────
    //
    // This used to discard the response and return "try again", which is the worst
    // possible signature: the one piece of evidence that would identify the cause is
    // thrown away, so every failure looks identical and none of them can be diagnosed.
    // The outage this morning cost a day to exactly this shape of silence.
    //
    // The overwhelmingly likely cause is TRUNCATION. Gemini runs with
    // responseMimeType application/json and maxOutputTokens 8192, so a long video
    // whose keep list overruns the budget returns valid JSON that simply stops
    // mid-array — unparseable, through no fault of the prompt.
    //
    // So: try the whole thing, then try to SALVAGE. A truncated keep array still
    // contains complete segments, and a slightly short edit beats no edit at all.
    let plan;
    const raw = (g.text || "").replace(/```json|```/g, "").trim();
    try {
      plan = JSON.parse(raw);
    } catch (e) {
      const looksTruncated = raw.length > 200 && !/[}\]]\s*$/.test(raw);
      console.warn("[plan] " + plannedBy + " returned unparseable JSON — " + raw.length +
                   " chars, truncated=" + looksTruncated + ", parse error: " + (e && e.message));
      console.warn("[plan] response HEAD: " + raw.slice(0, 300));
      console.warn("[plan] response TAIL: " + raw.slice(-300));

      // Salvage: pull every COMPLETE object out of the keep array by brace matching.
      // Regex cannot do this reliably; a depth counter can.
      const salvaged = [];
      const k = raw.indexOf('"keep"');
      if (k >= 0) {
        let depth = 0, start = -1;
        for (let i = raw.indexOf("[", k); i >= 0 && i < raw.length; i++) {
          const ch = raw[i];
          if (ch === "{") { if (!depth) start = i; depth++; }
          else if (ch === "}") {
            depth--;
            if (!depth && start >= 0) {
              try { salvaged.push(JSON.parse(raw.slice(start, i + 1))); } catch {}
              start = -1;
            }
          }
        }
      }

      // Four is the floor. Fewer than that is not a short edit, it is a broken one,
      // and shipping it would look like the tool ignored most of the footage.
      if (salvaged.length >= 4) {
        console.warn("[plan] salvaged " + salvaged.length + " segments from the truncated response");
        // SALVAGE THE REST OF THE PLAN TOO, not just the cuts.
        //
        // Recovering only `keep` is why a truncated response produced a technically
        // fine edit with every transition missing. If the arrays that follow it are
        // complete — and on a mild truncation they usually are — they are as usable
        // as the segments were.
        const grabArray = (key) => {
          const at = raw.indexOf('"' + key + '"');
          if (at < 0) return null;
          const open = raw.indexOf("[", at);
          if (open < 0) return null;
          let depth = 0;
          for (let i = open; i < raw.length; i++) {
            if (raw[i] === "[") depth++;
            else if (raw[i] === "]") { depth--; if (!depth) { try { return JSON.parse(raw.slice(open, i + 1)); } catch { return null; } } }
          }
          return null;   // never closed — this is where truncation landed
        };
        const sFx = grabArray("fx"), sCards = grabArray("chapters"), sSfx = grabArray("sfx");
        console.warn("[plan] salvage recovered: keep " + salvaged.length +
                     ", fx " + (sFx ? sFx.length : "LOST") +
                     ", chapters " + (sCards ? sCards.length : "LOST") +
                     ", sfx " + (sSfx ? sSfx.length : "LOST"));
        plan = { keep: salvaged, salvaged: true };
        if (sFx) plan.fx = sFx;
        if (sCards) plan.chapters = sCards;
        if (sSfx) plan.sfx = sSfx;
      } else {
        return res.status(502).json({
          error: looksTruncated
            ? "The editor ran out of room part-way through planning this edit. Try a shorter video, or split it in two."
            : "The editor couldn't produce a valid plan. Please try again."
        });
      }
    }

    // ── Sanitize: clamp, order, merge, drop invalid ──
    let keep = Array.isArray(plan.keep) ? plan.keep : [];
    keep = keep
      .map(k => ({ s: Math.max(0, Number(k.s) || 0), e: Math.min(duration || 1e9, Number(k.e) || 0) }))
      // MINIMUM SEGMENT LENGTH, PER STYLE.
      //
      // A flat 0.8s floor here silently deleted most of a property tour. The prompt for
      // that style asks for montage shots of half a second to two seconds; anything
      // under 0.8 was then dropped before it reached the timeline, so the model did
      // exactly as instructed and had most of its work thrown away. The finished edit
      // came back a few seconds long with whole rooms missing, and nothing anywhere
      // said a segment had been discarded.
      //
      // The floor exists for a real reason on speech styles — a 0.3s fragment of a
      // sentence is a glitch, not a cut. It just has no business applying to a silent
      // montage, where a short shot IS the format.
      .filter(k => k.e - k.s >= ((style === "realestate" || style === "fashion") ? 0.3 : 0.8))
      .sort((a, b) => a.s - b.s);
    // Fashion merges almost nothing: 0.12s. The whole style IS the cut rate, and a
    // merge gap that tidies away short gaps would quietly undo it - two 0.4s segments
    // 0.3s apart becoming one 1.1s segment is the format collapsing into the thing it
    // was trying not to be.
    // realestate needs the widest gap of any speech style: its montage blocks are
    // silent by design and must survive as kept footage rather than being closed up.
    // realestate was 1.2s, chosen when the style alternated a presenter with silent
    // stretches — a wide gap kept those silences as footage instead of closing them up.
    // With the presenter gone the style is a pure montage, and a wide gap now does the
    // damage it was avoiding: two distinct 0.8s shots a second apart become one 2.6s
    // block, the cut rate collapses, and every transition timestamp that pointed at the
    // second shot's start now lands mid-block. Same reasoning as fashion, same number.
    const mergeGap = style === "fashion" ? 0.12 : style === "vlog" ? 4.0 : style === "realestate" ? 0.15 : style === "process" ? 1.5 : style === "tutorial" ? 1.0 : style === "entrepreneur" ? 0.8 : style === "cinematic" ? 0.4 : 0.3; // vlogs bridge visual moments; tutorials breathe; cinematic and talking-head cut tight
    // A gap between two kept ranges means one of two completely different things,
    // and merging on time alone treated them identically:
    //
    //   SILENT gap — the person paused, walked, showed something. Bridge it. That is
    //                what mergeGap is for, and why a vlog's is as high as 4s.
    //   SPOKEN gap — the planner deliberately cut something: a filler word, a false
    //                start, a repeated take. Bridging it puts the mistake BACK in.
    //
    // On a vlog that meant every cut shorter than four seconds was re-inserted, which
    // is nearly every false start there is. The prompt asks for them to be removed in
    // every style; this was quietly undoing the work. A gap is now only bridged when
    // no words fall inside it.
    const gapHasSpeech = (from, to) =>
      words.some(w => {
        const ws = Number(w && w.s);
        return Number.isFinite(ws) && ws >= from - 0.02 && ws < to + 0.02;
      });
    const merged = [];
    for (const k of keep) {
      const last = merged[merged.length - 1];
      if (last && k.s - last.e < mergeGap && !gapHasSpeech(last.e, k.s)) last.e = Math.max(last.e, k.e);
      else merged.push({ ...k });
    }
    if (!merged.length) merged.push({ s: 0, e: Math.max(1, duration) }); // fallback: keep everything

    const title = (typeof plan.title === "string" ? plan.title : "").slice(0, 60);
    const outSeconds = Math.round(merged.reduce((t, k) => t + (k.e - k.s), 0) * 10) / 10;

    // Sanitize the colorist classification to allowed values only.
    const L = plan.look || {};
    const look = {
      temperature: ["warm","neutral","cool"].includes(L.temperature) ? L.temperature : "neutral",
      exposure: ["dark","balanced","bright"].includes(L.exposure) ? L.exposure : "balanced"
    };

    // Sanitize chapters (tutorial only): valid times, short labels, max 6.
    let chapters = [];
    // Planner-placed transitions. Vocabulary is closed — an effect name the renderer
    // does not know would silently do nothing, which looks identical to the planner
    // having chosen nothing.
    {
      const FX_OK = SPEC.fx || [];
      const rawFxCount = Array.isArray(plan.fx) ? plan.fx.length : 0;
      // Fashion cuts every few tenths of a second, so a per-five-seconds cap would allow
      // dozens. Three in a whole film is the point of the effect.
      const cap = style === "fashion" ? 3 : Math.max(1, Math.round(duration / 5));
      const seen = [];
      plan.fx = (Array.isArray(plan.fx) ? plan.fx : [])
        .map((x) => ({ at: Number(x && x.at), effect: String((x && x.effect) || "").trim().toLowerCase() }))
        .filter((x) => Number.isFinite(x.at) && x.at >= 0 && x.at <= duration && FX_OK.includes(x.effect))
        .sort((a, b) => a.at - b.at)
        // Two transitions within a second of each other is the stacking that made this
        // chaotic in the first place.
        .filter((x) => {
          const gap = style === "fashion" ? 3.0 : 1.0;
          if (seen.some((t) => Math.abs(t - x.at) < gap)) return false;
          seen.push(x.at);
          return true;
        })
        .slice(0, cap);
      // echo and slowmo are once-per-film effects. The prompt says so; this enforces it.
      let usedEcho = false, usedSlow = false;
      plan.fx = plan.fx.filter((x) => {
        if (x.effect === "echo") { if (usedEcho) return false; usedEcho = true; }
        if (x.effect === "slowmo") { if (usedSlow) return false; usedSlow = true; }
        return true;
      });
      // WHAT THE MODEL ASKED FOR vs WHAT SURVIVED.
      //
      // Effects have gone missing three separate times and each investigation stalled
      // at the same question: did the planner return none, or did something downstream
      // discard them? Nothing logged either number, so every answer was a guess. This
      // line costs nothing and ends that: `raw` is what came back from the model,
      // `kept` is what leaves here. Both zero means the prompt; raw high and kept zero
      // means this validator; both high and nothing on screen means the renderer.
      console.log("[plan] " + style + " fx: raw " + rawFxCount + ", kept " + plan.fx.length +
                  (plan.fx.length ? " (" + plan.fx.map((x) => x.effect + "@" + x.at).join(", ") + ")" : ""));
    }

    // Sound effects. Clamped, de-duplicated by proximity, capped, and dropped entirely
    // if they fall outside the footage — a sound at a timestamp that was cut is charged
    // for and never heard.
    if (Array.isArray(plan.sfx)) {
      const seen = [];
      plan.sfx = plan.sfx
        .map((x) => ({
          at: Number(x && x.at),
          sound: String((x && x.sound) || "").trim().slice(0, 60),
        }))
        .filter((x) => Number.isFinite(x.at) && x.at >= 0 && x.at <= duration && x.sound.length > 2)
        .sort((a, b) => a.at - b.at)
        .filter((x) => {
          if (seen.some((t) => Math.abs(t - x.at) < 0.5)) return false;
          seen.push(x.at);
          return true;
        })
        .slice(0, 6);
    } else {
      plan.sfx = [];
    }
    plan.ambience = String(plan.ambience || "").trim().slice(0, 80);

    // Chapters are TITLE CARDS on screen. Property and founder were getting them
    // because this said "anything but talking head", written before either existed.
    if (SPEC.chapters && Array.isArray(plan.chapters)) {
      chapters = plan.chapters
        .map(c => ({ s: Math.max(0, Number(c.s) || 0), label: String(c.label || "").trim().slice(0, 40) }))
        .filter(c => c.label && c.s < (duration || 1e9))
        .sort((a, b) => a.s - b.s)
        .slice(0, 6);
    }

    // Sanitize b-roll (cinematic only): valid times, real prompts, max 4.
    let broll = [];
    if (!SPEC.chapters) plan.chapters = [];
    if (SPEC.broll && Array.isArray(plan.broll)) {
      broll = plan.broll
        .map(b => ({ s: Math.max(0, Number(b.s) || 0), prompt: String(b.prompt || "").trim().slice(0, 300) }))
        .filter(b => b.prompt && b.s < (duration || 1e9))
        .sort((a, b) => a.s - b.s)
        .slice(0, style === "process" ? 3 : style === "tutorial" ? 2 : 4);
    }

    // Sanitize the person's OWN b-roll placements. Checked against the manifest that was
    // actually sent, not merely for well-formedness: `clip` becomes a source index on the
    // render box, so a hallucinated number must never survive. One placement per clip —
    // the same shot appearing twice reads as a glitch, and the model does occasionally
    // repeat a favourite. First placement wins.
    let brollPlace = [];
    if (brollClips.length && Array.isArray(plan.brollPlace)) {
      const byClip = new Map(brollClips.map(b => [b.clip, b]));
      const used = new Set();
      brollPlace = plan.brollPlace
        .map(p => {
          const clip = Math.floor(Number(p && p.clip));
          const src = byClip.get(clip);
          if (!src || used.has(clip)) return null;
          const s = Math.max(0, Number(p.s) || 0);
          // Clamped to the clip's REAL duration. The model only knows the length we told
          // it, and asking ffmpeg to seek past the end of a file yields an empty segment.
          const e = Math.min(src.dur, Number(p.e) || 0);
          const at = Number(p.at);
          if (!(e - s >= 0.5) || !Number.isFinite(at) || at < 0) return null;
          used.add(clip);
          return { clip, at: Math.round(at * 100) / 100, s: Math.round(s * 100) / 100, e: Math.round(e * 100) / 100 };
        })
        .filter(Boolean)
        .sort((a, b) => a.at - b.at)
        .slice(0, 20);
    }

    // The music brief. Free to ask for on every style — the model is already reading
    // the transcript, so this costs nothing extra and the app simply ignores it when
    // the customer left music switched off. Length-capped like every other model
    // string that goes on to a paid API call.
    const music = {
      prompt: String((plan.music && plan.music.prompt) || "").trim().slice(0, 400)
    };

    console.log("[plan] " + style + " planned by " + plannedBy + " — " + merged.length + " segment(s), " + outSeconds + "s");
    // Same treatment as the title: trimmed, length-capped, and never allowed to be
    // the string "null" or similar rubbish the model sometimes emits.
    const subtitle = String((plan.subtitle == null ? "" : plan.subtitle)).trim().slice(0, 120);
    return res.status(200).json({ keep: merged, title, subtitle, chapters, broll, brollPlace, music, look, outSeconds, plannedBy, truncated, wordsSeen: Math.min(words.length, WORD_LIMIT), wordsTotal: words.length });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
