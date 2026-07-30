// api/voices.js — the voices actually available on our ElevenLabs account.
//
// WHY THIS EXISTS RATHER THAN A HARDCODED LIST
// Every voiceover in the app has been the same British man, because api/voice.js
// falls back to one voice id and nothing ever offered another. The obvious fix is a
// list of ids in the frontend — and it is the wrong fix: voice ids are opaque strings,
// a wrong one fails at generation time after credits have been spent, and the list
// drifts the moment a voice is added or removed from the account.
//
// Asking the account what it has cannot drift. It is also the only way to pick up
// voices cloned or added later without a deploy.
//
// NO CREDITS. Reading a list is not a product.
//
// Env: ELEVENLABS_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();

// The account's voice list changes rarely and this is hit on every page that offers a
// picker, so it is cached at the edge. A minute is short enough that a newly added
// voice shows up quickly and long enough that opening the tool ten times is one call.
const CACHE = "public, s-maxage=300, stale-while-revalidate=3600";

async function getUserId(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, Authorization: "Bearer " + token } });
    const u = await r.json();
    return r.ok && u && u.id ? u.id : null;
  } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again." });

    const key = (process.env.ELEVENLABS_API_KEY || "").trim();
    if (!key) return res.status(500).json({ error: "Voiceover service is not configured." });

    let r;
    try {
      r = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
    } catch {
      return res.status(502).json({ error: "Couldn't reach the voice service." });
    }
    if (!r.ok) return res.status(r.status).json({ error: "Couldn't list the voices." });

    const d = await r.json().catch(() => ({}));
    const raw = Array.isArray(d && d.voices) ? d.voices : [];

    // Only what a picker needs. The full objects carry settings, sample urls and
    // sharing metadata that would be a lot of bytes on every page load.
    const voices = raw.map((v) => {
      const L = (v && v.labels) || {};
      return {
        id: String(v.voice_id || ""),
        name: String(v.name || "").trim(),
        // Labels are free-text and frequently missing, so everything downstream has to
        // treat them as optional rather than as a schema.
        gender: String(L.gender || "").toLowerCase(),
        accent: String(L.accent || "").toLowerCase(),
        age: String(L.age || "").toLowerCase(),
        description: String(L.description || "").toLowerCase(),
        useCase: String(L.use_case || L["use case"] || "").toLowerCase(),
        preview: String(v.preview_url || ""),
      };
    }).filter((v) => v.id && v.name);

    // Sorted by name so the order is stable between loads. An unstable picker where
    // the third option is a different voice each time is worse than a long one.
    voices.sort((a, b) => a.name.localeCompare(b.name));

    res.setHeader("Cache-Control", CACHE);
    return res.status(200).json({ voices });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
