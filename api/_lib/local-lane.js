// Shared by api/studio-ffmpeg.js and api/studio-shorts.js: everything needed to send a
// render to the customer's own device instead of the render server and its pods.
import crypto from "node:crypto";
// The render server's own planner and beat snap (job-plan.js planChunks, beat.js
// snapToBeat), bundled to run here. Identical chunk specs to the render server's.
import { planChunks, snapToBeat } from "./plan-chunks.js";

const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_SVC = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

// A one-edit "device" for the browser tab that will render this job. Same lane system
// as a linked Mac: the database routes the job to it, it checks in while it works, and
// if it stops (tab closed, phone locked, render failed) the job moves to the pods.
export async function registerBrowserDevice(userId, caps) {
  try {
    const small = {};
    for (const [k, v] of Object.entries(caps && typeof caps === "object" ? caps : {}).slice(0, 30))
      if (v === null || ["boolean", "number"].includes(typeof v)) small[k.slice(0, 40)] = v;
      else if (typeof v === "string") small[k.slice(0, 40)] = v.slice(0, 80);
    small.ok = true;
    const token = crypto.randomBytes(32).toString("base64url");
    const r = await fetch(SB_URL + "/rest/v1/rpc/register_browser_render_device", {
      method: "POST",
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json" },
      body: JSON.stringify({ p_user: userId, p_token_hash: crypto.createHash("sha256").update(token).digest("hex"), p_caps: small })
    });
    const t = r.ok ? (await r.text()).trim() : "";
    let id = null; try { id = JSON.parse(t); } catch { id = t; }
    if (!r.ok) console.error("[local] couldn't register this browser: " + r.status);
    return typeof id === "string" && id ? { id, token } : null;
  } catch (e) { console.error("[local] couldn't register this browser: " + ((e && e.message) || e)); return null; }
}

// PLANNING WITHOUT THE RENDER SERVER, for edits going to the customer's device.
//
// What the render server's /plan does (job-plan.js planJob), done here: split the edit
// into chunk specs and write the job + chunk rows. A device render needs nothing else
// from the render server, so it no longer depends on that machine being up at all.
// planJob's one extra step is snapping cuts to the beat of the score (fashion and
// showcase). The beat itself is measured on the device (engine beat.js, same maths, same
// answers as the render server's); the snap is the render server's own function.
const SNAPPABLE = ["fashion", "showcase"];
export async function planHere({ userId, edl, creditsCharged }, beat) {
  if (edl.music && SNAPPABLE.includes(String(edl.style || "")) && beat) {
    const r = snapToBeat(edl.segments || [], beat, 0.15);
    edl.segments = r.segments;
    console.log("[plan] beat " + beat.bpm + " BPM (phase " + beat.phase + "s), snapped " + r.moved + " of " + edl.segments.length + " cuts");
  }
  const { specs } = planChunks(edl);
  if (!specs.length) throw new Error("That edit has nothing to render.");
  const H = { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json" };
  const r = await fetch(SB_URL + "/rest/v1/render_jobs", {
    method: "POST", headers: { ...H, Prefer: "return=representation" },
    body: JSON.stringify({ user_id: userId, edl, status: "rendering", stage: "Rendering",
                           chunk_total: specs.length, credits_charged: creditsCharged || 0, edl_hash: edl.hash || null })
  });
  const rows = await r.json().catch(() => null);
  const job = Array.isArray(rows) ? rows[0] : null;
  if (!r.ok || !job || !job.id) throw new Error("couldn't save the job (" + r.status + ")");
  // Every chunk in ONE request, same as planJob, so the set is never seen half-written.
  const c = await fetch(SB_URL + "/rest/v1/render_chunks", {
    method: "POST", headers: { ...H, Prefer: "return=minimal" },
    body: JSON.stringify(specs.map((x) => ({ job_id: job.id, idx: x.idx, spec: x.spec })))
  });
  if (!c.ok) throw new Error("couldn't save the chunks (" + c.status + ")");
  return { jobId: job.id, chunks: specs.length };
}

// Same reply shape as the render server's /plan, so the code after it doesn't change.
export async function planVia(here, url, init, beat) {
  if (!here) return fetch(url, init);
  try {
    const b = JSON.parse(init.body);
    const d = await planHere(b, beat);
    return { ok: true, status: 200, json: async () => d };
  } catch (e) {
    console.error("[plan] planning here failed: " + ((e && e.message) || e));
    const msg = "Couldn't set up the render (" + ((e && e.message) || "unknown") + ").";
    return { ok: false, status: 500, json: async () => ({ error: msg }) };
  }
}
