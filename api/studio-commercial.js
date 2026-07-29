// Chelgy — plan a commercial, shot by shot, in prompts Seedance can actually shoot.
//
// This is not the storyboard tool. That one plans a shoot for a person holding a
// camera; this one writes the instructions a video model will execute. The difference
// matters: a human reads "she looks pleased with the result" and knows what to do, and
// a video model needs to be told what is in frame, what moves, and what the light is
// doing, in one self-contained paragraph with no memory of the shot before it.
//
// TWO FORMATS, AND THEY ARE GENUINELY DIFFERENT FILMS
//
// CONTINUOUS — one person, one place, one thread. Every shot has to match the last,
// which is the hard mode for any video model: each clip is generated independently, so
// left alone you get a different face and a different room every time. Held together
// by a locked description repeated verbatim in every shot, and by chaining the last
// frame of each clip into the next.
//
// ANTHOLOGY — deliberately different people, places and moments, tied together by one
// idea and one grade. "Mine's the long-lasting wear," said while jumping out of a
// helicopter. This is the format where the model's weakness becomes the point: variety
// is what it does effortlessly and what the form actually wants. It is also cheaper to
// get right, because nothing has to match anything.
//
// WHY THE SHOT COUNT IS LOW
// Seedance takes 4-15 seconds per generation and can hold several beats inside one
// clip. Ten five-second generations produce ten seams and ten chances to drift; four
// twelve-second ones produce three seams and are internally consistent because one pass
// made each. Longer, fewer clips is the right shape.
//
// Env: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY

export const maxDuration = 120;

const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();

async function getUserId(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, Authorization: "Bearer " + token } });
    const u = await r.json();
    return r.ok && u && u.id ? u.id : null;
  } catch { return null; }
}

// WHO WRITES THE COMMERCIAL
//
// GPT first, Gemini as a fallback. Not a coin toss: this prompt asks for dense visual
// description — what is in frame, what the light is doing, how the camera moves — and
// GPT writes that with more specificity, while Gemini tends toward summary. The same
// difference showed up in Style Match and the thumbnail re-shoot, and the same answer
// applies. Every other planner in this app stays on Gemini, which is cheaper and
// perfectly good at structure; this one is judged on prose.
//
// The fallback is not decoration. It is one model, one API, one bad afternoon away
// from a tool that does nothing, and the Gemini path below is known to work.
//
// OPENAI_MODEL lets the model be changed without a deploy — these names move faster
// than release cycles do.
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4.1").trim();

async function callOpenAI(prompt) {
  const key = (process.env.OPENAI_API_KEY || "").trim();
  if (!key) return { ok: false, error: "no key" };
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: "You write prompts for a video generation model. You are specific and visual: concrete nouns, real light, named camera moves. You never summarise when you could describe. You reply with JSON and nothing else." },
          { role: "user", content: prompt }
        ],
        response_format: { type: "json_object" },
        temperature: 0.9,
        max_tokens: 4000
      })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: (d && d.error && d.error.message) || ("OpenAI " + r.status) };
    const text = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    if (!text) return { ok: false, error: "empty" };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: (e && e.message) || "network" };
  }
}

const GEMINI_PRIMARY = "gemini-flash-latest";
const GEMINI_FALLBACK = "gemini-3.1-flash-lite";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callGemini(GKEY, payload) {
  const models = [GEMINI_PRIMARY, GEMINI_PRIMARY, GEMINI_FALLBACK];
  let lastErr = "The writer is busy. Try again in a moment.";
  for (let i = 0; i < models.length; i++) {
    try {
      const gr = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + models[i] + ":generateContent",
        { method: "POST", headers: { "x-goog-api-key": GKEY, "Content-Type": "application/json" }, body: JSON.stringify(payload) }
      );
      const gdata = await gr.json().catch(() => ({}));
      if (!gr.ok) {
        lastErr = (gdata && gdata.error && gdata.error.message) || ("Model error " + gr.status);
        if (gr.status >= 500 || gr.status === 429) { await sleep(1200 * (i + 1)); continue; }
        return { ok: false, error: lastErr };
      }
      let text = "";
      try { text = gdata.candidates[0].content.parts[0].text; } catch {}
      if (!text) { await sleep(1200 * (i + 1)); continue; }
      return { ok: true, text };
    } catch (e) {
      lastErr = (e && e.message) || "Network error contacting the writer.";
      await sleep(1200 * (i + 1));
    }
  }
  return { ok: false, error: lastErr };
}

