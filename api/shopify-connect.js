// api/shopify-connect.js — STEP 1 of the member self-serve connect.
//
// A logged-in member gives us their Shopify store URL and niche. We record it,
// generate a one-time state nonce, and hand back the Shopify authorize URL. The
// browser sends them there; they click "Install", and Shopify bounces them to
// api/shopify-callback.js — which grabs the token and auto-builds the store.
//
// The member must already have a Shopify store (their own free trial). In the app,
// the "Create your store" button sends them to Shopify with your referral link first;
// this route is the "Connect it" step once they have one.
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
//      SHOPIFY_API_KEY, SHOPIFY_APP_URL (e.g. https://chelgy.app)

import crypto from "crypto";

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

const SCOPES = "write_products,write_content"; // products, collections, pages

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
function normShop(s) {
  s = String(s || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s) ? s : null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const token = (body.access_token || (req.headers.authorization || "").replace(/^Bearer\s+/i, "")).trim();
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: "Please log in again to connect your store." });

    const niche = String(body.niche || "").trim().toLowerCase();
    if (!NICHES.includes(niche)) return res.status(400).json({ error: "Pick a niche for your store." });

    const shop = normShop(body.shop);
    if (!shop) return res.status(400).json({ error: "Enter your store URL like your-store.myshopify.com" });

    const API_KEY = (process.env.SHOPIFY_API_KEY || "").trim();
    const APP_URL = (process.env.SHOPIFY_APP_URL || ("https://" + (req.headers.host || "chelgy.app"))).replace(/\/+$/, "");
    if (!API_KEY) return res.status(500).json({ error: "Store connect isn't configured yet." });

    const state = crypto.randomBytes(16).toString("hex");

    // Reuse this member's build row (unless a live store already exists), else insert.
    const existRes = await svc("store_builds?select=id,status&user_id=eq." + user.id + "&order=created_at.desc&limit=1");
    const exist = await existRes.json();
    const open = Array.isArray(exist) && exist[0];

    if (open && open.status === "live") {
      return res.status(409).json({ error: "You already have a connected store." });
    }

    const patch = { niche, shop_domain: shop, owner_email: user.email || null, oauth_state: state, admin_token: null, status: "connecting", error: null, updated_at: new Date().toISOString() };
    if (open) {
      await svc("store_builds?id=eq." + open.id, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) });
    } else {
      await svc("store_builds", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(Object.assign({ user_id: user.id }, patch)) });
    }

    const redirectUri = APP_URL + "/api/shopify-callback";
    const url = "https://" + shop + "/admin/oauth/authorize"
      + "?client_id=" + encodeURIComponent(API_KEY)
      + "&scope=" + encodeURIComponent(SCOPES)
      + "&redirect_uri=" + encodeURIComponent(redirectUri)
      + "&state=" + state;

    return res.status(200).json({ url });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
