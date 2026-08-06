// api/generator-train.js
//
// SONG STUDIO — the "Train my voice generator" button.
//
// Verifies the person's dataset is real, then launches ONE GPU pod that boots
// straight into train-diffsinger.sh and runs the whole fine-tune unattended:
// the script reports progress into storage (the app polls generator-status),
// and the pod REMOVES ITSELF when training ends, success or failure. Nobody
// babysits RunPod.
//
// Pod recipe mirrors song-scale.js deliberately — same REST calls, same env
// convention, same registry auth. Its OWN prefix (`chelgy-train-`), for the
// same reason song pods aren't `chelgy-auto-`: the song reaper caps lifetimes
// at ~100 minutes and a fine-tune runs for DAYS. Shared prefix = a reaper
// killing a half-trained model and billing the hours for nothing.
//
// Env: RUNPOD_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//      optional: RUNPOD_SONG_IMAGE (reused — CUDA+python+ffmpeg is all the
//      script needs; it installs its own training deps), RUNPOD_GPU_TYPES,
//      RUNPOD_COUNTRIES, RUNPOD_REGISTRY_AUTH_ID, APP_BASE_URL,
//      GENERATOR_TRAIN_STEPS

export const maxDuration = 30;

const RP = "https://rest.runpod.io/v1";
const KEY = (process.env.RUNPOD_API_KEY || "").trim();
const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const APP_BASE = (process.env.APP_BASE_URL || "https://chelgy.app").trim();

const POD_PREFIX = "chelgy-train-";
const IMAGE = (process.env.RUNPOD_SONG_IMAGE || "ghcr.io/chelgy/chelgy-song:latest").trim();
// Only cards at or BELOW the L4's price. Training doesn't need a faster GPU, so
// there's no reason to ever pay more — and listing only cheap cards means
// RunPod physically cannot hand us an expensive one when L4 is scarce. As of
// 2026: A5000 ~$0.27, L4 ~$0.39, A40 ~$0.44/hr. Everything pricier is left off
// on purpose. Override only if you know what you're paying for.
// Just L4 — the same single card the working song pods use. The multi-GPU
// list caused more "no instances available" failures than it solved (custom
// priority, oversized disk, filtering), so this is deliberately back to the
// simplest thing that has always worked here.
const GPU_TYPES = (process.env.RUNPOD_TRAIN_GPU_TYPES || "NVIDIA L4").split(",").map(s => s.trim()).filter(Boolean);
const COUNTRIES = (process.env.RUNPOD_COUNTRIES || "US").split(",").map(s => s.trim()).filter(Boolean);
const REGISTRY_AUTH = (process.env.RUNPOD_REGISTRY_AUTH_ID || "").trim();
// Training writes checkpoints, the MFA env, and the dataset to disk — size for it.
// 100GB matches the proven song-pod sizing. 150 was shrinking the pool —
// a GPU only qualifies if its host also has this much free disk, so an
// oversized ask filters out otherwise-available machines. Training's dataset
// + checkpoints fit comfortably in 100.
const DISK_GB = Math.max(80, Number(process.env.RUNPOD_TRAIN_DISK_GB) || 100);
// 60k for the full-quality model. Runs overnight unattended (~a day of GPU
// time), reports progress to the app, and the pod self-terminates when done.
const TRAIN_STEPS = String(Number(process.env.GENERATOR_TRAIN_STEPS) || 60000);

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

    // "Newest profile" is NOT the same question as "the profile holding this
    // person's dataset", and treating them as one is what broke this on 5 Aug:
    // an enrollment for the RVC model created a fresh profile, that profile
    // became newest, and this endpoint counted ITS empty dataset folder and
    // reported zero — while 48 files sat untouched under an older profile.
    //
    // Retraining one model must never hide the other's data. So walk the
    // profiles newest-first and take the first one that actually has a paired
    // dataset. Newest still wins WHEN IT QUALIFIES, so uploading a new dataset
    // behaves exactly as before; it just can't be shadowed by a profile that
    // has nothing to do with the generator.
    const profs = await sb("/rest/v1/voice_profiles?select=id&user_id=eq." + userId + "&order=created_at.desc&limit=20");
    if (!profs || !profs.length) return res.status(400).json({ error: "No voice profile yet — enroll your voice first." });

    async function countPairs(pid) {
      const listing = await fetch(SB_URL + "/storage/v1/object/list/voice", {
        method: "POST",
        headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json" },
        body: JSON.stringify({ prefix: userId + "/" + pid + "/dataset", limit: 1000 }),
      });
      const items = listing.ok ? (await listing.json()).map(o => o.name).filter(Boolean) : [];
      const stems = new Set(items.filter(n => /\.(wav|m4a|mp3|aif|aiff)$/i.test(n)).map(n => n.replace(/\.[^.]+$/, "")));
      return [...stems].filter(b => items.includes(b + ".txt")).length;
    }

    let profileId = null, pairs = 0, best = 0;
    for (const p of profs) {
      const n = await countPairs(p.id);
      if (n > best) best = n;
      if (n >= 8) { profileId = p.id; pairs = n; break; }
    }
    if (!profileId) {
      return res.status(400).json({
        error: "Only " + best + " usable clip(s) with lyrics found across your voice profiles — upload more recordings first.",
      });
    }

    // One training pod per profile at a time. Two pods fine-tuning the same
    // profile would race each other's checkpoints in storage.
    const pods = await rp("/pods", { method: "GET" });
    const arr = Array.isArray(pods) ? pods : (pods && pods.data) || [];
    const mine = arr.filter(p => String((p && p.name) || "").startsWith(POD_PREFIX + profileId.slice(0, 8)));
    if (mine.length) {
      return res.status(200).json({ ok: true, already: true, message: "Training is already running for this voice." });
    }

    // The pod boots, pulls the training script fresh from the app (same
    // single-source-of-truth rule as the render pipeline), and runs it. The
    // script reports progress to storage and removes the pod when it ends.
    // Clear any stale status from a previous run — otherwise the app's poller
    // reads the old "failed"/"done" state and the new run looks like it never
    // started. Best-effort; a missing file is fine.
    try {
      await fetch(SB_URL + "/storage/v1/object/voice/" + userId + "/" + profileId + "/generator/status.json",
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
      // "availability" grabs whichever listed card is free — the same setting the
      // working song pods use. "custom" (tried briefly) demands the exact order
      // and FAILS when the top card is busy, which caused "no instances
      // available" even when other cheap cards were free. A40 is still first in
      // the list as a soft preference, but we never fail just because it's taken.
      gpuTypePriority: "availability",
      dockerStartCmd: ["bash", "-lc",
        "curl -fsSL " + APP_BASE + "/train-diffsinger.sh?v=$(date +%s) | bash"],
      env: {
        SUPABASE_URL: SB_URL,
        SUPABASE_SERVICE_KEY: SB_SVC,
        SUPABASE_SERVICE_ROLE_KEY: SB_SVC,
        PROFILE_ID: profileId,
        MAX_STEPS: TRAIN_STEPS,
        NVIDIA_DRIVER_CAPABILITIES: "compute,utility",
        // survives RunPod's own injection — see song-scale.js for the story
        CHELGY_RUNPOD_KEY: KEY,
        RUNPOD_API_KEY: KEY,
      },
    };
    if (REGISTRY_AUTH) body.containerRegistryAuthId = REGISTRY_AUTH;
    await rp("/pods", { method: "POST", body: JSON.stringify(body) });

    return res.status(200).json({ ok: true, started: true, pairs });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
