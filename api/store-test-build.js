// api/store-test-build.js — ADMIN ONLY. Runs the full build engine directly
// against a store using an Admin API token you paste in (from a dev store's
// "Develop apps" screen). No OAuth, no install, no distribution — just proves
// the engine: products, images, pages, collection, and the Linen theme.
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

import { populateStore } from "./_shopify-populate.js";

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

const NICHES = ["clothes", "beauty", "skincare", "hair", "jewelry", "homedecor", "home", "kitchen", "pets", "baby", "electronics", "phone", "car", "sports"];

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
function normShop(s) {
  s = String(s || "").trim().toLowerCase().replace(/^https?:\/\//, "");
  const m = s.match(/admin\.shopify\.com\/store\/([a-z0-9-]+)/);
  if (m) return m[1] + ".myshopify.com";
  s = s.replace(/\/.*$/, "");
  if (/^[a-z0-9][a-z0-9-]*$/.test(s)) s = s + ".myshopify.com";
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s) ? s : null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();

    const uid = await getUserId(auth);
    if (!uid) return res.status(401).json({ error: "Please log in again." });
    if (!(await isAdmin(uid))) return res.status(403).json({ error: "Admins only." });

    const shop = normShop(body.shop);
    if (!shop) return res.status(400).json({ error: "Enter the store like your-store.myshopify.com" });

    const adminToken = String(body.token || "").trim();
    if (!adminToken) return res.status(400).json({ error: "Paste the store's Admin API access token." });

    const niche = String(body.niche || "").trim().toLowerCase();
    if (!NICHES.includes(niche)) return res.status(400).json({ error: "Pick a niche." });

    const products = Array.isArray(body.products) ? body.products : [];

    const result = await populateStore(shop, adminToken, niche, products);
    return res.status(200).json({ ok: result.ok, failures: result.failures || [] });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
