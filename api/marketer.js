// api/marketer.js — a logged-in user applies to become a Chelgy Marketer.
//
// Verifies the caller's login, then writes marketer_status='pending' + their
// answers using the service-role key. Because the status is set server-side,
// a user can apply but can NEVER set themselves to 'approved'. Approval happens
// only through api/admin.js (admins only).
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

async function getUser(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, Authorization: "Bearer " + token } });
    const u = await r.json();
    return r.ok && u && u.id ? u : null;
  } catch { return null; }
}
function svc(path, opts) {
  return fetch(SB_URL + "/rest/v1/" + path, Object.assign({}, opts, {
    headers: Object.assign({ apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json" }, (opts && opts.headers) || {})
  }));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: "Please log in again to apply." });

    if (body.action !== "apply") return res.status(400).json({ error: "Unknown action" });

    // Sanitize the application info to a known shape.
    const i = body.info || {};
    const info = {
      name: String(i.name || "").slice(0, 200),
      phone: String(i.phone || "").slice(0, 60),
      location: String(i.location || "").slice(0, 200),
      experience: String(i.experience || "").slice(0, 4000),
      why: String(i.why || "").slice(0, 4000),
      start: i.start === "now" ? "now" : "later",
      email: user.email || "",
      applied_at: new Date().toISOString()
    };

    const r = await svc("members?user_id=eq." + user.id, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ marketer_status: "pending", marketer_info: info })
    });
    if (!r.ok) {
      const d = await r.json().catch(() => null);
      return res.status(502).json({ error: (d && d.message) || "Could not submit your application." });
    }
    return res.status(200).json({ ok: true, status: "pending" });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
