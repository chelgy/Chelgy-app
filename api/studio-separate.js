// api/studio-separate.js
//
// SONG STUDIO — the browser's only door to a stem separation.
//
// Deliberately shaped like studio-song.js: the render server authenticates with
// a shared `x-render-secret` that can never be handed to a browser, so every
// request goes through here.
//
// The important part is the scale call. song-route.js queues a row and stops —
// correctly, because the API has no GPU — so something has to notice a machine
// is now required. Without ensureSongPods below, a queued separation sits at 0%
// forever waiting for a pod that is waiting for a reason to exist. Same trap
// studio-song.js documents, same fix.
//
// Status is NOT duplicated here. Separation writes to the same song_jobs table,
// so /api/studio-song?jobId=… already answers for it — a second status endpoint
// would be a second thing to keep in sync for no gain.
//
// Env (Vercel): RENDER_SERVER_URL, RENDER_SECRET, SUPABASE_URL, SUPABASE_ANON_KEY

import { ensureSongPods } from "./song-scale.js";
import { spendCredits, refundCredits, SONG_COSTS } from "./song-credits.js";

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

  // Said plainly rather than as a 502 from a fetch to "". A missing env var and
  // a render server that is down look identical from the browser otherwise.
  if (!RS_URL || !RS_SECRET) {
    return res.status(500).json({ error: "The song engine isn't configured yet." });
  }

  try {
    const b = req.body || {};

    // ── PAY FIRST ──
    // This ran GPU pods for free: the endpoint authenticated and queued, and
    // nothing anywhere deducted. Deduct before queueing, refund if the queue
    // call fails, so a customer is never charged for a job that never existed.
    const cost = SONG_COSTS.separate;
    const paid = await spendCredits(token, cost, "song:separate");
    if (!paid.ok) return res.status(402).json({ error: paid.error });

    let out;
    try {
      out = await rs("/separate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceUrl: String(b.sourceUrl || ""),
          sessionId: String(b.sessionId || ""),
          parentStemId: String(b.parentStemId || ""),
          label: String(b.label || ""),
          twoStems: b.twoStems === "vocals" ? "vocals" : "",
          userId,
        }),
      });
    } catch (e) {
      // The render server being unreachable is not the customer's fault and
      // must not cost them anything. Refund, then let the outer catch answer.
      await refundCredits(userId, cost, "refund:separate-unreachable");
      throw e;
    }

    // Nothing queued means nothing to pay for.
    if (!out.ok || !out.body || !out.body.jobId) {
      await refundCredits(userId, cost, "refund:separate-queue-failed");
      return res.status(out.status || 502).json({
        error: ((out.body && out.body.error) || "Couldn't start the separation.") + " Your credits were refunded.",
      });
    }

    // Awaited, not fired and forgotten. A serverless function can be frozen the
    // moment it responds, so a background promise here would sometimes create a
    // pod and sometimes silently not — and the failure would look like
    // separation working on some days and hanging on others.
    if (out.ok && out.body && out.body.queued) {
      try {
        await ensureSongPods(1, "separation queued", { additive: true });
      } catch (e) {
        // Never fatal. The row is queued and any song pod will claim it; a
        // failed scale-up means it waits, not that it is lost.
        console.error("[studio-separate] scale-up failed: " + ((e && e.message) || e));
      }
    }

    return res.status(out.status).json({ ...out.body, balance: paid.balance });
  } catch (e) {
    return res.status(502).json({ error: "Couldn't reach the song engine." });
  }
}
