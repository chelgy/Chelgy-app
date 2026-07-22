// Chelgy — bring GPU workers up when there's work, and let them put themselves away.
//
// THE PROBLEM THIS SOLVES
// Pods were started and terminated by hand. That isn't a product: renders only
// worked while someone was awake and watching, and a pod left running overnight
// costs about $9.40 whether or not anyone rendered anything.
//
// WHEN PODS START, AND WHY IT ISN'T "WHEN THERE'S WORK"
// The obvious trigger is chunks appearing in the queue. Measured, that's too late:
// a pod takes 30-60 seconds from create to `[worker] ready` even with the image
// cached, and a five-chunk render finishes in about 100 seconds. Waiting for chunks
// means the pod arrives when the job is nearly over.
//
// So the trigger is the START OF PLANNING. Transcription, planning, b-roll and the
// score take two to four minutes of work that was happening anyway, and pods warm
// up inside that window. The warm-up costs roughly three cents and is the
// difference between automation helping and automation being decorative.
//
// HOW MANY
// Measured on a real five-chunk edit across four pods: chunks were claimed within
// two seconds of each other, none twice, and the whole render took 1m45s against
// about 3m47s sequentially. But the longest single chunk was 65 seconds and the
// join 34 — so no number of machines finishes that job faster than about 1m40.
// Past three pods the gain is noise, and the real fix for speed is splitting long
// segments, not adding hardware.
//
// Env: RUNPOD_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
//      optional: RUNPOD_MAX_PODS, RUNPOD_GPU_TYPES, RUNPOD_IMAGE, RUNPOD_COUNTRIES,
//                RUNPOD_REGISTRY_AUTH_ID, RUNPOD_IDLE_MINUTES, RUNPOD_MAX_LIFETIME_MINUTES

export const maxDuration = 30;

const RP = "https://rest.runpod.io/v1";
const KEY = (process.env.RUNPOD_API_KEY || "").trim();

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const BUCKET  = (process.env.BUCKET || "sites").trim();

// Three is the measured point of diminishing returns, and at $0.40/hr it's also a
// worst case that can be absorbed if something ever loops.
const MAX_PODS = Math.max(1, Math.min(8, Number(process.env.RUNPOD_MAX_PODS) || 3));
const IMAGE = (process.env.RUNPOD_IMAGE || "ghcr.io/chelgy/chelgy-worker:latest").trim();
// L4 is what's been measured. A list rather than one id so a region short of L4s
// can fall through to the next acceptable card instead of failing to create.
const GPU_TYPES = (process.env.RUNPOD_GPU_TYPES || "NVIDIA L4").split(",").map(s => s.trim()).filter(Boolean);
// Supabase is us-east-1. Pods were running in Romania, which meant every chunk
// pulled footage across the Atlantic and pushed the result back. Country rather
// than a datacenter id, so RunPod picks whichever US region actually has capacity.
const COUNTRIES = (process.env.RUNPOD_COUNTRIES || "US").split(",").map(s => s.trim()).filter(Boolean);
// Only needed once the worker image is private. Set it and nothing else changes.
const REGISTRY_AUTH = (process.env.RUNPOD_REGISTRY_AUTH_ID || "").trim();

// Every pod we create is named so it can be told apart from anything started by
// hand. The scaler only ever counts and terminates its own.
const POD_PREFIX = "chelgy-auto-";

