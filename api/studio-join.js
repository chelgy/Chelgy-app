// Chelgy — join generated clips into one film.
//
// A thin proxy in front of the render server's /join. It exists for one reason: the
// render secret must never be in the browser bundle. Everything of substance — the
// concat, the ducking, the logo overlay — happens on the render server; this checks who
// is asking and forwards it.
//
// No credits are charged here. The clips were paid for individually as they were
// generated, and joining files that are already made and already paid for is not a
// second product.
//
// Env (Vercel): RENDER_SERVER_URL, RENDER_SECRET, SUPABASE_URL, SUPABASE_ANON_KEY

export const maxDuration = 300;

const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const RS_URL = (process.env.RENDER_SERVER_URL || "").trim().replace(/\/+$/, "");
const RS_SECRET = (process.env.RENDER_SECRET || "").trim();

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
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please sign in again." });
    if (!RS_URL || !RS_SECRET) return res.status(500).json({ error: "The render server is not configured." });

    const body = req.body || {};
    const clips = Array.isArray(body.clips)
      ? body.clips.filter(u => typeof u === "string" && /^https?:\/\//.test(u)).slice(0, 12)
      : [];
    if (!clips.length) return res.status(400).json({ error: "No clips to join." });

    // Namespaced by user so two people joining at once cannot land on the same object.
    const uploadPath = "renders/" + userId + "/commercial-" + Date.now() + ".mp4";

    const r = await fetch(RS_URL + "/join", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-render-secret": RS_SECRET },
      body: JSON.stringify({
        clips,
        voiceUrl: typeof body.voiceUrl === "string" ? body.voiceUrl : undefined,
        logoUrl:  typeof body.logoUrl  === "string" ? body.logoUrl  : undefined,
        width:  Number(body.width)  || 1080,
        height: Number(body.height) || 1920,
        duck:   body.duck == null ? 0.8 : Number(body.duck),
        uploadPath
      })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: (d && d.error) || "Couldn't join those clips." });
    return res.status(200).json(d);
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || "Join failed." });
  }
}
