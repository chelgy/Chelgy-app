// api/community-reports.js — admin-only view of forum reports.
// Members file reports straight into the forum_reports table (RLS: insert-only).
// This endpoint reads/resolves them with the service role, gated by the admin password
// (same password your admin panel already uses). Set ADMIN_PASSWORD in Vercel to override.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_PASSWORD (optional)

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const ADMIN_PW = (process.env.ADMIN_PASSWORD || "chelochelo1");

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    if ((body.password || "") !== ADMIN_PW) return res.status(401).json({ error: "Not authorized." });
    if (!SB_URL || !SB_SVC) return res.status(500).json({ error: "Server is not configured." });

    const H = { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json" };

    if (body.action === "list") {
      const r = await fetch(SB_URL + "/rest/v1/forum_reports?resolved=eq.false&order=created_at.desc&limit=200", { headers: H });
      const rows = await r.json();
      return res.status(200).json({ reports: Array.isArray(rows) ? rows : [] });
    }

    if (body.action === "resolve") {
      if (!body.id) return res.status(400).json({ error: "Missing id." });
      await fetch(SB_URL + "/rest/v1/forum_reports?id=eq." + encodeURIComponent(body.id), {
        method: "PATCH",
        headers: { ...H, Prefer: "return=minimal" },
        body: JSON.stringify({ resolved: true })
      });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
