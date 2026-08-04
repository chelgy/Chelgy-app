// api/studio-song.js
//
// SONG STUDIO — the browser's only door to a song render.
//
// The render server authenticates with a shared `x-render-secret` header, which
// can never be handed to a browser, so every song request goes through here the
// same way commercial renders do.
//
// This also closes the gap song-route.js warns about in its own comments. That
// route queues a row and stops — deliberately, because the API has no GPU — and
// something has to notice that a machine is now required. Without the scale call
// below, a queued song sits at 0% forever waiting for a pod that is waiting for
// a reason to exist.
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
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const userId = await getUserId(token);
  if (!userId) return res.status(401).json({ error: "Please log in again." });

  // Said plainly rather than as a 502 from a fetch to "". A missing env var and
  // a render server that is down look identical from the browser otherwise.
  if (!RS_URL || !RS_SECRET) {
    return res.status(500).json({ error: "The song engine isn't configured yet." });
  }

  try {
    if (req.method === "GET") {
      const jobId = String((req.query && req.query.jobId) || "").trim();
      if (!jobId) return res.status(400).json({ error: "Missing jobId." });
      const out = await rs("/song/" + encodeURIComponent(jobId), { method: "GET" });
      return res.status(out.status).json(out.body);
    }

    if (req.method === "POST") {
      const out = await rs("/song", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body || {}),
      });

      // Awaited, not fired and forgotten. A serverless function can be frozen
      // the moment it responds, so a background promise here would sometimes
      // create a pod and sometimes silently not — and the failure would look
      // like a song that renders quickly on some days and never on others.
      if (out.ok && out.body && out.body.queued) {
        try {
          await ensureSongPods(1, "song queued", { additive: true });
        } catch (e) {
          // Never fatal. The row is queued and any pod will claim it; a failed
          // scale-up means the song waits, not that it is lost.
          console.error("[studio-song] scale-up failed: " + ((e && e.message) || e));
        }
      }
      return res.status(out.status).json(out.body);
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(502).json({ error: "Couldn't reach the song engine." });
  }
}