// Seedance takes 4-15s per generation. Cut the runtime into the FEWEST clips that fit,
// because every extra clip is another seam and another chance for the look to drift.
function planClipLengths(totalSec) {
  const total = Math.max(4, Math.min(60, Math.round(totalSec)));
  if (total <= 15) return [total];
  const n = Math.ceil(total / 15);
  const base = Math.floor(total / n);
  const out = new Array(n).fill(base);
  let spare = total - base * n;
  for (let i = 0; spare > 0; i = (i + 1) % n, spare--) out[i]++;
  return out.map(s => Math.max(4, Math.min(15, s)));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = req.body || {};
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please sign in again." });

    const GKEY = (process.env.GEMINI_API_KEY || "").trim();
    if (!GKEY) return res.status(500).json({ error: "The writer is not configured." });

    const brief    = String(body.brief || "").trim().slice(0, 1200);
    const format   = body.format === "anthology" ? "anthology" : body.format === "voiceover" ? "voiceover" : "continuous";
    const brand    = String(body.brand || "").trim().slice(0, 80);
    const look     = String(body.look || "").trim().slice(0, 300);
    const orientation = body.orientation === "landscape" ? "landscape" : body.orientation === "square" ? "square" : "portrait";
    const totalSec = Math.max(4, Math.min(60, Math.round(Number(body.totalSec) || 15)));
    const spoken   = body.spoken !== false;
    // What the product IS, in words. The photographs go to the image model; the planner
    // only needs to know something must appear and what to call it, so it can write the
    // product into the action rather than leaving it to be added afterwards.
    const product  = String(body.product || "").trim().slice(0, 200);
    // A revision: the plan they already have, plus what they want changed about it.
    // Sent together because "make the second one more upbeat" is meaningless without
    // the thing being revised, and re-planning from the brief alone throws away every
    // choice they were happy with.
    const revise   = String(body.revise || "").trim().slice(0, 600);
    const previous = body.previous && typeof body.previous === "object" ? body.previous : null;
    if (!brief) return res.status(400).json({ error: "Tell us what the commercial is about first." });

    const lengths = planClipLengths(totalSec);

    const shared =
      "You are writing prompts for Seedance, a video model that generates one clip at a time with synchronised audio and lip-sync.\n\n" +
      "THE COMMERCIAL: " + brief + "\n" +
      (brand ? "BRAND: " + brand + "\n" : "") +
      (look ? "LOOK THEY WANT: " + look + "\n" : "") +
      (/anima|cartoon|illustrat|3d|render|stylis|stylize|claymation|anime|paper|puppet/i.test(look)
        ? "They have asked for a NON-PHOTOREAL look. Follow what they asked for and ignore the live-action rule below.\n"
        : "") +
      (product
        ? "THE PRODUCT — it must physically appear: " + product + "\n" +
          "Put it in the action rather than on a shelf. Someone lifts it, opens it, uses it, sets it down. A product a person handles reads as real; a product placed in shot reads as an advert for one.\n"
        : "") +
      "TOTAL LENGTH: " + totalSec + " seconds, shot " + orientation + ".\n" +
      "IT WILL BE " + lengths.length + " CLIPS, of these lengths in order: " + lengths.join("s, ") + "s.\n\n" +
      "HOW TO WRITE A SHOT PROMPT — this is the part that decides whether it works:\n" +
      "- Each prompt is SELF-CONTAINED. The model has no memory of the other clips. Never write 'the same woman' or 'as before' — describe her again, fully, every time.\n" +
      "- Say what is in frame, what moves, where the camera is, and what the light is doing. Concrete nouns beat adjectives: 'low winter sun through a west-facing window' not 'beautiful lighting'.\n" +
      "- Name the shot size and any camera move in the prompt itself.\n" +
      ((spoken && format !== "voiceover")
        ? "- Seedance generates lip-synced speech. When someone talks, put the exact line in the prompt as spoken dialogue, in quotes, and say who says it and how.\n"
        : "- NO speech and no dialogue anywhere. These clips carry music and atmosphere only.\n") +
      "- A clip longer than about 8 seconds should contain more than one beat. Use 'Shot 1: ... Shot 2: ...' inside a single prompt to sequence them.\n" +
      "- LIVE ACTION, PHOTOREAL. Every clip is footage of real people and real places, shot on a real camera. Say so in the prompt: real human skin with pores and texture, natural imperfections, real fabric, real depth of field, the look of a camera rather than a render.\n" +
      "- Never write anything that pulls it toward animation: no 'stylised', no 'illustration', no 'render', no '3D', no 'vibrant colourful cartoon energy'. Words like that are why a clip comes back looking animated when nobody asked for it — the model reads enthusiasm as a style instruction.\n" +
      "- No text, captions, logos or writing anywhere in frame. Those are added afterwards and a model rendering them produces garbled letters.\n\n";

    const formatRules = format === "voiceover"
      ? "FORMAT — NARRATED. Pictures under one continuous voice.\n" +
        "- NOBODY SPEAKS ON CAMERA. No dialogue, no lip movement, no piece to camera. The clips carry action and atmosphere only.\n" +
        "- Write ONE continuous narration for the whole film, in the `narration` field, as a single block of prose. It is recorded as one take and laid over the finished cut, so it must read as one thought from beginning to end — not a line per clip.\n" +
        "- Pace it at roughly 2.6 words per second, so about " + Math.round(totalSec * 2.6) + " words for " + totalSec + " seconds. Under is fine; over gets cut off.\n" +
        "- Then write the clips as PICTURES THAT ILLUSTRATE IT, in order. Each clip's prompt should show what the narration is talking about at that moment without repeating it.\n" +
        "- Subjects and places may change between clips. What holds it together is the voice, so the visuals are free to travel.\n"
      : format === "continuous"
      ? "FORMAT — CONTINUOUS. One subject, one world, one thread running through it.\n" +
        "- Write a LOCKED DESCRIPTION: the subject's age, build, hair, clothing, and the place, in about 25 words. Reproduce it VERBATIM at the start of every single shot prompt. Not paraphrased — the same words. This is the only thing holding the person's face together across clips.\n" +
        "- The clips must run in order as one continuous piece of time. Each begins roughly where the last ended.\n" +
        "- CHOOSE THE SHAPE OF EACH CLIP YOURSELF. One clip can be a single unbroken take; another can cut two or three times within the same scene — a wide, then a close, then a detail. Both are one continuous piece of time; they just cut differently. Vary it rather than doing the same thing every clip.\n" +
        "- Where a clip cuts, structure it in one paragraph: 'Shot 1: [one action]. Hard cut to Shot 2: [one action].' One action per block — if three things happen, that is three blocks.\n"
      : "FORMAT — ANTHOLOGY. Deliberately different people, places and moments, held together by one idea.\n" +
        "- Every clip is a DIFFERENT person in a DIFFERENT place. Vary age, appearance and setting hard — that contrast is the whole idea of the film.\n" +
        // Several whole scenarios inside ONE generation, written the way the model
        // actually wants them. The rules below are not guesses — Seedance 2.0 renders
        // up to FIVE distinct camera setups, locations and characters per generation,
        // and the structure it responds to is specific:
        //
        //   · numbered markers, with "Hard cut to" between blocks
        //   · ONE action per block. Piling three actions into one block is the most
        //     common way these come back mushy — if three things happen, that is three
        //     blocks
        //   · a shared anchor across all of them. Here the cast deliberately changes,
        //     so the anchor is the LIGHTING AND GRADE, which is what stops five
        //     unrelated vignettes reading as five unrelated clips
        //   · global render notes at the end, once, rather than repeated per block
        //   · 200-300 words for a five-shot prompt, and no padding
        //
        // Five shots in ten seconds is a real shape, not a stretch. Beats can be two
        // seconds each.
        "- CHOOSE THE SHAPE OF EACH CLIP YOURSELF. A clip can be ONE continuous scene held all the way through, or two or three cuts within one scene, or up to FIVE separate vignettes in completely different places. Five is the model's hard limit per generation.\n" +
        "- Vary it across the commercial. A film where every clip is five rapid vignettes is exhausting, and one where every clip is a single held scene is slow. Let the moment decide: open on something that breathes, pack the middle, land on one clear image.\n" +
        "- Where a clip holds more than one thing, structure it in one paragraph: 'Shot 1: [one action]. Hard cut to Shot 2: [one action].' and so on.\n" +
        "- ONE ACTION PER SHOT BLOCK. If three things need to happen, that is three blocks. Piling actions into one block is what makes these come back muddled.\n" +
        "- Where a clip holds separate vignettes, each block is a COMPLETELY DIFFERENT person in a COMPLETELY DIFFERENT location, unrelated to the block before it. Describe each fully — age, appearance, clothing, room. Do not let them blur together.\n" +
        "- Give every one of them their own spoken line, all variations on the same idea.\n" +
        "- THE ANCHOR IS THE LIGHT. Since the cast changes every few seconds, name one lighting and colour recipe at the START and hold it across every block — it is the only thing making these one film rather than five.\n" +
        "- End the prompt with GLOBAL RENDER NOTES, once: the camera identity, the lighting recipe again, and what to avoid. Do not repeat them inside each block.\n" +
        "- A five-block prompt runs 200-300 words. Do not pad; every word should be doing work for one of the blocks.\n" +
        "- What holds it together is the sentence structure, the grade and the rhythm, not the cast. Give each person a variation on the same line.\n" +
        "- Put the most surprising setting in the middle, not first. The opening should be ordinary enough that the second clip lands as a turn.\n" +
        "- Leave the LOCKED DESCRIPTION empty — nothing is meant to match.\n";

    const revisionBlock = (revise && previous)
      ? "\n\nTHIS IS A REVISION. Here is the plan they already have:\n" +
        JSON.stringify({ title: previous.title, idea: previous.idea,
                         lockedDescription: previous.lockedDescription,
                         narration: previous.narration,
                         clips: (previous.clips || []).map(c => ({ n: c.n, slug: c.slug, prompt: c.prompt, spoken: c.spoken })) }) +
        "\n\nWHAT THEY WANT CHANGED: " + revise + "\n" +
        "Change what they asked for and LEAVE THE REST ALONE. Reuse the wording of any clip they did not mention, verbatim. " +
        "A revision that quietly rewrites the parts someone was happy with is worse than no revision — they cannot tell what you changed, and they lose the thing they liked.\n"
      : "";

    const prompt = shared + formatRules + revisionBlock +
      "\nRespond with ONLY this JSON:\n" +
      '{"title":"a short name for the commercial",' +
      '"lockedDescription":"the verbatim subject and place description, or empty string unless the format is continuous",' +
      '"narration":"the full continuous voiceover script, or empty string unless the format is narrated",' +
      '"idea":"one sentence on the through-line — what makes these clips one film",' +
      '"clips":[{' +
      '"n":1,' +
      '"seconds":' + lengths[0] + ',' +
      '"slug":"four or five word name",' +
      '"prompt":"the full self-contained Seedance prompt for this clip",' +
      '"spoken":"the exact spoken line, or empty string",' +
      '"why":"one short line on what this clip is doing for the commercial"' +
      '}]}\n\n' +
      "Return exactly " + lengths.length + " clips with those exact durations in that order.";

    let out = await callOpenAI(prompt);
    if (!out.ok) {
      console.warn("[commercial] GPT unavailable (" + out.error + "), falling back to Gemini");
      out = await callGemini(GKEY, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.9, maxOutputTokens: 8192 }
      });
    }
    if (!out.ok) return res.status(502).json({ error: out.error });

    let parsed = null;
    try { parsed = JSON.parse(String(out.text).replace(/```json|```/g, "").trim()); }
    catch (e) {
      console.error("[commercial] unparseable (" + String(out.text || "").length + " chars), tail: " + String(out.text || "").slice(-200));
    }
    if (!parsed || !Array.isArray(parsed.clips) || !parsed.clips.length) {
      return res.status(502).json({ error: "Couldn't plan that commercial. Try again, or say a little more about it." });
    }

    // Durations come from OUR arithmetic, not the model's. It is asked for them and
    // usually complies, but a clip that comes back as 20s is one Seedance will reject
    // outright, and a clip that comes back as 3s quietly makes the commercial short.
    const clips = parsed.clips.slice(0, lengths.length).map((c, i) => ({
      n: i + 1,
      seconds: lengths[i],
      slug:   String(c.slug || ("Clip " + (i + 1))).slice(0, 60),
      prompt: String(c.prompt || "").slice(0, 2000),
      spoken: String(c.spoken || "").slice(0, 300),
      why:    String(c.why || "").slice(0, 200)
    })).filter(c => c.prompt);

    if (!clips.length) return res.status(502).json({ error: "The plan came back empty. Try again." });

    return res.status(200).json({
      title: String(parsed.title || "Commercial").slice(0, 90),
      idea: String(parsed.idea || "").slice(0, 400),
      lockedDescription: format === "continuous" ? String(parsed.lockedDescription || "").slice(0, 400) : "",
      narration: format === "voiceover" ? String(parsed.narration || "").slice(0, 2000) : "",
      format, orientation, totalSec: clips.reduce((a, c) => a + c.seconds, 0),
      clips
    });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || "Something went wrong planning the commercial." });
  }
}
