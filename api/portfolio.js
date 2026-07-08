// api/portfolio.js — admin add/delete of portfolio items (sales team example work).
// Reps read portfolio_items directly (public RLS). Writes go through here with the
// service role, gated by the admin password. Set ADMIN_PASSWORD in Vercel to override.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_PASSWORD (optional)

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const ADMIN_PW = (process.env.ADMIN_PASSWORD || "chelochelo1");

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    if (!SB_URL || !SB_SVC) return res.status(500).json({ error: "Server is not configured." });
    const H = { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json" };

    if (body.action === "list") {
      const r = await fetch(SB_URL + "/rest/v1/portfolio_items?select=*&order=created_at.desc&limit=500", { headers: H });
      const rows = await r.json();
      return res.status(200).json({ items: Array.isArray(rows) ? rows : [] });
    }

    // writes require the admin password
    if ((body.password || "") !== ADMIN_PW) return res.status(401).json({ error: "Not authorized." });

    if (body.action === "add") {
      if (!body.url) return res.status(400).json({ error: "Missing url." });
      const row = {
        category: body.category || "Other",
        title: body.title || "",
        url: body.url,
        kind: body.kind || "link"
      };
      const r = await fetch(SB_URL + "/rest/v1/portfolio_items", {
        method: "POST",
        headers: { ...H, Prefer: "return=representation" },
        body: JSON.stringify(row)
      });
      const d = await r.json();
      return res.status(200).json({ item: Array.isArray(d) ? d[0] : d });
    }

    if (body.action === "delete") {
      if (!body.id) return res.status(400).json({ error: "Missing id." });
      await fetch(SB_URL + "/rest/v1/portfolio_items?id=eq." + encodeURIComponent(body.id), {
        method: "DELETE",
        headers: { ...H, Prefer: "return=minimal" }
      });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
