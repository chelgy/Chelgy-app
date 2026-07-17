// Chelgy AI Video Editor — STEP 1: transcribe the raw footage.
// Deepgram fetches the video straight from its Supabase URL (nothing big flows
// through Vercel) and returns the full transcript with per-word timestamps,
// including filler words ("um", "uh") so the edit planner can cut them.
// Free step (pennies); credits are charged at the render step.
// Env: DEEPGRAM_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY

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

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const url = body.url;
    if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: "Missing video URL." });

    const DG = (process.env.DEEPGRAM_API_KEY || "").trim();
    if (!DG) return res.status(500).json({ error: "The editor is not configured yet (transcription key missing)." });

    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again." });

    const dg = await fetch(
      "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true&filler_words=true&utterances=true",
      {
        method: "POST",
        headers: { Authorization: "Token " + DG, "Content-Type": "application/json" },
        body: JSON.stringify({ url })
      }
    );
    const data = await dg.json();
    if (!dg.ok) {
      const msg = (data && (data.err_msg || data.error || (data.message))) || "Transcription failed.";
      return res.status(502).json({ error: String(msg) });
    }

    const alt = data && data.results && data.results.channels && data.results.channels[0] &&
                data.results.channels[0].alternatives && data.results.channels[0].alternatives[0];
    if (!alt) return res.status(502).json({ error: "No speech found in that video. Make sure you're talking in it!" });

    const words = (alt.words || []).map(w => ({
      w: w.punctuated_word || w.word,
      s: Math.round((w.start || 0) * 100) / 100,
      e: Math.round((w.end || 0) * 100) / 100
    }));
    const duration = (data.metadata && data.metadata.duration) || (words.length ? words[words.length - 1].e : 0);

    return res.status(200).json({ transcript: alt.transcript || "", words, duration: Math.round(duration * 10) / 10 });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
