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
    const format   = body.format === "anthology" ? "anthology" : "continuous";
    const brand    = String(body.brand || "").trim().slice(0, 80);
    const look     = String(body.look || "").trim().slice(0, 300);
    const orientation = body.orientation === "landscape" ? "landscape" : body.orientation === "square" ? "square" : "portrait";
    const totalSec = Math.max(4, Math.min(60, Math.round(Number(body.totalSec) || 15)));
    const spoken   = body.spoken !== false;
    if (!brief) return res.status(400).json({ error: "Tell us what the commercial is about first." });

    const lengths = planClipLengths(totalSec);

    const shared =
      "You are writing prompts for Seedance, a video model that generates one clip at a time with synchronised audio and lip-sync.\n\n" +
      "THE COMMERCIAL: " + brief + "\n" +
      (brand ? "BRAND: " + brand + "\n" : "") +
      (look ? "LOOK THEY WANT: " + look + "\n" : "") +
      "TOTAL LENGTH: " + totalSec + " seconds, shot " + orientation + ".\n" +
      "IT WILL BE " + lengths.length + " CLIPS, of these lengths in order: " + lengths.join("s, ") + "s.\n\n" +
      "HOW TO WRITE A SHOT PROMPT — this is the part that decides whether it works:\n" +
      "- Each prompt is SELF-CONTAINED. The model has no memory of the other clips. Never write 'the same woman' or 'as before' — describe her again, fully, every time.\n" +
      "- Say what is in frame, what moves, where the camera is, and what the light is doing. Concrete nouns beat adjectives: 'low winter sun through a west-facing window' not 'beautiful lighting'.\n" +
      "- Name the shot size and any camera move in the prompt itself.\n" +
      (spoken
        ? "- Seedance generates lip-synced speech. When someone talks, put the exact line in the prompt as spoken dialogue, in quotes, and say who says it and how.\n"
        : "- NO speech and no dialogue anywhere. These clips carry music and atmosphere only.\n") +
      "- A clip longer than about 8 seconds should contain more than one beat. Use 'Shot 1: ... Shot 2: ...' inside a single prompt to sequence them.\n" +
      "- No text, captions, logos or writing anywhere in frame. Those are added afterwards and a model rendering them produces garbled letters.\n\n";

    const formatRules = format === "continuous"
      ? "FORMAT — CONTINUOUS. One subject, one world, one thread running through it.\n" +
        "- Write a LOCKED DESCRIPTION: the subject's age, build, hair, clothing, and the place, in about 25 words. Reproduce it VERBATIM at the start of every single shot prompt. Not paraphrased — the same words. This is the only thing holding the person's face together across clips.\n" +
        "- The clips must run in order as one continuous piece of time. Each begins roughly where the last ended.\n"
      : "FORMAT — ANTHOLOGY. Deliberately different people, places and moments, held together by one idea.\n" +
        "- Every clip is a DIFFERENT person in a DIFFERENT place. Vary age, appearance and setting hard — that contrast is the whole idea of the film.\n" +
        "- What holds it together is the sentence structure, the grade and the rhythm, not the cast. Give each person a variation on the same line.\n" +
        "- Put the most surprising setting in the middle, not first. The opening should be ordinary enough that the second clip lands as a turn.\n" +
        "- Leave the LOCKED DESCRIPTION empty — nothing is meant to match.\n";

    const prompt = shared + formatRules +
      "\nRespond with ONLY this JSON:\n" +
      '{"title":"a short name for the commercial",' +
      '"lockedDescription":"the verbatim subject and place description, or empty string for anthology",' +
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

    const out = await callGemini(GKEY, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.9, maxOutputTokens: 8192 }
    });
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
      format, orientation, totalSec: clips.reduce((a, c) => a + c.seconds, 0),
      clips
    });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || "Something went wrong planning the commercial." });
  }
}