async function rp(path, init) {
  const r = await fetch(RP + path, {
    ...init,
    headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json", ...((init && init.headers) || {}) }
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) throw new Error("runpod " + path + ": " + r.status + " " + String(text).slice(0, 200));
  return body;
}

// What's already up. Counted from RunPod itself rather than from anything we store,
// because a cached count is a count that can be wrong in the expensive direction.
async function listOurPods() {
  const pods = await rp("/pods", { method: "GET" });
  const arr = Array.isArray(pods) ? pods : (pods && pods.data) || [];
  return arr.filter(p => String((p && p.name) || "").startsWith(POD_PREFIX));
}

// The credentials a worker needs, passed at creation.
//
// NOT stored on the RunPod template. One source of truth: rotate the service-role
// key in Vercel and every pod created after that picks it up. Split across two
// places, the one you forget fails silently — a worker with no credentials claims
// nothing, logs nothing useful, and bills $0.40/hr looking healthy.
function workerEnv() {
  return {
    SUPABASE_URL: SB_URL,
    SUPABASE_SERVICE_ROLE_KEY: SB_SVC,
    BUCKET,
    NVIDIA_DRIVER_CAPABILITIES: "all",   // load-bearing: the Vulkan ICD workaround needs driver access
    RUNPOD_API_KEY: KEY,                 // so the worker can terminate ITSELF when idle
    RUNPOD_IDLE_MINUTES: String(process.env.RUNPOD_IDLE_MINUTES || 3),
    RUNPOD_MAX_LIFETIME_MINUTES: String(process.env.RUNPOD_MAX_LIFETIME_MINUTES || 60)
  };
}

async function createPod(n) {
  const body = {
    name: POD_PREFIX + Date.now() + "-" + n,
    imageName: IMAGE,
    gpuTypeIds: GPU_TYPES,
    gpuCount: 1,
    containerDiskInGb: 50,
    volumeInGb: 0,              // workers keep nothing between jobs; everything goes to storage
    cloudType: "SECURE",
    computeType: "GPU",
    countryCodes: COUNTRIES,
    gpuTypePriority: "availability",
    env: workerEnv()
  };
  if (REGISTRY_AUTH) body.containerRegistryAuthId = REGISTRY_AUTH;
  return await rp("/pods", { method: "POST", body: JSON.stringify(body) });
}

// Bring the fleet up to `desired`, never past the cap, never down.
//
// Scaling DOWN is deliberately not done here. A pod knows whether it's mid-chunk
// and this function doesn't — killing from the outside would abandon work that has
// to wait out a fifteen-minute lease before anyone retries it. Workers retire
// themselves instead.
export async function ensurePods(desired, reason) {
  if (!KEY) return { ok: false, skipped: "no RUNPOD_API_KEY" };
  const want = Math.max(0, Math.min(MAX_PODS, Number(desired) || 0));
  if (!want) return { ok: true, created: 0, running: 0 };

  let existing = [];
  try { existing = await listOurPods(); }
  catch (e) {
    // Can't see the fleet — do nothing rather than guess. Creating blind is how you
    // end up with eleven pods and a surprise bill.
    console.error("[scale] couldn't list pods: " + e.message);
    return { ok: false, error: e.message };
  }

  const create = Math.max(0, want - existing.length);
  if (!create) return { ok: true, created: 0, running: existing.length };

  let created = 0;
  for (let i = 0; i < create; i++) {
    try { await createPod(i); created++; }
    catch (e) { console.error("[scale] create failed: " + e.message); break; }
  }
  console.log("[scale] " + reason + ": wanted " + want + ", had " + existing.length + ", created " + created);
  return { ok: true, created, running: existing.length + created };
}

async function getUserId(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, Authorization: "Bearer " + token } });
    const u = await r.json();
    return r.ok && u && u.id ? u.id : null;
  } catch { return null; }
}

// The early warm-up, called when planning starts.
//
// Deliberately starts ONE pod, not three. At this point nobody knows how many
// chunks the edit will produce — that isn't decided until the plan comes back. One
// pod covers the common case and costs about a cent; the exact number is set later
// by the render step, which knows the real chunk count.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again." });

    const out = await ensurePods(1, "warm-up at planning");
    // Never fatal. A warm-up that fails means a slower render, not a broken one —
    // the render step will start pods itself when it knows the chunk count.
    return res.status(200).json({ ok: true, running: (out && out.running) || 0 });
  } catch (e) {
    return res.status(200).json({ ok: false });
  }
}
