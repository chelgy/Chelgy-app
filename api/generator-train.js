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
// Fastest affordable card FIRST. Training time depends on GPU speed, so the
// A40 (most bandwidth of the cheap tier, ~$0.44/hr) is preferred; L4 and A5000
// are fallbacks only if the A40 is busy. A faster card that finishes in fewer
// hours often costs LESS total than a cheap slow one that runs twice as long —
// and you get the model sooner, which is the point.
const GPU_TYPES = (process.env.RUNPOD_TRAIN_GPU_TYPES || "NVIDIA A40,NVIDIA L4,NVIDIA RTX A5000").split(",").map(s => s.trim()).filter(Boolean);
// NOTE: RunPod's REST API has no price-cap field, so cost is controlled the
// only way it can be — GPU_TYPES above lists ONLY cards at or below the L4's
// price. RunPod cannot hand us an expensive GPU that isn't on that list.
const COUNTRIES = (process.env.RUNPOD_COUNTRIES || "US").split(",").map(s => s.trim()).filter(Boolean);
const REGISTRY_AUTH = (process.env.RUNPOD_REGISTRY_AUTH_ID || "").trim();
// Training writes checkpoints, the MFA env, and the dataset to disk — size for it.
const DISK_GB = Math.max(100, Number(process.env.RUNPOD_TRAIN_DISK_GB) || 150);
// 20k for the FIRST run: enough to prove the voice sounds like her in ~4-6h,
// not the ~day a full 60k takes. Once proven, bump this (or set the env var)
// to 60000 for the polished final model.
const TRAIN_STEPS = String(Number(process.env.GENERATOR_TRAIN_STEPS) || 20000);

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

    // The person's newest voice profile — the generator attaches to it.
    const profs = await sb("/rest/v1/voice_profiles?select=id&user_id=eq." + userId + "&order=created_at.desc&limit=1");
    if (!profs || !profs.length) return res.status(400).json({ error: "No voice profile yet — enroll your voice first." });
    const profileId = profs[0].id;

    // The dataset has to actually be there before a GPU starts billing. Count
    // audio+lyrics PAIRS — an unpaired wav can't be aligned and doesn't count.
    const listing = await fetch(SB_URL + "/storage/v1/object/list/voice", {
      method: "POST",
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json" },
      body: JSON.stringify({ prefix: userId + "/" + profileId + "/dataset", limit: 1000 }),
    });
    const items = listing.ok ? (await listing.json()).map(o => o.name).filter(Boolean) : [];
    const stems = new Set(items.filter(n => /\.(wav|m4a|mp3|aif|aiff)$/i.test(n)).map(n => n.replace(/\.[^.]+$/, "")));
    const pairs = [...stems].filter(b => items.includes(b + ".txt")).length;
    if (pairs < 8) {
      return res.status(400).json({ error: "Only " + pairs + " usable clip(s) with lyrics found — upload more recordings first." });
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
      // "custom" honors our order (fastest-first). Only falls to the next card
      // if the preferred one has no availability.
      gpuTypePriority: "custom",
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
