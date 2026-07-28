// Chelgy — write the cover lines for a thumbnail.
//
// WHAT CHANGED, AND WHY
// This endpoint used to be handed 24 frames scraped out of a video and asked to pick
// the best one. That was the wrong job for it twice over: judging a real person's face
// is something a vision model does poorly and sometimes declines outright, and getting
// the frames out of the browser in the first place was a running battle with codecs,
// seek races and tainted canvases.
//
// The tool now takes photographs the person has already chosen. So there is no picking
// left to do — only WRITING, which is the one thing a language model is dependable at.
// No images are sent here at all. It is fast, cheap, and it cannot refuse to look at
// someone's face because it never sees one.
//
// The layout is fixed and the type is set in the browser in real fonts, so what comes
// back is only ever words — a slot at a time, each with its own length limit, because
// a line that overflows its box is worse than a duller line that fits.
//
// Env: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY

export const maxDuration = 60;

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
const overloaded = (s) => /overloaded|high demand|try again later|unavailable|resource[_ ]?exhausted|rate limit|quota/i.test(String(s || ""));

async function callGemini(GKEY, payload) {
  const models = [GEMINI_PRIMARY, GEMINI_PRIMARY, GEMINI_FALLBACK];
  let lastErr = "The writer is busy. Please try again in a moment.";
  for (let i = 0; i < models.length; i++) {
    try {
      const gr = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + models[i] + ":generateContent",
        { method: "POST", headers: { "x-goog-api-key": GKEY, "Content-Type": "application/json" }, body: JSON.stringify(payload) }
      );
      const gdata = await gr.json().catch(() => ({}));
      if (!gr.ok) {
        lastErr = (gdata && gdata.error && gdata.error.message) || ("Model error " + gr.status);
        if (gr.status >= 500 || gr.status === 429 || overloaded(lastErr)) { await sleep(1000 * (i + 1)); continue; }
        return { ok: false, error: lastErr };
      }
      let text = "";
      try { text = gdata.candidates[0].content.parts[0].text; } catch {}
      if (!text) { await sleep(1000 * (i + 1)); continue; }
      return { ok: true, text };
    } catch (e) {
      lastErr = (e && e.message) || "Network error contacting the writer.";
      await sleep(1000 * (i + 1));
    }
  }
  return { ok: false, error: lastErr };
}

// Each slot is (key, what it is, hard character cap). The caps are the layout's real
// limits, not guesses — they're what fits the box at the size the template sets it.
const SLOTS = {
  single: [
    ["masthead", "the big display word across the top — a brand or one-word title, set ENORMOUS. One word is ideal, two at most", 12],
    ["kicker",   "a short bold cover line up the left side, like a magazine's teaser. Title case", 18],
    ["kickerSub","one quiet line under the kicker saying what it delivers", 40],
    ["hero",     "the main title across the bottom, in caps", 22],
    ["sub",      "a short line under the title, in caps, tracked out", 26]
  ],
  collage: [
    ["masthead", "the big display word across the middle — a brand or one-word title, set ENORMOUS. One word ideal, two at most", 12],
    ["tl1",      "top-left opening phrase, e.g. 'where STYLE'. Title case, mixed caps allowed", 16],
    ["tl2",      "the small connecting word under it, e.g. 'meets'", 10],
    ["tl3",      "the payoff word, set reversed out of a black bar. Caps", 12],
    ["tr1",      "top-right word in a handwritten script, e.g. 'future'", 10],
    ["tr2",      "the small caps line under the script, e.g. 'OF FASHION'", 16],
    ["hero",     "the main title across the bottom, in caps", 22],
    ["sub",      "one line under the title — what the video actually gives someone", 62]
  ]
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = req.body || {};
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please sign in again." });

    const GKEY = (process.env.GEMINI_API_KEY || "").trim();
    if (!GKEY) return res.status(500).json({ error: "The writer is not configured." });

    const template = body.template === "collage" ? "collage" : "single";
    const about = String(body.about || "").trim().slice(0, 600);
    const brand = String(body.brand || "").trim().slice(0, 30);
    if (!about) return res.status(400).json({ error: "Tell us what the video is about first." });

    const slots = SLOTS[template];

    const prompt =
      "You are writing the cover lines for a high-end fashion magazine, except the subject is a video.\n\n" +
      "THE VIDEO IS ABOUT: " + about + "\n" +
      (brand ? "THE CREATOR'S NAME OR BRAND: " + brand + "\n" : "") +
      "\nWrite one line for each slot below. The character limit for each is ABSOLUTE — the layout is fixed and anything longer is cut off, so a shorter line that fits always beats a better line that doesn't.\n\n" +
      slots.map(function (s) { return "- " + s[0] + " (max " + s[2] + " characters): " + s[1]; }).join("\n") +
      "\n\nHouse style:\n" +
      "- Confident and specific. A cover line states something; it does not ask a question or tease.\n" +
      "- No clickbait. Never 'you won't believe', 'this changed everything', 'the secret to'.\n" +
      "- No emoji, no hashtags, no exclamation marks, no full stops at the end of a line.\n" +
      "- Do not repeat the same word across two slots.\n" +
      (brand ? "- The masthead should be the creator's name or brand if it fits the character limit.\n"
             : "- The masthead should be one strong word drawn from the subject.\n") +
      "\nRespond with ONLY this JSON, nothing else:\n" +
      "{" + slots.map(function (s) { return '"' + s[0] + '":"string"'; }).join(",") + "}";

    const out = await callGemini(GKEY, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.8, maxOutputTokens: 2048 }
    });
    if (!out.ok) return res.status(502).json({ error: out.error });

    let parsed = null;
    try { parsed = JSON.parse(String(out.text).replace(/```json|```/g, "").trim()); } catch (e) {
      console.error("[thumbnail] unparseable copy (" + String(out.text || "").length + " chars), tail: " + String(out.text || "").slice(-160));
    }
    if (!parsed || typeof parsed !== "object") {
      return res.status(502).json({ error: "Couldn't write the cover lines. Try again." });
    }

    // Trimmed to the cap here as well as asked for in the prompt. The model respects a
    // character limit most of the time, and "most of the time" is not a layout.
    const copy = {};
    for (const s of slots) {
      copy[s[0]] = String(parsed[s[0]] || "")
        .trim()
        .replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, "")
        .replace(/[.!]+$/, "")
        .slice(0, s[2]);
    }
    return res.status(200).json({ copy, template });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || "Something went wrong writing the cover lines." });
  }
}
