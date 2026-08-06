// api/studio-mix.js
//
// SONG STUDIO — the browser's only door to a mixdown.
//
// Same shape as studio-song.js and studio-separate.js: the render server
// authenticates with a shared `x-render-secret` that can never reach a browser.
//
// The scale call is the load-bearing part. song-route.js queues a row and stops
// — correctly, it has no GPU — so without ensureSongPods a queued mix sits at 0%
// forever waiting for a pod that is waiting for a reason to exist.
//
// Status is not duplicated here: mixes write to the same song_jobs table, so
// /api/studio-song?jobId=… already answers for them.
//
// Env (Vercel): RENDER_SERVER_URL, RENDER_SECRET, SUPABASE_URL, SUPABASE_ANON_KEY

import { ensureSongPods } from "./song-scale.js";

export const maxDuration = 30;

const RS_URL = (process.env.RENDER_SERVER_URL || "").trim().replace(/\/+$/, "");
const RS_SECRET = (process.env.RENDER_SECRET || "").trim();
const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();

async function getUserId(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", {
      headers: { apikey: SB_ANON, Authorization: "Bearer " + token },
    });
    const u = await r.json();
    return r.ok && u && u.id ? u.id : null;
  } catch { return null; }
}

async function rs(path, init) {
  const r = await fetch(RS_URL + path, {
    ...init,
    headers: { "x-render-secret": RS_SECRET, ...((init && init.headers) || {}) },
  });
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: String(text).slice(0, 300) }; }
  return { status: r.status, ok: r.ok, body };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const userId = await getUserId(token);
  if (!userId) return res.status(401).json({ error: "Please log in again." });

  if (!RS_URL || !RS_SECRET) {
    return res.status(500).json({ error: "The song engine isn't configured yet." });
  }

  try {
    const b = req.body || {};
    // userId from the VERIFIED token, never the body — the route uses it to
    // decide whose session this is.
    const out = await rs("/mix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: String(b.sessionId || ""),
        label: String(b.label || ""),
        userId,
      }),
    });

    // Awaited, not fired and forgotten: a serverless function can be frozen the
    // moment it responds, so a background promise would sometimes create a pod
    // and sometimes silently not.
    if (out.ok && out.body && out.body.queued) {
      try {
        await ensureSongPods(1, "mix queued", { additive: true });
      } catch (e) {
        console.error("[studio-mix] scale-up failed: " + ((e && e.message) || e));
      }
    }

    return res.status(out.status).json(out.body);
  } catch (e) {
    return res.status(502).json({ error: "Couldn't reach the song engine." });
  }
}
