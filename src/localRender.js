// Rendering an edit on the customer's own device, in the editor tab.
//
// HOW IT FITS
// The editor starts an edit exactly as before (api/studio-ffmpeg start). When this
// device passed localRenderCaps() and the edit is one the engine reproduces exactly,
// the API routes the job to THIS tab and returns `local: { token, job }`. The editor
// then calls runLocalRender() alongside its normal pollVideo() — nothing else changes.
// pollVideo reads progress from the job row (this file reports it) and gets the
// finished URL the same way it always has.
//
// WHEN SOMETHING GOES WRONG
// An engine error gets one more try on this device. Switching away pauses the render
// (the server waits 30 minutes for the tab to come back). If it still can't finish —
// or the tab is closed — the job is given up: with the pods muted (PODS=off) it fails
// and is refunded in full; with them on, the pods render it from scratch instead.
//
// The engine itself lives in public/render-engine/ (built from browser-engine/).

const ENGINE = "/render-engine/";
const API = "/api/render-local";
const CHECK_IN_MS = 20000;            // lease is 120s on the server; this leaves room for throttled tabs

let capsPromise = null;

// ONE RENDER AT A TIME ON THIS DEVICE. An edit with viral clips is several jobs (the main
// edit, then each clip). Every job is claimed and kept alive at once, so none of them is
// given up on while it waits, but the device renders them in turn: two 4K renders at
// once would only make both slower, and on a phone run it out of memory.
let deviceTurn = Promise.resolve();

// The styles the engine reproduces exactly. MUST match SUPPORTED_STYLES in the engine's
// render.js and LOCAL_STYLES in api/studio-ffmpeg.js.
export const LOCAL_RENDER_STYLES = ["talkinghead", "vlog", "tutorial", "cinematic", "process", "showcase", "fashion", "musicvideo", "musicvideofx", "faceless"];

// Can this device render edits? Answered once per page load. Cheap: no encoding, just
// "does the browser say it can". The real proof is the first render; if that fails the
// pods take it and the customer never knows.
//
// WebKit only for now (Safari on Mac, any browser on iPhone/iPad), because that is what
// has been proven against the pods on real devices: picture, colour range, sync. Other
// browsers stay on the pods until they've been through the Render Lab.
// To test another browser on purpose: localStorage.chelgyLocalRender = "any".
export function localRenderCaps() {
  if (!capsPromise) capsPromise = checkCaps().catch((e) => ({ ok: false, why: String((e && e.message) || e) }));
  return capsPromise;
}

async function checkCaps() {
  if (typeof window === "undefined") return { ok: false, why: "no window" };
  let override = "";
  try { override = String(localStorage.getItem("chelgyLocalRender") || ""); } catch {}
  if (override === "off") return { ok: false, why: "switched off on this device" };
  const ua = navigator.userAgent || "";
  const iOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const macSafari = /Macintosh/.test(ua) && /Version\/\d+.*Safari/.test(ua) && !/Chrome|Chromium|Edg|Firefox|OPR/.test(ua);
  if (override !== "any" && !iOS && !macSafari) return { ok: false, why: "browser not proven yet" };
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") return { ok: false, why: "no OffscreenCanvas" };
  if (typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined" || typeof VideoDecoder === "undefined")
    return { ok: false, why: "no WebCodecs" };

  const [v, a] = await Promise.all([
    VideoEncoder.isConfigSupported({ codec: "avc1.640028", width: 1080, height: 1920, bitrate: 8e6, framerate: 30 }).catch(() => null),
    AudioEncoder.isConfigSupported({ codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 }).catch(() => null),
  ]);
  if (!v || !v.supported) return { ok: false, why: "no H.264 encoder" };
  if (!a || !a.supported) return { ok: false, why: "no AAC encoder" };

  let gpu = "";
  try {
    const gl = new OffscreenCanvas(4, 4).getContext("webgl2");
    if (!gl) return { ok: false, why: "no WebGL2" };
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || "").slice(0, 60);
  } catch { return { ok: false, why: "no WebGL2" }; }

  // The finished file sits in memory until it uploads. Phones get shorter edits.
  const mem = Number(navigator.deviceMemory) || 0;
  const small = iOS || /Android|Mobi/.test(ua) || (mem && mem < 4);
  return { ok: true, maxSeconds: small ? 300 : 1200, video: "avc", audio: "aac", gpu, mobile: !!small, ua: ua.slice(0, 120) };
}

