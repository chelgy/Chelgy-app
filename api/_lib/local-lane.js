// Shared by api/studio-ffmpeg.js and api/studio-shorts.js: everything needed to send a
// render to the customer's own device instead of the render server and its pods.
import crypto from "node:crypto";
// The render server's own planner and beat snap (job-plan.js planChunks, beat.js
// snapToBeat), bundled to run here. Identical chunk specs to the render server's.
import { planChunks, snapToBeat, buildAssEvents, assForWindow } from "./plan-chunks.js";

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
  return saveJob({ userId, edl, creditsCharged }, specs);
}

// Write the job and its chunks, the way planJob does. The database trigger routes the
// job to the device named in edl.localDevice the moment the row lands.
export async function saveJob({ userId, edl, creditsCharged }, specs) {
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

// ── FACELESS VIDEOS ON THE DEVICE ──────────────────────────────────────────────────
// What the render server's commercial.js did with a faceless plan, as chunk specs for
// the device engine: one chunk per picture (its frames, its push / pull / hold), the
// title over the opening seconds, and the word-by-word captions sliced to each shot
// (buildAssEvents + assForWindow, the render server's own caption code, bundled).
export const FACELESS_FPS = 30;
const isUrl = (v) => typeof v === "string" && /^https?:\/\//.test(v);
export function planFaceless({ plan, words, orientation, voUrl, musicUrl }) {
  const fps = FACELESS_FPS;
  const size = orientation === "landscape" ? { w: 1920, h: 1080 } : { w: 1080, h: 1920 };
  const sources = new Map((Array.isArray(plan && plan.sources) ? plan.sources : []).map((s) => [String(s && s.id), s]));
  const timeline = Array.isArray(plan && plan.timeline) ? plan.timeline : [];
  if (!timeline.length) throw new Error("That plan has no timeline.");
  if (timeline.length > 120) throw new Error("Too many shots (" + timeline.length + ").");
  if (!isUrl(voUrl)) throw new Error("The voiceover is missing.");
  const shots = [];
  let at = 0;
  for (const e of timeline) {
    const src = sources.get(String(e && e.src));
    if (!src || !isUrl(src.url)) throw new Error("A picture hasn't finished generating yet.");
    const dur = Number(e.out) - (Number(e.in) || 0);
    if (!(dur > 0) || dur > 8.01) throw new Error("A shot is " + (dur > 0 ? dur.toFixed(1) + "s" : "empty") + "; each picture holds 8 seconds at most.");
    const frames = Math.max(1, Math.round(dur * fps));
    const fx = Array.isArray(e.fx) ? e.fx.map(String) : [];
    shots.push({ url: src.url, frames, start: at, move: fx.includes("push") ? "push" : fx.includes("pull") ? "pull" : "",
                 title: e.title ? { text: String(e.title).slice(0, 80), from: Math.max(0, Number(e.titleFrom) || 0), to: Number(e.titleTo) || 0, font: "Monoton-Regular.ttf" } : null });
    at += frames / fps;
  }
  const total = at;
  let header = null, events = null;
  const w = (Array.isArray(words) ? words : []).slice(0, 20000)
    .map((x) => ({ w: String((x && (x.w || x.word || x.text)) || "").slice(0, 60), s: Number(x && (x.s ?? x.start)) || 0, e: Number(x && (x.e ?? x.end)) || 0 }))
    .filter((x) => x.w && x.e >= x.s);
  if (w.length) {
    // perLine 1 and fontScale 0.055: the commercial caption style (one word at a time).
    const built = buildAssEvents(w, [{ clip: 0, s: 0, e: total }], size, { fontPack: "editorial", perLine: 1, fontScale: 0.055 }, "");
    header = built.header; events = built.events;
  }
  const specs = shots.map((sh, idx) => ({ idx, spec: {
    kind: "still", url: sh.url, frames: sh.frames, move: sh.move, title: sh.title,
    ass: header ? assForWindow(header, events, sh.start, sh.start + sh.frames / fps) : null,
  } }));
  const musicDb = Number.isFinite(Number(plan.musicDb)) ? Math.max(-40, Math.min(0, Number(plan.musicDb))) : -27;
  const edl = { style: "faceless", fps, size, orientation: orientation === "landscape" ? "landscape" : "portrait",
                voice: voUrl, music: isUrl(musicUrl) ? musicUrl : null, musicDb };
  return { edl, specs, seconds: total };
}

// A score the device can read. Generated scores live on the music provider's servers,
// which a browser may not be allowed to fetch from; a copy in our own storage always is.
export async function copyToStorage(url, path) {
  try {
    if (!isUrl(url) || url.indexOf(SB_URL + "/storage/") === 0) return url;
    // Only a public https address, never a machine on a private network.
    const host = new URL(url).hostname.toLowerCase();
    if (new URL(url).protocol !== "https:" || host === "localhost" || /^[\d.:\[\]]+$/.test(host) || host.endsWith(".internal") || host.endsWith(".local")) return url;
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) return url;
    const type = String(r.headers.get("content-type") || "").toLowerCase();
    if (type && !/^(audio\/|application\/octet-stream|binary\/octet-stream|video\/mp4)/.test(type)) return url;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 40 * 1024 * 1024) return url;
    const up = await fetch(SB_URL + "/storage/v1/object/sites/" + path, {
      method: "POST",
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": r.headers.get("content-type") || "audio/mpeg", "x-upsert": "true" },
      body: buf,
    });
    return up.ok ? SB_URL + "/storage/v1/object/public/sites/" + path : url;
  } catch { return url; }
}
