// api/voice-status.js
//
// SONG STUDIO — progress for the "Retrain my voice (singing)" button.
//
// train-voice.sh (RVC, the ~40-min short option) uploads the finished model to
// voice/<uid>/<pid>/model/model.pth and marks the profile row ready. Unlike the
// generator, it doesn't write a per-stage status.json — so this reports the
// simple, reliable truth: is a running pod present, and does a finished model
// exist? That's enough for a ~40-min job: training → ready.
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, RUNPOD_API_KEY

const RP = "https://rest.runpod.io/v1";
const KEY = (process.env.RUNPOD_API_KEY || "").trim();
const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const POD_PREFIX = "chelgy-voice-";

async function getUserId(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, Authorization: "Bearer " + token } });
    const u = await r.json();
    return r.ok && u && u.id ? u.id : null;
  } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again." });

    const H = { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC };
    const profs = await fetch(SB_URL + "/rest/v1/voice_profiles?select=id,status&user_id=eq." + userId + "&order=created_at.desc&limit=1",
      { headers: H }).then(r => r.ok ? r.json() : []);
    if (!profs.length) return res.status(200).json({ state: "none" });
    const pid = profs[0].id;

    // A finished, ready model is the definitive "done".
    const model = await fetch(SB_URL + "/storage/v1/object/voice/" + userId + "/" + pid + "/model/model.pth",
      { method: "HEAD", headers: H });
    if (model.ok && profs[0].status === "ready") {
      return res.status(200).json({ state: "ready" });
    }

    // Is a training pod alive for this profile?
    let running = false;
    if (KEY) {
      try {
        const r = await fetch(RP + "/pods", { headers: { Authorization: "Bearer " + KEY } });
        const pods = r.ok ? await r.json() : [];
        const arr = Array.isArray(pods) ? pods : (pods && pods.data) || [];
        running = arr.some(p => String((p && p.name) || "").startsWith(POD_PREFIX + pid.slice(0, 8)));
      } catch { /* treat as not running */ }
    }
    if (running) return res.status(200).json({ state: "training", label: "Training your voice (about 40 minutes)…" });
    if (model.ok) return res.status(200).json({ state: "ready" });
    return res.status(200).json({ state: "none" });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