async function call(token, body) {
  const r = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-chelgy-device": token },
    body: JSON.stringify(body),
  });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, ok: r.ok, body: d || {} };
}

// Keeps an iPhone from auto-locking mid-render. Best effort; locking only means the pods finish it.
async function keepScreenOn() {
  let lock = null, stopped = false;
  const get = async () => { try { if (!stopped && document.visibilityState === "visible" && navigator.wakeLock) lock = await navigator.wakeLock.request("screen"); } catch {} };
  const onVis = () => { if (document.visibilityState === "visible") get(); };
  document.addEventListener("visibilitychange", onVis);
  await get();
  return () => { stopped = true; document.removeEventListener("visibilitychange", onVis); try { lock && lock.release(); } catch {} };
}

// Renders job `job` here. `files` maps each source URL to the File the customer picked,
// so footage is read straight off the device rather than downloaded back.
// `wait(ms)` lets the editor pass its throttle-proof timer (cgWait).
// Resolves "done" (finished file uploaded, job complete), "pods" (given up: refunded,
// or handed to the pods if they're on) or
// "stopped" (the server took it back first, e.g. the tab slept). Never throws.
export async function runLocalRender({ token, job, files = {}, wait, onStage } = {}) {
  const sleep = wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const say = (s) => { try { onStage && onStage(s); } catch {} };
  let worker = null, stopped = false, ended = false, heartbeat = false, progress = 0, stage = "Rendering on your device", release = () => {};

  const handBack = async (why) => {
    console.warn("[local render] giving up on this device: " + why);
    if (!stopped) { try { await call(token, { action: "fail", job, error: String(why).slice(0, 240) }); } catch {} }
    return stopped ? "stopped" : "pods";
  };

  try {
    const caps = await localRenderCaps();
    if (!caps.ok) return await handBack("device check: " + caps.why);
    const c = await call(token, { action: "claim", enabled: true, caps });
    const j = c.body && c.body.job;
    if (!j || j.id !== job) return await handBack("couldn't claim the job (" + c.status + ")");
    const edl = j.edl || {};
    const specs = (j.chunks || []).map((x) => ({ idx: x.idx, spec: x.spec }));

    // Checking in. If the server says the job is no longer ours, stop at once.
    heartbeat = true;
    (async () => {
      while (heartbeat) {
        await sleep(CHECK_IN_MS);
        if (!heartbeat) break;
        try {
          const e = await call(token, { action: "extend", job, progress, stage });
          if (e.status === 401 || (e.ok && e.body.ok === false)) {
            stopped = true; heartbeat = false;
            try { worker && worker.terminate(); } catch {}
          }
        } catch { /* network blip: the lease covers several misses */ }
      }
    })();
    const stopScreen = await keepScreenOn();
    // Closing the tab mid-render: say so on the way out, so the pods start now rather
    // than when the lease runs out. (Locking a phone isn't this — that just pauses.)
    const onLeave = () => {
      if (ended || stopped) return;
      try {
        navigator.sendBeacon(API, new Blob([JSON.stringify({ action: "fail", job, error: "tab closed", device_token: token })], { type: "application/json" }));
      } catch {}
    };
    window.addEventListener("pagehide", onLeave);
    release = () => { stopScreen(); window.removeEventListener("pagehide", onLeave); };

    // Wait for this device to be free. Checking in carries on meanwhile.
    const before = deviceTurn;
    let freeDevice;
    deviceTurn = new Promise((r) => { freeDevice = r; });
    const releaseTurn = release;
    release = () => { try { freeDevice(); } catch {} releaseTurn(); };
    await before;
    if (stopped) { heartbeat = false; return "stopped"; }

    say("Rendering on your device — keep Chelgy open until it's done.");
    const renderOnce = () => new Promise((resolve, reject) => {
      worker = new Worker(ENGINE + "render-worker.js", { type: "module", name: "chelgy-render" });
      worker.onerror = (e) => reject(new Error("engine failed to load: " + ((e && e.message) || "")));
      worker.onmessage = (ev) => {
        const m = ev.data || {};
        if (m.type === "progress") {
          // Video is the bulk of the work; leave room for audio + upload.
          if (m.stage === "video" && m.total) progress = Math.max(progress, Math.min(85, Math.round(2 + 83 * m.done / m.total)));
          else if (m.stage === "audio") { progress = Math.max(progress, 87); stage = "Mixing the sound"; }
        } else if (m.type === "done") resolve(m);
        else if (m.type === "error") reject(new Error(m.error));
      };
      // Stopped by the heartbeat: there will be no message, so poll for it.
      (async () => { while (!stopped && !ended) await sleep(1000); if (stopped) reject(new Error("stopped")); })();
      worker.postMessage({
        plan: { edl, specs, fps: Number(edl.fps) || 30, size: edl.size || { w: 1080, h: 1920 } },
        files, assetBase: location.origin + "/", wasmUrl: location.origin + ENGINE + "jassub-worker.wasm", strict: true,
      });
    }).finally(() => { try { worker && worker.terminate(); } catch {} });
    // ONE MORE TRY ON THE DEVICE before giving up. The usual cause of an engine error is
    // Safari throwing the video encoder away while the page was in the background; a
    // fresh start on return almost always goes through. Anything the engine said it
    // doesn't support is not retried — it would only fail the same way.
    let res = null;
    for (let attempt = 0; attempt < 2 && !res; attempt++) {
      try { res = await renderOnce(); }
      catch (e) {
        const msg = String((e && e.message) || e);
        if (stopped || msg === "stopped" || attempt === 1 || /not supported/.test(msg)) throw e;
        console.warn("[local render] trying again on this device: " + msg.split("\n")[0]);
        progress = 2; stage = "Rendering on your device (second try)";
        while (document.visibilityState === "hidden" && !stopped) await sleep(1000);   // wait until she's back
      }
    }
    if (stopped) { heartbeat = false; return "stopped"; }

    // Trust the file, not the message.
    const chunks = (res.stats && res.stats.chunks) || [];
    const missing = chunks.reduce((t, ch) => t + (Number(ch.nulls) || 0), 0);
    const expected = specs.reduce((t, s) => t + (Number(s.spec && s.spec.frames) || 0), 0);
    if (res.videoCodec !== "avc" || res.audioCodec !== "aac") { heartbeat = false; return await handBack("codecs " + res.videoCodec + "/" + res.audioCodec); }
    if (missing > 0) { heartbeat = false; return await handBack(missing + " missing frames"); }
    if (expected && Math.abs((res.frames || 0) - expected) > 2) { heartbeat = false; return await handBack("frame count " + res.frames + " of " + expected); }
    if (!res.bytes || res.bytes.byteLength < 10000) { heartbeat = false; return await handBack("empty file"); }

    progress = 90; stage = "Uploading"; say("Uploading your video…");
    const blob = new Blob([res.bytes], { type: "video/mp4" });
    let uploaded = false;
    for (let attempt = 0; attempt < 3 && !uploaded && !stopped; attempt++) {
      try {
        const u = await call(token, { action: "upload_url", job });
        if (u.status === 409 || u.status === 401) { stopped = true; break; }
        if (!u.ok || !u.body.url) throw new Error("no upload link");
        const put = await fetch(u.body.url, { method: "PUT", headers: { "Content-Type": "video/mp4", "x-upsert": "true" }, body: blob });
        if (!put.ok) throw new Error("upload " + put.status);
        uploaded = true;
      } catch (e) {
        console.warn("[local render] upload attempt " + (attempt + 1) + ": " + ((e && e.message) || e));
        await sleep(2000 * (attempt + 1));
      }
    }
    if (stopped) { heartbeat = false; return "stopped"; }
    if (!uploaded) { heartbeat = false; return await handBack("upload failed"); }

    const d = await call(token, { action: "done", job });
    heartbeat = false;
    if (d.ok) return "done";
    if (d.status === 409 && /not yours/.test(String(d.body.error || ""))) return "stopped";
    return await handBack("done refused: " + (d.body.error || d.status));
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (stopped || msg === "stopped") return "stopped";
    return await handBack(msg.split("\n")[0]);
  } finally {
    ended = true; heartbeat = false;
    release();
  }
}

