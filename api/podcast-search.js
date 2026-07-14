// ============================================================================
// /api/podcast-search.js  —  "Get Featured": find podcasts to pitch
// ----------------------------------------------------------------------------
// Two-step, because it has to be:
//   1. Podcast Index search  -> gives us shows + their RSS feed URLs.
//      (The search response does NOT include contact emails. Only ownerName.)
//   2. Fetch each RSS feed   -> parse <itunes:owner><itunes:email> out of it.
//      That's where the host's real contact address actually lives.
//
// Free: Podcast Index is free, and fetching feeds costs nothing. Only the
// AI-written pitch (podcast-pitch.js) charges credits.
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

// Podcast Index auth: SHA-1 of (key + secret + unix seconds), in 3 headers.
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

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;

// Pull the host's email out of a podcast's RSS feed.
// It lives in <itunes:owner><itunes:email>…</itunes:email></itunes:owner>,
// sometimes in <managingEditor> or <webMaster> instead.
async function emailFromFeed(feedUrl) {
  if (!feedUrl || !/^https?:\/\//.test(feedUrl)) return "";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);   // don't hang on slow feeds
    const r = await fetch(feedUrl, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Chelgy/1.0" },
    });
    clearTimeout(timer);
    if (!r.ok) return "";

    // We only need the <channel> header, not every episode. Read the first
    // chunk and stop — feeds can be many megabytes.
    const text = (await r.text()).slice(0, 120000);

    const owner = text.match(/<itunes:owner[\s\S]*?<\/itunes:owner>/i);
    if (owner) {
      const em = owner[0].match(/<itunes:email[^>]*>\s*(?:<!\[CDATA\[)?\s*([^<\]]+)/i);
      if (em && EMAIL_RE.test(em[1].trim())) return em[1].trim();
    }
    for (const tag of ["managingEditor", "webMaster"]) {
      const m = text.match(new RegExp("<" + tag + "[^>]*>\\s*(?:<!\\[CDATA\\[)?\\s*([^<\\]]+)", "i"));
      if (m) {
        const hit = m[1].match(EMAIL_RE);
        if (hit) return hit[0];
      }
    }
    return "";
  } catch { return ""; }
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

    // Keep only live, real shows before we spend time fetching feeds.
    const candidates = feeds
      .filter((f) => f.title && !f.dead && (f.episodeCount || 0) > 3)
      .sort((a, b) => (b.lastUpdateTime || 0) - (a.lastUpdateTime || 0))
      .slice(0, 20);

    // Fetch the RSS feeds in parallel to dig out the host emails.
    const emails = await Promise.all(candidates.map((f) => emailFromFeed(f.url)));

    let shows = candidates.map((f, i) => {
      const email = emails[i] || "";
      return {
        id: f.id,
        title: f.title || "",
        author: f.author || f.ownerName || "",
        description: String(f.description || "").slice(0, 400),
        website: f.link || "",
        artwork: f.artwork || f.image || "",
        episodeCount: f.episodeCount || 0,
        lastUpdate: f.lastUpdateTime || 0,
        categories: f.categories ? Object.values(f.categories) : [],
        email,
        hasEmail: !!email,
      };
    });

    const withEmail = shows.filter((s) => s.hasEmail).length;
    if (emailOnly) shows = shows.filter((s) => s.hasEmail);

    return res.status(200).json({ ok: true, shows, withEmail, scanned: candidates.length });
  } catch (e) {
    return res.status(500).json({ error: "Could not search podcasts right now." });
  }
}
