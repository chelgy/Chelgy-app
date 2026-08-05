// api/voice-train.js
//
// SONG STUDIO — the "Retrain my voice (singing)" button (the SHORT option).
//
// The RVC converter model — the one Song Studio's convert/re-sing modes use.
// This launches ONE GPU pod that boots straight into train-voice.sh and runs
// the whole ~40-minute train unattended: the script fetches the person's clips
// from the voice_clips table, trains, uploads model.pth + model.index back, and
// marks the profile ready. The pod removes itself when it ends.
//
// Deliberately mirrors generator-train.js (the DiffSinger "long option") — same
// RunPod REST calls, same env convention, same registry auth — with three
// differences:
//   1. runs train-voice.sh, not train-diffsinger.sh
//   2. its OWN pod prefix (chelgy-voice-) so it never collides with a running
//      DiffSinger train pod (chelgy-train-) or gets killed by the song reaper
//   3. validates the voice_clips TABLE (RVC needs no lyrics), not dataset pairs
//
// Env: RUNPOD_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//      optional: RUNPOD_SONG_IMAGE, RUNPOD_TRAIN_GPU_TYPES, RUNPOD_COUNTRIES,
//      RUNPOD_REGISTRY_AUTH_ID, APP_BASE_URL

export const maxDuration = 30;

const RP = "https://rest.runpod.io/v1";
const KEY = (process.env.RUNPOD_API_KEY || "").trim();
const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const APP_BASE = (process.env.APP_BASE_URL || "https://chelgy.app").trim();

// Own prefix — never share with chelgy-train- (DiffSinger). A shared prefix
// risks one train's "already running" check blocking the other, and confuses
// the pod bookkeeping. RVC is short (~40 min) but still gets isolation.
const POD_PREFIX = "chelgy-voice-";
const IMAGE = (process.env.RUNPOD_SONG_IMAGE || "ghcr.io/chelgy/chelgy-song:latest").trim();
// Same single L4 the working song/train pods use.
const GPU_TYPES = (process.env.RUNPOD_TRAIN_GPU_TYPES || "NVIDIA L4").split(",").map(s => s.trim()).filter(Boolean);
const COUNTRIES = (process.env.RUNPOD_COUNTRIES || "US").split(",").map(s => s.trim()).filter(Boolean);
const REGISTRY_AUTH = (process.env.RUNPOD_REGISTRY_AUTH_ID || "").trim();
// RVC's dataset + features + checkpoints fit comfortably in the same 100GB the
// song pods use. Matching it keeps the machine pool as wide as possible.
const DISK_GB = Math.max(80, Number(process.env.RUNPOD_TRAIN_DISK_GB) || 100);

async function rp(path, init) {
  const r = await fetch(RP + path, {
    ...init,
    headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json", ...((init && init.headers) || {}) },
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) throw new Error("runpod " + path + ": " + r.status + " " + String(text).slice(0, 200));
  return body;
}

async function getUserId(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, Authorization: "Bearer " + token } });
    const u = await r.json();
    return r.ok && u && u.id ? u.id : null;
  } catch { return null; }
}

async function sb(path) {
  const r = await fetch(SB_URL + path, { headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC } });
  return r.ok ? r.json() : null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!KEY) return res.status(500).json({ error: "Training isn't configured yet." });

  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again." });

    // The person's newest voice profile — RVC trains into it, and everything
    // downstream (convert/re-sing) already reads the newest profile, so once
    // this finishes and marks the profile ready, the app uses it automatically.
    const profs = await sb("/rest/v1/voice_profiles?select=id&user_id=eq." + userId + "&order=created_at.desc&limit=1");
    if (!profs || !profs.length) return res.status(400).json({ error: "No voice profile yet — record your voice first." });
    const profileId = profs[0].id;

    // The clips have to actually be registered before a GPU starts billing.
    // RVC reads the voice_clips table (no lyrics needed, unlike the generator),
    // and train-voice.sh needs at least 10 minutes of audio — so count rows and
    // sum duration here, and fail fast and cheap if it's thin.
    const clips = await sb("/rest/v1/voice_clips?select=duration&profile_id=eq." + profileId);
    if (!clips || !clips.length) {
      return res.status(400).json({ error: "No clips found for your voice yet — record and upload them first." });
    }
    const minutes = clips.reduce((s, c) => s + (Number(c.duration) || 0), 0) / 60;
    if (minutes < 10) {
      return res.status(400).json({ error: "Only " + minutes.toFixed(1) + " min of audio — RVC needs at least 10 minutes. Record a bit more." });
    }

    // One voice-training pod per profile at a time.
    const pods = await rp("/pods", { method: "GET" });
    const arr = Array.isArray(pods) ? pods : (pods && pods.data) || [];
    const mine = arr.filter(p => String((p && p.name) || "").startsWith(POD_PREFIX + profileId.slice(0, 8)));
    if (mine.length) {
      return res.status(200).json({ ok: true, already: true, message: "Your voice is already training." });
    }

    // Clear any stale status from a previous run so the poller doesn't read an
    // old done/failed state and think the new run never started. Best-effort.
    try {
      await fetch(SB_URL + "/storage/v1/object/voice/" + userId + "/" + profileId + "/model/status.json",
        { method: "DELETE", headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC } });
    } catch { /* nothing to clear */ }

    const body = {
      name: POD_PREFIX + profileId.slice(0, 8) + "-" + Date.now(),
      imageName: IMAGE,
      gpuTypeIds: GPU_TYPES,
      gpuCount: 1,
      containerDiskInGb: DISK_GB,
      volumeInGb: 0,
      cloudType: "SECURE",
      computeType: "GPU",
      countryCodes: COUNTRIES,
      gpuTypePriority: "availability",
      // Boot straight into the RVC trainer, pulled fresh from the app (same
      // single-source-of-truth rule as the render pipeline and the generator).
      dockerStartCmd: ["bash", "-lc",
        "curl -fsSL " + APP_BASE + "/train-voice.sh?v=$(date +%s) | bash"],
      env: {
        SUPABASE_URL: SB_URL,
        SUPABASE_SERVICE_KEY: SB_SVC,
        SUPABASE_SERVICE_ROLE_KEY: SB_SVC,
        PROFILE_ID: profileId,
        NVIDIA_DRIVER_CAPABILITIES: "compute,utility",
        // survives RunPod's own injection — see song-scale.js for the story
        CHELGY_RUNPOD_KEY: KEY,
        RUNPOD_API_KEY: KEY,
      },
    };
    if (REGISTRY_AUTH) body.containerRegistryAuthId = REGISTRY_AUTH;
    await rp("/pods", { method: "POST", body: JSON.stringify(body) });

    return res.status(200).json({ ok: true, started: true, minutes: Number(minutes.toFixed(1)) });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
