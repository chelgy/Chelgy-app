// api/generator-status.js
//
// SONG STUDIO — where the "Train my voice generator" progress comes from.
//
// The training pod writes voice/<uid>/<pid>/generator/status.json at every
// stage; this reads it back so the app can show a live progress card instead
// of the person watching the RunPod console. Also reports whether a finished
// generator model exists, which is what the app really wants to know.
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

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

    const profs = await fetch(SB_URL + "/rest/v1/voice_profiles?select=id&user_id=eq." + userId + "&order=created_at.desc&limit=1",
      { headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC } }).then(r => r.ok ? r.json() : []);
    if (!profs.length) return res.status(200).json({ state: "none" });
    const pid = profs[0].id;
    const base = SB_URL + "/storage/v1/object/voice/" + userId + "/" + pid + "/generator/";
    const H = { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC };

    // A finished model beats any status file.
    const model = await fetch(base + "acoustic.ckpt", { method: "HEAD", headers: H });
    const status = await fetch(base + "status.json", { headers: H });
    const st = status.ok ? await status.json().catch(() => null) : null;

    if (model.ok && (!st || st.stage === 6 || st.error)) {
      return res.status(200).json({ state: "ready" });
    }
    if (!st) return res.status(200).json({ state: "none" });
    if (st.error) return res.status(200).json({ state: "failed", label: st.error });

    // Stale detection: the training stage legitimately goes hours between
    // updates, but anything earlier that's silent for 30+ min is a dead pod.
    const ageMin = (Date.now() / 1000 - (st.at || 0)) / 60;
    if (st.stage < 5 && ageMin > 30) {
      return res.status(200).json({ state: "stalled", stage: st.stage, label: st.label });
    }
    return res.status(200).json({ state: "training", stage: st.stage, of: st.of || 6, label: st.label });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
