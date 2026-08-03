// Chelgy — bring song pods up when a song is queued, and let them put
// themselves away.
//
// Deliberately a separate file from render-scale.js rather than a mode inside
// it, and the reason is the pod prefix.
//
// render-scale.js counts, and REAPS, every pod whose name starts with
// `chelgy-auto-`. If song pods shared that prefix, the video scaler would
// count a song pod as a video worker and create fewer machines for a render
// that needs them — and its reaper would terminate a song pod mid-render at
// the video worker's lifetime cap, abandoning a job that then has to wait out
// a thirty-minute lease before anyone retries it. Both failures are silent and
// both look like a bug in the other system.
//
// So: `chelgy-song-`. Each scaler sees only its own machines, and neither can
// starve or kill the other's.
//
// Env: RUNPOD_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
//      optional: RUNPOD_SONG_IMAGE, RUNPOD_SONG_MAX_PODS, RUNPOD_SONG_DISK_GB,
//                RUNPOD_GPU_TYPES, RUNPOD_COUNTRIES, RUNPOD_REGISTRY_AUTH_ID,
//                RUNPOD_SONG_IDLE_MINUTES, RUNPOD_SONG_MAX_LIFETIME_MINUTES

export const maxDuration = 30;

const RP = "https://rest.runpod.io/v1";
const KEY = (process.env.RUNPOD_API_KEY || "").trim();

const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const APP_BASE = (process.env.APP_BASE_URL || "https://chelgy.app").trim();

const POD_PREFIX = "chelgy-song-";
const IMAGE = (process.env.RUNPOD_SONG_IMAGE || "ghcr.io/chelgy/chelgy-song:latest").trim();

// A song is ONE job on ONE machine. There is no chunking to spread — the
// pipeline is strictly sequential, so a second pod does nothing for a single
// song. This ceiling is therefore about CONCURRENT SONGS, not about making any
// one song faster, and it exists for the same reason the video one does: past
// a point, machines just idle. Raise it when concurrency genuinely exceeds it.
const MAX_PODS = Math.max(1, Number(process.env.RUNPOD_SONG_MAX_PODS) || 4);

// Container disk. The video workers take 50 GB; this image carries torch and
// the RVC weights on top of everything they carry, so 50 would be tight and a
// pod that runs out of container disk mid-pull fails in a way that reads like a
// render bug rather than a sizing one. Set from the real image size once
// measured — until then this is deliberately generous, because over-provisioned
// disk is nearly free and under-provisioned disk costs a whole render.
const DISK_GB = Math.max(50, Number(process.env.RUNPOD_SONG_DISK_GB) || 100);

const GPU_TYPES = (process.env.RUNPOD_GPU_TYPES || "NVIDIA L4").split(",").map(s => s.trim()).filter(Boolean);
const COUNTRIES = (process.env.RUNPOD_COUNTRIES || "US").split(",").map(s => s.trim()).filter(Boolean);
const REGISTRY_AUTH = (process.env.RUNPOD_REGISTRY_AUTH_ID || "").trim();

// COLD START IS LONGER HERE AND THE NUMBER MATTERS.
//
// The video worker's window is 100s, measured at 61s from create to container
// start — almost all of it image pull. This image is several times larger, so
// the same measurement will be several times bigger. 300s is a placeholder, not
// a measurement: too low and two songs queued a minute apart each conclude the
// other's pod does not exist yet and both create one; too high and a genuine
// second song waits behind a pod that is already busy. Replace it with the real
// figure from a pod's first boot.
const BOOTING_MS = Math.max(60, Number(process.env.RUNPOD_SONG_BOOT_SECONDS) || 300) * 1000;

const POD_NAME_TIME = new RegExp("^" + POD_PREFIX + "(\\d+)-");
function podRequestedMsAgo(pod) {
  const m = POD_NAME_TIME.exec(String((pod && pod.name) || ""));
  const t = m ? Number(m[1]) : NaN;
  return Number.isFinite(t) ? Math.max(0, Date.now() - t) : Infinity;
}

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

// Its OWN cache, not one shared with render-scale.js. Sharing would mean one
// filtered list serving two prefixes, which is exactly the coupling this file
// exists to avoid.
let _podCache = { at: 0, pods: null };
const POD_CACHE_MS = 5000;

async function listOurPodsRaw() {
  const pods = await rp("/pods", { method: "GET" });
  const arr = Array.isArray(pods) ? pods : (pods && pods.data) || [];
  return arr.filter(p => String((p && p.name) || "").startsWith(POD_PREFIX));
}

