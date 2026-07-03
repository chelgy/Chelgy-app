// api/shopify-callback.js — STEP 2. Shopify redirects the member here after they
// click "Install" in their store. This route is NOT called by a logged-in Chelgy
// user (it's a top-level redirect from Shopify), so we identify the member by the
// one-time `state` nonce we stored in shopify-connect.js.
//
// It: verifies the request is really from Shopify (HMAC), matches the state + shop,
// swaps the code for a permanent Admin token, saves it, then FIRES THE BUILD-OUT
// automatically and sends the member back into Chelgy.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SHOPIFY_API_KEY, SHOPIFY_API_SECRET,
//      SHOPIFY_APP_URL

import crypto from "crypto";
import { populateStore } from "./_shopify-populate.js";

const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_SVC = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

function svc(path, opts) {
  return fetch(SB_URL + "/rest/v1/" + path, Object.assign({}, opts, {
    headers: Object.assign({ apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json" }, (opts && opts.headers) || {})
  }));
}
function normShop(s) {
  s = String(s || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s) ? s : null;
}
// Shopify OAuth query-string HMAC: sort remaining params, join key=value with &, HMAC-SHA256.
function verifyHmac(query, secret) {
  const q = Object.assign({}, query);
  const sent = q.hmac; delete q.hmac; delete q.signature;
  const message = Object.keys(q).sort().map(function (k) {
    const v = Array.isArray(q[k]) ? q[k].join(",") : q[k];
    return k + "=" + v;
  }).join("&");
  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");
  const a = Buffer.from(digest);
  const b = Buffer.from(String(sent || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  const APP_URL = (process.env.SHOPIFY_APP_URL || ("https://" + (req.headers.host || "chelgy.app"))).replace(/\/+$/, "");
  const bounce = function (q) { res.setHeader("Location", APP_URL + "/?store=" + q); return res.status(302).end(); };

  try {
    const { code, shop: rawShop, state, hmac } = req.query || {};
    const shop = normShop(rawShop);
    const API_KEY = (process.env.SHOPIFY_API_KEY || "").trim();
    const API_SECRET = (process.env.SHOPIFY_API_SECRET || "").trim();

    if (!code || !shop || !state || !hmac) return bounce("error");
    if (!API_KEY || !API_SECRET) return bounce("error");
    if (!verifyHmac(req.query, API_SECRET)) return bounce("error");

    // Find the member by the one-time state nonce.
    const r = await svc("store_builds?select=id,user_id,niche,shop_domain,status&oauth_state=eq." + encodeURIComponent(state) + "&limit=1");
    const rows = await r.json();
    const build = Array.isArray(rows) && rows[0];
    if (!build) return bounce("expired");
    if (build.shop_domain && build.shop_domain !== shop) return bounce("mismatch");

    // Swap the code for a permanent Admin API token.
    const tRes = await fetch("https://" + shop + "/admin/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: API_KEY, client_secret: API_SECRET, code })
    });
    const tok = await tRes.json().catch(() => null);
    const accessToken = tok && tok.access_token;
    if (!tRes.ok || !accessToken) {
      await svc("store_builds?id=eq." + build.id, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "connect_failed", oauth_state: null, error: "token exchange failed", updated_at: new Date().toISOString() }) });
      return bounce("error");
    }

    // Store the token, clear the used nonce.
    await svc("store_builds?id=eq." + build.id, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ admin_token: accessToken, oauth_state: null, status: "building", error: null, updated_at: new Date().toISOString() })
    });

    // Auto-build the store.
    const result = await populateStore(shop, accessToken, build.niche);
    await svc("store_builds?id=eq." + build.id, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: result.ok ? "populated" : "building", error: result.ok ? null : result.failures.join(" | "), updated_at: new Date().toISOString() })
    });

    return bounce(result.ok ? "ready" : "partial");
  } catch (e) {
    return bounce("error");
  }
}
