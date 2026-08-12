// api/song-master.js
//
// SONG STUDIO — proxy for MIX & MASTER.
//
// The browser never talks to the render server directly (RENDER_SECRET lives
// here, in Vercel's env, like studio-song does it). This validates the person,
// forwards the request with the secret and their user id, and relays the
// mastered file's URL back.
//
// Env: RENDER_SERVER_URL, RENDER_SECRET, SUPABASE_URL, SUPABASE_ANON_KEY

import { spendCredits, refundCredits, SONG_COSTS } from "./song-credits.js";

export const maxDuration = 60;

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

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!RS_URL || !RS_SECRET)
    return res.status(500).json({ error: "Mastering isn't configured yet." });

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const userId = await getUserId(token);
  if (!userId) return res.status(401).json({ error: "Please log in again." });

  const { audioUrl = "", intensity = "warm" } = req.body || {};
  if (!/^https?:\/\//.test(String(audioUrl)))
    return res.status(400).json({ error: "Missing the track's URL." });

  // ── PAY FIRST ──
  // This endpoint verified the caller and then mastered for free — no deduction
  // existed anywhere in the path. Mastering answers synchronously, so unlike the
  // queued jobs this one knows within the same request whether it worked, and
  // every failure below refunds in full.
  const cost = SONG_COSTS.master;
  const paid = await spendCredits(token, cost, "song:master");
  if (!paid.ok) return res.status(402).json({ error: paid.error });

  try {
    const r = await fetch(RS_URL + "/master", {
      method: "POST",
      // The render server authenticates with the shared x-render-secret
      // header (same as every other proxy here) — NOT a bearer token.
      headers: { "Content-Type": "application/json",
                 "x-render-secret": RS_SECRET },
      body: JSON.stringify({ audioUrl, intensity, userId }),
    });
    const j = await r.json().catch(() => ({}));

    // The browser treats a missing `url` as a failure, so this has to as well —
    // a 200 with no file is still nothing delivered.
    if (!r.ok || !j || !j.url) {
      await refundCredits(userId, cost, "refund:master-failed");
      return res.status(r.status && r.status !== 200 ? r.status : 502).json({
        error: ((j && j.error) || "Mastering failed.") + " Your credits were refunded.",
      });
    }

    return res.status(200).json({ ...j, balance: paid.balance });
  } catch (e) {
    await refundCredits(userId, cost, "refund:master-unreachable");
    return res.status(502).json({ error: "Couldn't reach the mastering engine. Your credits were refunded." });
  }
}
