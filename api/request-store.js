// api/request-store.js — a logged-in member requests an AI-built Shopify store.
//
// Records their niche + the email they'll use to accept the Shopify transfer.
// Status is set server-side, so a member can request but can never mark their own
// build "live". You create + transfer the store from the Partner Dashboard, and the
// product build-out runs from api/shopify-build.js once the store's Admin token is
// connected (after the member owns the store and installs the Chelgy Shopify app).
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

const NICHES = ["clothes", "electronics", "home", "pets", "sports"];

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
    if (!user) return res.status(401).json({ error: "Please log in again to request a store." });

    const niche = String(body.niche || "").trim().toLowerCase();
    if (!NICHES.includes(niche)) return res.status(400).json({ error: "Pick a niche for your store." });

    const ownerEmail = String(body.owner_email || user.email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) {
      return res.status(400).json({ error: "Enter a valid email — you'll use it to accept your store." });
    }

    // One active build per member: reuse the row unless a live store already exists.
    const existRes = await svc("store_builds?select=id,status&user_id=eq." + user.id + "&order=created_at.desc&limit=1");
    const exist = await existRes.json();
    const open = Array.isArray(exist) && exist[0];

    if (open && open.status === "live") {
      return res.status(409).json({ error: "You already have a store. Reach out if you'd like another." });
    }

    if (open) {
      await svc("store_builds?id=eq." + open.id, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ niche, owner_email: ownerEmail, status: "requested", error: null, updated_at: new Date().toISOString() })
      });
      return res.status(200).json({ ok: true, status: "requested", id: open.id });
    }

    const insRes = await svc("store_builds", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ user_id: user.id, niche, owner_email: ownerEmail, status: "requested" })
    });
    const rows = await insRes.json();
    if (!insRes.ok) {
      return res.status(502).json({ error: (rows && rows.message) || "Could not submit your request." });
    }
    const row = Array.isArray(rows) ? rows[0] : rows;
    return res.status(200).json({ ok: true, status: "requested", id: row && row.id });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
