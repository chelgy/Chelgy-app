// api/cron-reap-song-pods.js
//
// Kill overdue song pods on a SCHEDULE, not just when a song happens to be
// queued.
//
// The bug this closes: reapStaleSongPods() was only ever called inside the
// /api/studio-song POST handler — so a pod that finished a song, went idle, and
// failed to self-terminate (missing pod id, or a pod-scoped key that 403s the
// DELETE) would keep billing until the NEXT song was made. No song for six
// hours meant six hours of billing. A machine that can't turn itself off must
// have something outside it that will, on a clock — and that is this.
//
// Wired as a Vercel Cron (see vercel.json). Vercel calls it on a schedule with
// a header we verify, so it can't be triggered by the public.

import { reapStaleSongPods } from "./song-scale.js";

export default async function handler(req, res) {
  // Vercel Cron sets this header. Refuse anything else so the endpoint can't be
  // hit from outside to probe or spam RunPod.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || "";
    if (auth !== "Bearer " + secret) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }
  try {
    const out = await reapStaleSongPods();
    // Log so the sweep is visible in Vercel's function logs even when it kills
    // nothing — "checked N, killed 0" is the healthy heartbeat we want to see.
    console.log("[cron-reap] " + JSON.stringify(out));
    return res.status(200).json(out || { ok: true });
  } catch (e) {
    console.error("[cron-reap] failed: " + ((e && e.message) || e));
    return res.status(500).json({ ok: false, error: (e && e.message) || "reap failed" });
  }
}
