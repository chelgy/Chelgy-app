// api/song-master.js
//
// SONG STUDIO — proxy for MIX & MASTER.
//
// The browser never talks to the render server directly (RENDER_SECRET lives
// here, in Vercel's env, like studio-song does it). This validates the person,
// forwards the request with the secret and their user id, and relays the
// mastered file's URL back.
//
// Env: RENDER_SERVER_URL, RENDER_SECRET, SUPABASE_URL, SUPABASE_ANON_KEY

export const maxDuration = 60;

const RS_URL = (process.env.RENDER_SERVER_URL || "").trim().replace(/\/+$/, "");
const RS_SECRET = (process.env.RENDER_SECRET || "").trim();
const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();

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
  if (!RS_URL || !RS_SECRET)
    return res.status(500).json({ error: "Mastering isn't configured yet." });

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const userId = await getUserId(token);
  if (!userId) return res.status(401).json({ error: "Please log in again." });

  const { audioUrl = "", intensity = "warm" } = req.body || {};
  if (!/^https?:\/\//.test(String(audioUrl)))
    return res.status(400).json({ error: "Missing the track's URL." });

  try {
    const r = await fetch(RS_URL + "/master", {
      method: "POST",
      // The render server authenticates with the shared x-render-secret
      // header (same as every other proxy here) — NOT a bearer token.
      headers: { "Content-Type": "application/json",
                 "x-render-secret": RS_SECRET },
      body: JSON.stringify({ audioUrl, intensity, userId }),
    });
    const j = await r.json().catch(() => ({}));
    return res.status(r.status).json(j);
  } catch (e) {
    return res.status(502).json({ error: "Couldn't reach the mastering engine." });
  }
}
