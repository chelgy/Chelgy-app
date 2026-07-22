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
// The response reports which engine actually planned the edit, so a fallback is
// visible rather than silent.
//
// Env: ANTHROPIC_API_KEY, GEMINI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY
//      optional: PLANNER_ENGINE ("claude" | "gemini"), PLANNER_MODEL

export const maxDuration = 60;

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
          model: CLAUDE_MODEL,
          max_tokens: 8000,
          temperature: 0.2,
          system,
          messages: [
            { role: "user", content },
            { role: "assistant", content: "{" }
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
      // Put back the brace the prefill consumed.
      return { ok: true, text: "{" + text };
    } catch (e) {
      lastErr = (e && e.message) || "Network error contacting the editor.";
      await sleep(1200 * (i + 1));
    }
  }
  return { ok: false, error: lastErr };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const words = Array.isArray(body.words) ? body.words : [];
    const duration = Number(body.duration) || 0;
    const frame = typeof body.frame === "string" ? body.frame : null; // small JPEG data URL of one frame
    const style = ["vlog","tutorial","cinematic","process"].includes(body.style) ? body.style : "talkinghead";
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
    // A process video can be almost entirely silent, so it is the one style that may
    // be planned with no transcript at all.
    if (!words.length && style !== "process") return res.status(400).json({ error: "Missing transcript." });

    const GKEY = (process.env.GEMINI_API_KEY || "").trim();
    const AKEY = (process.env.ANTHROPIC_API_KEY || "").trim();
    const engine = (process.env.PLANNER_ENGINE || "claude").trim().toLowerCase() === "gemini" ? "gemini" : "claude";
    // Only a total absence of BOTH is fatal. Either one on its own can plan an edit.
    if (!GKEY && !AKEY) return res.status(500).json({ error: "The editor is not configured." });

    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again." });

    // Compact word list: "word|start|end" per line (caps prompt size on long videos).
    const lines = words.slice(0, 4000).map(w => w.w + "|" + w.s + "|" + w.e).join("\n");

    const editorRole = style === "vlog"
      ? "You are a professional video editor AND colorist cutting a VLOG (real-world, day-in-the-life footage where the person talks while moving through places)."
      : style === "tutorial"
      ? "You are a professional video editor AND colorist cutting a TUTORIAL (one person teaching, sit-down, possibly with a screen). Clarity beats pace."
      : style === "process"
      ? "You are a professional video editor AND colorist cutting a PROCESS video — cooking, cleaning, a build, a craft, a get-ready-with-me. Someone is DOING something, and the doing is the point. Long stretches have no talking at all and are the best material in the video, not gaps in it."
      : style === "cinematic"
      ? "You are a professional video editor AND colorist cutting a CINEMATIC STORYTELLING piece in the energy of a Scorsese picture — voiceover-driven, kinetic, confessional first-person. Momentum is everything."
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
    const processRules =
        "You have TWO tracks to cut from, and this is the whole job:\n" +
        "- The TRANSCRIPT below, as usual. This is the stronger of the two signals: if someone is talking, that moment matters.\n" +
        "- An ACTIVITY TRACK: one number per second of the video, 0 to 9, measured from the footage itself. 0 means genuinely nothing is moving — an empty counter, an abandoned tripod, someone out of frame. 4-6 is a person working within a fixed shot: hands chopping, wiping, folding, assembling. 7-9 is large movement — the camera moving, or something carried across the frame: hands working, something being assembled, chopped, wiped, folded, poured.\n" +
        "\n" +
        "THE RULE THAT MATTERS: silence is NOT dead air in this video. A silent stretch with HIGH activity is the most valuable footage there is — it is the actual work being done, and it must be KEPT even though nobody is speaking over it. A silent stretch with activity at or near 0 is genuinely dead and should go.\n" +
        "\n" +
        "- KEEP: anything with activity 4 or above, talking or not. This is the process itself.\n" +
        "- KEEP: talking, on the usual terms — cut filler, false starts, repeated takes.\n" +
        "- CUT: silence where activity is 0-1 for more than ~2s. Nothing is happening and nobody is talking.\n" +
        "- NEVER cut a segment just because activity is low while the person is TALKING. Speech is proof that something is happening even when the picture is still — a locked-off camera on someone explaining a step is exactly what this style is for. Talking is only ever cut on the usual grounds: filler words, false starts, a repeated take.\n" +
        "- COMPRESS, don't delete, repetitive work. Thirty seconds of continuous chopping at activity 6 does not need to survive whole — keep 6-10 seconds of it and move on. The viewer needs to see that it happened, not watch all of it.\n" +
        "- Never cut mid-word. Start keeps ~0.15s before the first word, end ~0.3s after the last.\n" +
        "- Merge keeps less than 1.5s apart. No kept segment shorter than 1s.\n" +
        "- ALSO identify 2-6 SCENE INTROS at real stage changes in the process — 'Prepping The Base', 'Into The Oven', 'The Messy Part', 'Finishing Touches'. 2-5 words, title case. NEVER the word Chapter. Give each start time in seconds on the ORIGINAL timeline.\n" +
        "- ALSO identify 0-3 B-ROLL moments where a full-screen photograph would help — an ingredient, a finished result, a tool being referenced. Same neutral photographic brief as always, no grading language.\n";

    // Belt and braces: if the track never arrived, do not run the process rules.
    // They instruct the model to cut silence with low activity, and with no track to
    // read that becomes "cut all silence" — which is the whole video in a cooking or
    // cleaning edit. Fall back to vlog behaviour, which protects quiet moments.
    const processUsable = style === "process" && activity && activity.length;
    const cutRules = processUsable ? processRules : style === "cinematic" ? cinematicRules : style === "tutorial" ? tutorialRules : style === "vlog"
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
         "- Be decisive: a tight talking-head cut usually keeps 65-85% of a well-delivered video, less if it's rambly. When in doubt between leaving a pause and cutting it, CUT it.\n");

    const prompt =
      editorRole + "\n" +
      (directorNote
        ? ("\n=== THE CREATOR'S OWN DIRECTION FOR THIS VIDEO ===\n" +
           "The person who shot this told you exactly how they want it edited. This is the single most important input you have. Follow it wherever it's specific, and let it OVERRIDE the general style rules below whenever the two disagree — if they say keep something the rules would cut, keep it; if they say cut something the rules would keep, cut it; if they name a title or a mood or where b-roll should go, do that. Only fall back to the general rules for anything their direction doesn't cover.\n" +
           "Their direction:\n\"" + directorNote + "\"\n" +
           "=== END OF THE CREATOR'S DIRECTION ===\n\n")
        : "") +
      "Below is the transcript as word|startSeconds|endSeconds lines. Total length: " + duration + "s.\n" +
      (frame ? "A still frame from the footage is attached — use it ONLY for the color analysis below.\n" : "") +
      (activity && activity.length
        ? ("\nACTIVITY TRACK — one value per second, second 0 first, 0 = nothing moving, 9 = a lot:\n" +
           activity.join(",") + "\n")
        : "") +
      "\n" + cutRules +
      "- Segments must be in chronological order, non-overlapping, within 0.." + duration + ".\n\n" +
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
      "Respond with ONLY this JSON, nothing else:\n" +
      ((style === "cinematic" || style === "process")
        ? '{"keep":[{"s":number,"e":number}],"title":"string","chapters":[{"s":number,"label":"string"}],"broll":[{"s":number,"prompt":"string"}],"music":{"prompt":"string"},"look":{"temperature":"warm|neutral|cool","exposure":"dark|balanced|bright"}}\n\n'
        : style !== "talkinghead"
        ? '{"keep":[{"s":number,"e":number}],"title":"string","chapters":[{"s":number,"label":"string"}],"music":{"prompt":"string"},"look":{"temperature":"warm|neutral|cool","exposure":"dark|balanced|bright"}}\n\n'
        : '{"keep":[{"s":number,"e":number}],"title":"string","music":{"prompt":"string"},"look":{"temperature":"warm|neutral|cool","exposure":"dark|balanced|bright"}}\n\n') +
      "TRANSCRIPT:\n" + lines;

    const parts = [];
    if (frame) {
      const m = frame.match(/^data:(.*?);base64,(.*)$/);
      if (m) parts.push({ inlineData: { mimeType: m[1] || "image/jpeg", data: m[2] || "" } });
    }
    parts.push({ text: prompt });

    // The same prompt, the same frame, the same JSON contract — only the engine
    // differs. That is what makes the two comparable instead of two pipelines.
    const runGemini = () => callGemini(GKEY, {
      contents: [{ parts }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
    });
    const runClaude = () => {
      const content = [];
      if (frame) {
        const m = frame.match(/^data:(.*?);base64,(.*)$/);
        if (m) content.push({ type: "image", source: { type: "base64", media_type: m[1] || "image/jpeg", data: m[2] || "" } });
      }
      content.push({ type: "text", text: prompt });
      return callClaude(AKEY, {
        system: "You are planning a video edit. Reply with ONE JSON object and nothing else — no preamble, no explanation, no markdown fences.",
        content
      });
    };

    let plannedBy = engine;
    let g = engine === "claude" && AKEY ? await runClaude() : await runGemini();

    // Fall back rather than fail. A customer who has waited through an upload and a
    // transcription should not lose the edit because one provider is having a bad
    // ten minutes. Which engine actually ran is reported back, so a fallback shows up
    // instead of quietly changing how the edits look.
    if (!g.ok) {
      const other = plannedBy === "claude" ? "gemini" : "claude";
      const canFallBack = other === "gemini" ? !!GKEY : !!AKEY;
      if (canFallBack) {
        console.warn("[plan] " + plannedBy + " failed (" + g.error + ") — falling back to " + other);
        g = other === "gemini" ? await runGemini() : await runClaude();
        if (g.ok) plannedBy = other;
      }
    }
    if (!g.ok) {
      return res.status(502).json({ error: g.error });
    }
    let plan;
    try { plan = JSON.parse((g.text || "").replace(/```json|```/g, "").trim()); } catch {
      return res.status(502).json({ error: "The editor couldn't produce a valid plan. Please try again." });
    }

    // ── Sanitize: clamp, order, merge, drop invalid ──
    let keep = Array.isArray(plan.keep) ? plan.keep : [];
    keep = keep
      .map(k => ({ s: Math.max(0, Number(k.s) || 0), e: Math.min(duration || 1e9, Number(k.e) || 0) }))
      .filter(k => k.e - k.s >= 0.8)
      .sort((a, b) => a.s - b.s);
    const mergeGap = style === "vlog" ? 4.0 : style === "process" ? 1.5 : style === "tutorial" ? 1.0 : style === "cinematic" ? 0.4 : 0.3; // vlogs bridge visual moments; tutorials breathe; cinematic and talking-head cut tight
    const merged = [];
    for (const k of keep) {
      const last = merged[merged.length - 1];
      if (last && k.s - last.e < mergeGap) last.e = Math.max(last.e, k.e);
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
    if (style !== "talkinghead" && Array.isArray(plan.chapters)) {
      chapters = plan.chapters
        .map(c => ({ s: Math.max(0, Number(c.s) || 0), label: String(c.label || "").trim().slice(0, 40) }))
        .filter(c => c.label && c.s < (duration || 1e9))
        .sort((a, b) => a.s - b.s)
        .slice(0, 6);
    }

    // Sanitize b-roll (cinematic only): valid times, real prompts, max 4.
    let broll = [];
    if ((style === "cinematic" || style === "process") && Array.isArray(plan.broll)) {
      broll = plan.broll
        .map(b => ({ s: Math.max(0, Number(b.s) || 0), prompt: String(b.prompt || "").trim().slice(0, 300) }))
        .filter(b => b.prompt && b.s < (duration || 1e9))
        .sort((a, b) => a.s - b.s)
        .slice(0, style === "process" ? 3 : 4);
    }

    // The music brief. Free to ask for on every style — the model is already reading
    // the transcript, so this costs nothing extra and the app simply ignores it when
    // the customer left music switched off. Length-capped like every other model
    // string that goes on to a paid API call.
    const music = {
      prompt: String((plan.music && plan.music.prompt) || "").trim().slice(0, 400)
    };

    console.log("[plan] " + style + " planned by " + plannedBy + " — " + merged.length + " segment(s), " + outSeconds + "s");
    return res.status(200).json({ keep: merged, title, chapters, broll, music, look, outSeconds, plannedBy });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