async function listOurPods() {
  if (_podCache.pods && Date.now() - _podCache.at < POD_CACHE_MS) return _podCache.pods;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const pods = await listOurPodsRaw();
      _podCache = { at: Date.now(), pods };
      return pods;
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await new Promise(r => setTimeout(r, 600));
    }
  }
  throw lastErr;
}

// Credentials at creation, never on a RunPod template. One source of truth:
// rotate the service-role key in Vercel and every pod made afterwards has it.
function songEnv() {
  return {
    SUPABASE_URL: SB_URL,
    SUPABASE_SERVICE_ROLE_KEY: SB_SVC,
    APP_BASE_URL: APP_BASE,
    // compute and utility only. No `video` or `graphics`: this image never
    // touches NVENC or Vulkan, and asking for capabilities it does not use
    // only widens what has to be present for the pod to start at all.
    NVIDIA_DRIVER_CAPABILITIES: "compute,utility",
    // NOT named RUNPOD_API_KEY. RunPod mints a pod-scoped key and injects it
    // under that exact name, silently overwriting ours — and a pod-scoped key
    // is not permitted to delete pods, so every self-terminate comes back 403
    // while the machine keeps billing. Our own name cannot be clobbered.
    CHELGY_RUNPOD_KEY: KEY,
    RUNPOD_API_KEY: KEY,
    // Longer idle than the video workers' 3 minutes, on purpose. Boot here is
    // dominated by pulling a very large image, so retiring an idle song pod
    // eagerly means paying that pull again for the next song a few minutes
    // later. Idle minutes are cheap; cold starts are not.
    RUNPOD_IDLE_MINUTES: String(process.env.RUNPOD_SONG_IDLE_MINUTES || 10),
    RUNPOD_MAX_LIFETIME_MINUTES: String(process.env.RUNPOD_SONG_MAX_LIFETIME_MINUTES || 60),
  };
}

async function createPod(n) {
  const body = {
    name: POD_PREFIX + Date.now() + "-" + n,
    imageName: IMAGE,
    gpuTypeIds: GPU_TYPES,
    gpuCount: 1,
    containerDiskInGb: DISK_GB,
    volumeInGb: 0,           // nothing is kept between jobs; everything goes to storage
    cloudType: "SECURE",
    computeType: "GPU",
    countryCodes: COUNTRIES,
    gpuTypePriority: "availability",
    env: songEnv(),
  };
  if (REGISTRY_AUTH) body.containerRegistryAuthId = REGISTRY_AUTH;
  return await rp("/pods", { method: "POST", body: JSON.stringify(body) });
}

// Bring the song fleet up. Never down — a pod knows whether it is mid-render
// and this function does not. Workers retire themselves.
//
// `additive` is the default here, unlike the video path. A song is one job on
// one machine, so the question is always "does THIS song have a machine of its
// own?" rather than "does the fleet contain N?". Asking the fleet question
// would mean the second song queued finds one pod already up, creates nothing,
// and then waits for the first song to finish — at half speed, with no error
// anywhere. That is the exact trap the audio path documents.
export async function ensureSongPods(demand, reason, opts) {
  if (!KEY) return { ok: false, skipped: "no RUNPOD_API_KEY" };
  const want = Math.max(0, Math.min(MAX_PODS, Number(demand) || 0));
  if (!want) return { ok: true, created: 0, running: 0 };
  const additive = !(opts && opts.additive === false);

  let running = 0;
  let pods = [];
  try {
    pods = await listOurPods();
    running = pods.length;
  } catch (e) {
    // Counting failed even after a retry. Creating blind risks pods piling up;
    // creating nothing strands a paying customer's song on whatever is already
    // running. Split the difference — one machine so the job progresses, said
    // loudly. The reaper and the worker's own idle timer both still apply.
    console.error("[song-scale] " + reason + ": could not list pods (" + ((e && e.message) || e) + ") — creating 1 to keep the song moving");
    try { await createPod(0); return { ok: true, created: 1, running: 1, degraded: true }; }
    catch { return { ok: false, created: 0, running: 0, error: "could not count or create" }; }
  }

  // A MACHINE STILL PULLING ITS IMAGE ALREADY COUNTS.
  //
  // This matters more here than it does for video. The song image is large
  // enough that a pod requested two minutes ago may still be pulling, and it
  // has claimed nothing — so without this window, every song queued during that
  // pull concludes the queue is unserved and adds another machine. Then the
  // first pod finishes booting and drains the queue on its own, and the rest
  // wake up to nothing and bill by the hour.
  const booting = pods.filter(p => podRequestedMsAgo(p) < BOOTING_MS).length;
  if (booting > 0) {
    console.log("[song-scale] " + reason + ": " + booting + " pod(s) still booting — creating none");
    return { ok: true, created: 0, running };
  }

  const target = additive ? Math.min(MAX_PODS, running + want) : want;
  const create = Math.max(0, target - running);
  if (!create) {
    console.log("[song-scale] " + reason + ": " + running + " pod(s) up, ceiling " + MAX_PODS + " — creating none");
    return { ok: true, created: 0, running };
  }

  let created = 0, fundingStop = false;
  for (let i = 0; i < create; i++) {
    try {
      await createPod(running + i);
      created++;
    } catch (e) {
      // The expected way this ends at scale is the balance running dry. RunPod
      // refuses, we stop, and the job waits in the queue until there is money
      // to fund a machine. That is the design, not a failure.
      const msg = String((e && e.message) || "");
      if (/balance|insufficient|payment|spend|fund|quota/i.test(msg)) {
        fundingStop = true;
        console.warn("[song-scale] " + reason + ": stopped at " + created + "/" + create + " — account can't fund more right now");
      } else {
        console.error("[song-scale] create failed: " + msg);
      }
      break;
    }
  }
  console.log("[song-scale] " + reason + ": " + running + " up, wanted " + want + ", created " + created + (fundingStop ? " (funding-limited)" : ""));
  return { ok: true, created, running: running + created, fundingLimited: fundingStop };
}

