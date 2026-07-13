// ============================================================================
// /api/podcast-search.js  —  "Get Featured": find podcasts to pitch
// ----------------------------------------------------------------------------
// Searches the free, open Podcast Index for shows in the user's niche.
// Returns the show, its description, host, website, and any contact email the
// RSS feed exposes (often a generic inbox — we're honest about that in the UI).
//
// Costs us nothing, so this search is FREE to the user. Only the AI-written
// pitch (podcast-pitch.js) charges credits.
//
// Env: PODCASTINDEX_KEY, PODCASTINDEX_SECRET, SUPABASE_URL, SUPABASE_ANON_KEY
// ============================================================================

import crypto from "crypto";

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
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

// Podcast Index auth: SHA-1 of (key + secret + unix seconds), sent in 3 headers.
function piHeaders(key, secret) {
  const t = Math.floor(Date.now() / 1000).toString();
  const hash = crypto.createHash("sha1").update(key + secret + t).digest("hex");
  return {
    "User-Agent": "Chelgy/1.0",
    "X-Auth-Key": key,
    "X-Auth-Date": t,
    "Authorization": hash,
  };
}

// Pull an email out of the feed's owner fields (Podcast Index exposes these).
function feedEmail(f) {
  const raw = f.ownerEmail || f.itunesOwnerEmail || f.email || "";
  const m = String(raw).match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  return m ? m[0] : "";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const KEY = (process.env.PODCASTINDEX_KEY || "").trim();
  const SECRET = (process.env.PODCASTINDEX_SECRET || "").trim();
  if (!KEY || !SECRET) return res.status(500).json({ error: "Podcast search is not configured." });

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const userId = await getUserId(token);
  if (!userId) return res.status(401).json({ error: "Please log in again." });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const q = (body.query || "").trim();
  const emailOnly = body.emailOnly === true;
  if (q.length < 2) return res.status(400).json({ error: "Tell us what you'd talk about." });

  try {
    const url =
      "https://api.podcastindex.org/api/1.0/search/byterm?q=" +
      encodeURIComponent(q) + "&max=40&clean";

    const r = await fetch(url, { headers: piHeaders(KEY, SECRET) });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: "Podcast search failed." });

    const feeds = Array.isArray(data.feeds) ? data.feeds : [];

    const shows = feeds
      .map((f) => {
        const email = feedEmail(f);
        return {
          id: f.id,
          title: f.title || "",
          author: f.author || f.ownerName || "",
          description: String(f.description || "").slice(0, 400),
          website: f.link || "",
          artwork: f.artwork || f.image || "",
          episodeCount: f.episodeCount || 0,
          lastUpdate: f.lastUpdateTime || 0,        // unix seconds
          categories: f.categories ? Object.values(f.categories) : [],
          email,                                     // "" if the feed exposes none
          hasEmail: !!email,
        };
      })
      // Drop dead shows — nothing worse than pitching a podcast that ended in 2019.
      .filter((s) => s.title && s.episodeCount > 3)
      .filter((s) => (emailOnly ? s.hasEmail : true))
      // Most recently active first — they're the ones actually taking guests.
      .sort((a, b) => (b.lastUpdate || 0) - (a.lastUpdate || 0))
      .slice(0, 25);

    return res.status(200).json({ ok: true, shows });
  } catch (e) {
    return res.status(500).json({ error: "Could not search podcasts right now." });
  }
}