// What the pods used to do before planning: pull the speech audio (small .m4a for the
// transcriber) and the movement track straight off the clip on this device.
// One clip at a time: several 4K decodes at once is more than a phone wants.
// Resolves { audio: ArrayBuffer, activity } or null (then the editor falls back).
let analyzeChain = Promise.resolve();
export function analyzeOnDevice(file, { wantActivity = false, onProgress } = {}) {
  const run = async () => {
    const caps = await localRenderCaps();
    if (!caps.ok || !file) return null;
    const w = new Worker(ENGINE + "render-worker.js", { type: "module", name: "chelgy-analyze" });
    try {
      const r = await new Promise((resolve, reject) => {
        w.onerror = (e) => reject(new Error("engine failed to load: " + ((e && e.message) || "")));
        w.onmessage = (ev) => {
          const m = ev.data || {};
          if (m.type === "progress" && onProgress) { try { onProgress(m.done); } catch {} }
          else if (m.type === "analyzed") resolve(m);
          else if (m.type === "error") reject(new Error(m.error));
        };
        w.postMessage({ analyze: { file, wantAudio: true, wantActivity } });
      });
      if (!r.audio || r.audioCodec !== "aac") return null;
      return { audio: r.audio, activity: r.activity || null, duration: r.duration };
    } catch (e) {
      console.warn("[local analyze] " + String((e && e.message) || e).split("\n")[0]);
      return null;
    } finally { try { w.terminate(); } catch {} }
  };
  const p = analyzeChain.then(run, run);
  analyzeChain = p.catch(() => {});
  return p;
}

