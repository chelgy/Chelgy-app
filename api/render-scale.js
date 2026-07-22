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

// There is NO global pod cap, on purpose.
//
// The account that RunPod bills from is the same account credit purchases pay into.
// So the only correct limit is money: a render runs when its customer has paid and
// the balance can fund it, and when the balance is empty RunPod simply stops
// creating pods. Capacity therefore rises with revenue automatically — ten thousand
// paying members fund a far larger fleet than a test balance does — with no number
// in this file to hand-raise as the app grows.
//
// A hard cap here would be a second, dumber gate in front of the one that already
// works, and the failure it produces is the worst kind: turning away a paying
// customer while there is money in the account to serve them.
//
// PER_JOB stays, and it is NOT a spend limit — it's a physics one. Measured on a
// five-chunk edit, the longest single chunk plus the join set a floor no extra pod
// can beat, so a fourth machine on ONE render just idles. This spreads a job for
// speed up to the point speed stops improving; it never limits how many DIFFERENT
// jobs run at once. Override per-job with RUNPOD_MAX_PODS_PER_JOB if that floor ever
// moves.
const PER_JOB = Math.max(1, Number(process.env.RUNPOD_MAX_PODS_PER_JOB) || 3);
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
// `demand` is how many machines THIS job wants — the chunk count, capped only by
// PER_JOB (the physics floor, not a spend limit). Every job gets the pods it needs;
// the balance is what stops runaway spend, and RunPod enforces that itself by
// refusing to create pods once the account can't fund them.
export async function ensurePods(demand, reason) {
  if (!KEY) return { ok: false, skipped: "no RUNPOD_API_KEY" };
  const create = Math.max(0, Math.min(PER_JOB, Number(demand) || 0));
  if (!create) return { ok: true, created: 0 };

  let created = 0, fundingStop = false;
  for (let i = 0; i < create; i++) {
    try {
      await createPod(i);
      created++;
    } catch (e) {
      // The expected way this ends at scale is the balance running dry: RunPod
      // returns an error, we stop, and the job's chunks wait in the queue until
      // there's money to fund a pod. That's the design, not a failure — the paid
      // work resumes on its own the moment the account can fund it.
      const msg = String(e.message || "");
      if (/balance|insufficient|payment|spend|fund|quota/i.test(msg)) {
        fundingStop = true;
        console.warn("[scale] " + reason + ": stopped at " + created + "/" + create + " — account can't fund more right now");
      } else {
        console.error("[scale] create failed: " + msg);
      }
      break;
    }
  }
  console.log("[scale] " + reason + ": wanted " + create + ", created " + created + (fundingStop ? " (funding-limited)" : ""));
  return { ok: true, created, fundingLimited: fundingStop };
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
