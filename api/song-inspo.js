// api/song-inspo.js
//
// SONG STUDIO — turn an uploaded inspo track into a production style description.
//
// The person uploads a song they want their beat to FEEL like. ElevenLabs takes
// text, not audio, so we can't hand it the track directly — instead Gemini
// listens to it and describes its production in words the music engine can use:
// instruments, how they're played, textures, energy, vocal layering, mix
// character. Their OWN melody's key/tempo/chords come from their voice (tune.py)
// and are kept; the inspo only shapes the FEEL.
//
// Deliberately NOT identification. We ask for the style, never "what song is
// this" — we want "hazy reverb guitars, wide vocal-friendly mix", not a title.
// That keeps this about production character, not copying a specific track.
//
// Env: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY

export const maxDuration = 60;

const GEMINI_KEY = (process.env.GEMINI_API_KEY || "").trim();
const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
// Called primarily by the song WORKER (server-to-server, no user token), the
// same way /api/song-beat is. A logged-in browser may also call it for a
// preview. So the gate is: a valid user token, OR the worker presenting the
// service key. Anonymous public calls are refused so this can't be used to
// burn Gemini credits.
const SB_SVC = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || "").trim();

// Model string is centralised so it's a one-line change when Gemini versions
// move. Confirm this matches what the rest of the app uses (Fake It etc).
const GEMINI_MODEL = process.env.GEMINI_AUDIO_MODEL || "gemini-2.5-flash";

const PROMPT = [
  "You are describing a song's PRODUCTION STYLE for an instrumental music",
  "generator. Do NOT name the song, artist, or any lyrics.",
  "Describe only: the instruments and how they're played, the textures and",
  "effects (reverb, saturation, filtering), the energy and groove, any vocal",
  "layering or ad-lib style, and the overall mix character.",
  "Answer as ONE comma-separated phrase of 8-16 descriptors, lowercase, no",
  "sentences, no preamble. Example: 'hazy reverb-drenched guitars, warm analog",
  "synth pads, soft brushed drums, wide airy mix, gentle stacked vocal harmonies,",
  "dreamy and unhurried'.",
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

// Pull the uploaded track back out of storage as base64 for the Gemini request.
// Inline (base64) works for the short clips we ask for; the Files API would be
// needed only for very large uploads, which we cap against below.
async function fetchAudioBase64(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("Couldn't read the inspo track (" + r.status + ").");
  const buf = Buffer.from(await r.arrayBuffer());
  // Guard the request size — Gemini inline audio wants the whole request under
  // ~20MB. A 30-45s clip is plenty to read a track's feel and stays well under.
  if (buf.length > 18 * 1024 * 1024) {
    throw new Error("That track is large — a 30-45 second clip reads its feel just as well.");
  }
  return buf.toString("base64");
}

function guessMime(url) {
  const u = url.toLowerCase();
  if (u.includes(".wav")) return "audio/wav";
  if (u.includes(".m4a") || u.includes(".mp4")) return "audio/mp4";
  if (u.includes(".aif")) return "audio/aiff";
  if (u.includes(".ogg") || u.includes(".webm")) return "audio/ogg";
  return "audio/mpeg";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!GEMINI_KEY) return res.status(500).json({ error: "Inspo analysis isn't configured yet." });

  // Worker path: presents the service key in the header. Browser path: a user
  // token we validate. Either is allowed; nothing else is.
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const isWorker = SB_SVC && token && token === SB_SVC;
  if (!isWorker) {
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again." });
  }

  const inspoUrl = String((req.body && req.body.inspoUrl) || "").trim();
  if (!/^https?:\/\//.test(inspoUrl)) {
    return res.status(400).json({ error: "Missing the inspo track's URL." });
  }

  try {
    const b64 = await fetchAudioBase64(inspoUrl);
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" +
        GEMINI_MODEL + ":generateContent",
      {
        method: "POST",
        headers: { "x-goog-api-key": GEMINI_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: PROMPT },
              { inline_data: { mime_type: guessMime(inspoUrl), data: b64 } },
            ],
          }],
          // Low temperature — we want a faithful reading of what's there, not
          // an imaginative one.
          generationConfig: { temperature: 0.4, maxOutputTokens: 200 },
        }),
      }
    );

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return res.status(502).json({ error: "Couldn't analyse that track: " + (t.slice(0, 200) || r.status) });
    }

    const data = await r.json();
    const style = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    let text = style.map((p) => p.text || "").join(" ").trim();
    // Tidy: collapse to a single clean comma phrase, drop any stray sentence
    // punctuation the model added despite instructions.
    text = text.replace(/\s+/g, " ").replace(/[.]+$/g, "").trim();
    if (!text) return res.status(502).json({ error: "Couldn't read a style from that track." });

    return res.status(200).json({ style: text });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || "Inspo analysis failed." });
  }
}
