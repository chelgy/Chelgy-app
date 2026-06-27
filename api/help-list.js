// Chelgy back room — lets ONLY the admin read help requests (keeps user emails private).
// Set in Vercel:
//   SUPABASE_SERVICE_KEY = your Supabase service_role key (Settings -> API)
//   ADMIN_PASSWORD       = your admin password (chelochelo1)
const SUPABASE_URL = "https://yuzvpmxbtjpqtapborhr.supabase.co";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const pass = (body.password || "").toString();
    if (!process.env.ADMIN_PASSWORD || pass !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const svc = (process.env.SUPABASE_SERVICE_KEY || "").trim();
    if (!svc) return res.status(500).json({ error: "Help reader not configured." });

    const r = await fetch(SUPABASE_URL + "/rest/v1/help_requests?order=created_at.desc", {
      headers: { "apikey": svc, "Authorization": "Bearer " + svc }
    });
    const data = await r.json().catch(() => []);
    if (!r.ok) return res.status(r.status).json({ error: "Could not load help requests." });
    return res.status(200).json({ requests: Array.isArray(data) ? data : [] });
  } catch (e) {
    return res.status(500).json({ error: "Server error" });
  }
}
