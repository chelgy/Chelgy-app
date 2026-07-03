// api/shopify-build.js — ADMIN ONLY. Manual retry / re-run of a build-out for a
// store that already has its Admin token connected (via the OAuth callback). Useful
// if a build half-failed. Uses the same shared engine as the auto-build.
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

import { populateStore } from "./_shopify-populate.js";

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

async function getUserId(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, Authorization: "Bearer " + token } });
    const u = await r.json();
    return r.ok && u && u.id ? u.id : null;
  } catch { return null; }
}
async function isAdmin(userId) {
  try {
    const r = await fetch(SB_URL + "/rest/v1/members?select=is_admin&user_id=eq." + userId, { headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC } });
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] && rows[0].is_admin === true;
  } catch { return false; }
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

    const uid = await getUserId(token);
    if (!uid) return res.status(401).json({ error: "Please log in again." });
    if (!(await isAdmin(uid))) return res.status(403).json({ error: "Admins only." });

    const buildId = body.build_id;
    if (!buildId) return res.status(400).json({ error: "Missing build_id" });

    const r = await svc("store_builds?id=eq." + encodeURIComponent(buildId) + "&limit=1");
    const rows = await r.json();
    const build = Array.isArray(rows) && rows[0];
    if (!build) return res.status(404).json({ error: "Build not found." });
    if (!build.shop_domain || !build.admin_token) return res.status(400).json({ error: "This store isn't connected yet." });

    const result = await populateStore(build.shop_domain, build.admin_token, build.niche);
    await svc("store_builds?id=eq." + build.id, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: result.ok ? "populated" : "building", error: result.ok ? null : result.failures.join(" | "), updated_at: new Date().toISOString() })
    });

    return res.status(200).json({ ok: result.ok, failures: result.failures });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
