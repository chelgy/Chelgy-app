// api/song-lyrics.js
//
// SONG STUDIO — transcribe the lyrics of a sung clip.
//
// Feeds the dataset uploader's "Detect lyrics" button: the person uploads a
// singing clip, Gemini listens and writes down the words, and the person
// CORRECTS the draft instead of typing from scratch.
//
// The correction step is load-bearing, not polish: these lyrics are what MFA
// aligns the audio against during training. A wrong word that slips through
// trains the model on a lie. So this endpoint returns a DRAFT — the UI must
// keep the text editable and say so.
//
// Takes the audio as base64 in the body (the uploader has the file locally
// before upload, so no storage round-trip is needed).
//
// Env: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY

export const maxDuration = 60;

const GEMINI_KEY = (process.env.GEMINI_API_KEY || "").trim();
const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const GEMINI_MODEL = process.env.GEMINI_AUDIO_MODEL || "gemini-2.5-flash";

const PROMPT = [
  "Transcribe the LYRICS being sung in this audio clip, exactly as sung.",
  "Rules: output ONLY the words, lowercase, no punctuation except apostrophes",
  "in contractions (don't, i'm), no timestamps, no speaker labels, no quotes,",
  "no commentary. If a word is unclear, make your best guess rather than",
  "omitting it. If there is no singing at all, output exactly: NO_SINGING",
].join(" ");

async function getUserId(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", {
      headers: { apikey: SB_ANON, Authorization: "Bearer " + token },
    });
    const u = await r.json();
    return r.ok && u && u.id ? u.id : null;
  } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!GEMINI_KEY) return res.status(500).json({ error: "Lyric detection isn't configured yet." });

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const userId = await getUserId(token);
  if (!userId) return res.status(401).json({ error: "Please log in again." });

  const { audio = "", mime = "audio/wav" } = req.body || {};
  const b64 = String(audio).replace(/^data:[^;]+;base64,/, "");
  if (!b64) return res.status(400).json({ error: "Missing audio." });
  // Inline Gemini requests want the whole payload under ~20MB. Clips are short
  // by design (10-15s), so this only trips on something that isn't a clip.
  if (b64.length > 18 * 1024 * 1024 * 1.37) {
    return res.status(400).json({ error: "That file is too large for lyric detection — clips should be short." });
  }

  try {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent",
      {
        method: "POST",
        headers: { "x-goog-api-key": GEMINI_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [
            { text: PROMPT },
            { inline_data: { mime_type: mime, data: b64 } },
          ]}],
          // Near-zero temperature: transcription wants faithfulness, not flair.
          generationConfig: { temperature: 0.1, maxOutputTokens: 500 },
        }),
      }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return res.status(502).json({ error: "Couldn't listen to that clip: " + (t.slice(0, 200) || r.status) });
    }
    const data = await r.json();
    const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    let text = parts.map((p) => p.text || "").join(" ").trim();
    text = text.replace(/\s+/g, " ").trim();
    if (!text || text === "NO_SINGING") {
      return res.status(200).json({ lyrics: "", note: "No singing detected in this clip." });
    }
    return res.status(200).json({ lyrics: text });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || "Lyric detection failed." });
  }
}

export const config = { api: { bodyParser: { sizeLimit: "25mb" } } };