// The score's tempo and first downbeat, measured here — what the render server's beat.js
// did before planning a style that cuts to the music. Same maths, same answers. Resolves
// { bpm, phase } or null (no snap, which is also what the pods did when they found none).
export async function findBeatOnDevice(url, hint) {
  try {
    const caps = await localRenderCaps();
    if (!caps.ok || !url) return null;
    const w = new Worker(ENGINE + "render-worker.js", { type: "module", name: "chelgy-beat" });
    try {
      const m = await Promise.race([
        new Promise((resolve) => { w.onmessage = (ev) => resolve(ev.data || {}); w.onerror = () => resolve({}); w.postMessage({ beat: { url, hint, seconds: 60 } }); }),
        new Promise((resolve) => setTimeout(() => resolve({}), 30000)),   // the pods' own 30s cap
      ]);
      return m.type === "beat" ? m.beat || null : null;
    } finally { try { w.terminate(); } catch {} }
  } catch { return null; }
}

// Music video: what the render server's musicvideo-route.js did before planning — hear
// the song and every clip, line each clip up with the song, find the beat, plan the cut.
// Same code as the render server's (align-clip.js, musicvideo-plan.js), same answers.
// song: File. clips: [{ file, klass, singing }]. Resolves { segments, warnings, stats, beat }
// or throws with a message she can read.
export async function musicVideoOnDevice({ song, clips, pace, onStage } = {}) {
  const w = new Worker(ENGINE + "render-worker.js", { type: "module", name: "chelgy-musicvideo" });
  try {
    return await new Promise((resolve, reject) => {
      w.onerror = (e) => reject(new Error("The video engine didn't load on this device. " + ((e && e.message) || "")));
      w.onmessage = (ev) => {
        const m = ev.data || {};
        if (m.type === "stage" && onStage) { try { onStage(m.stage); } catch {} }
        else if (m.type === "musicvideo") resolve(m);
        else if (m.type === "error") reject(new Error(String(m.error || "").split("\n")[0] || "Couldn't match the footage to the song."));
      };
      w.postMessage({ musicvideo: { song, clips, pace } });
    });
  } finally { try { w.terminate(); } catch {} }
}