// ── Backstop: terminate song pods that outlived their own lifetime cap ───────
//
// Workers are supposed to retire themselves. On 23 July the video ones did not,
// and pods created at 08:21 were still billing at 19:24. Every way self-
// termination fails looks identical from outside — revoked key, crashed
// process, image built without the retirement code — a healthy pod billing
// forever. So it cannot be the only defence.
//
// The grace period is longer than the video reaper's because a song lease is
// 1800s against a video chunk's 900s. Anything removed here is, by the worker's
// own definition, long past overdue.
//
// This only ever sees `chelgy-song-` pods. It cannot touch a video worker, and
// the video reaper cannot touch these.
const MAX_LIFETIME_MIN = Number(process.env.RUNPOD_SONG_MAX_LIFETIME_MINUTES || 60);
const REAP_GRACE_MIN = Number(process.env.RUNPOD_SONG_REAP_GRACE_MINUTES || 40);

function podAgeMinutes(pod) {
  const m = String((pod && pod.name) || "").match(/^chelgy-song-(\d{10,})-/);
  if (!m) return null;
  const ms = Number(m[1]);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return (Date.now() - ms) / 60000;
}

export async function reapStaleSongPods() {
  if (!KEY) return { ok: false, skipped: "no RUNPOD_API_KEY" };
  const cutoff = MAX_LIFETIME_MIN + REAP_GRACE_MIN;
  let pods;
  try { pods = await listOurPods(); }
  catch (e) { console.error("[song-reap] could not list pods: " + (e && e.message)); return { ok: false }; }

  let killed = 0;
  for (const p of pods) {
    const age = podAgeMinutes(p);
    if (age === null || age < cutoff) continue;
    const id = p && (p.id || p.podId);
    if (!id) continue;
    try {
      await rp("/pods/" + id, { method: "DELETE" });
      killed++;
      console.warn("[song-reap] terminated " + id + " (" + p.name + ") — alive " + Math.round(age) + " min, cap " + cutoff);
    } catch (e) {
      console.error("[song-reap] could not terminate " + id + ": " + (e && e.message));
    }
  }
  if (killed) console.warn("[song-reap] removed " + killed + " overdue pod(s)");
  return { ok: true, killed, checked: pods.length };
}

async function getUserId(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, Authorization: "Bearer " + token } });
    const u = await r.json();
    return r.ok && u && u.id ? u.id : null;
  } catch { return null; }
}

// Called by the app immediately after /song returns `queued: true`.
//
// song-route.js queues and stops there on purpose — it writes a row and nothing
// else. Without this call the row sits at 0% forever, waiting for a machine
// that is waiting for a reason to exist. That is the trap song-route's own
// comment warns about, and this endpoint is the other half of it.
//
// Demand is one, always. The caller queued one song, and a song cannot use a
// second machine. Nothing here needs to read the job table or know what its
// status strings are — one queued song, one pod of its own, ceilinged.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again." });

    // Sweep before adding. This endpoint is hit once per song, which makes it
    // the most reliable heartbeat available without a cron — a stranded pod is
    // cleaned up by the next song rather than by a support ticket.
    reapStaleSongPods().catch(() => {});

    const out = await ensureSongPods(1, "song queued", { additive: true });
    // Never fatal. A failed scale-up means the song waits for a machine, not
    // that it is lost — the row is already queued and any pod will claim it.
    return res.status(200).json({ ok: true, running: (out && out.running) || 0 });
  } catch {
    return res.status(200).json({ ok: false });
  }
}
