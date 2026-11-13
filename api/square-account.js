// api/square-account.js — a member's Square connection, next to "Connect Stripe".
//
//   POST { action: "connect" }               -> { url }   Square's sign-in page
//   POST { action: "status" }                -> { connected, ready, name, preferred, configured }
//   POST { action: "prefer", square: bool }  -> use Square (true) or Stripe (false) when both are connected
//   POST { action: "disconnect" }            -> forgets the account and revokes Chelgy's access
//
// The sign-in comes back to api/square-callback.js.
//
// Env: SQUARE_APP_ID, SQUARE_APP_SECRET, SQUARE_ENV, SUPABASE_URL, SUPABASE_ANON_KEY,
//      SUPABASE_SERVICE_ROLE_KEY
import { SQ_APP_ID, SQ_BASE, SQ_SCOPES, SQ_REDIRECT, squareConfigured, signState, squareAccount, patchSquareAccount } from "./_square.js";

const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

async function getUser(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, Authorization: "Bearer " + token } });
    const u = await r.json();
    return r.ok && u && u.id ? u : null;
  } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const token = (body.access_token || (req.headers.authorization || "").replace(/^Bearer\s+/i, "")).trim();
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: "Please log in again." });
    const action = String(body.action || "status");

    if (action === "connect") {
      if (!squareConfigured()) return res.status(500).json({ error: "Square isn't set up on Chelgy yet." });
      const url = SQ_BASE + "/oauth2/authorize?client_id=" + encodeURIComponent(SQ_APP_ID) +
        "&scope=" + encodeURIComponent(SQ_SCOPES.join(" ")) + "&session=false" +
        "&redirect_uri=" + encodeURIComponent(SQ_REDIRECT) +
        "&state=" + encodeURIComponent(signState(user.id));
      return res.status(200).json({ url });
    }

    const acct = await squareAccount(user.id);

    if (action === "prefer") {
      if (!acct) return res.status(400).json({ error: "Connect Square first." });
      await patchSquareAccount(user.id, { preferred: body.square === true });
      return res.status(200).json({ ok: true, preferred: body.square === true });
    }

    if (action === "disconnect") {
      if (acct) {
        // Revoke Chelgy's access on Square's side too, not just forget the tokens.
        try {
          await fetch(SQ_BASE + "/oauth2/revoke", {
            method: "POST",
            headers: { Authorization: "Client " + (process.env.SQUARE_APP_SECRET || "").trim(), "Content-Type": "application/json" },
            body: JSON.stringify({ client_id: SQ_APP_ID, merchant_id: acct.merchant_id }),
          });
        } catch {}
        await fetch(SB_URL + "/rest/v1/square_accounts?user_id=eq." + encodeURIComponent(user.id), {
          method: "DELETE", headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC } });
      }
      return res.status(200).json({ ok: true, connected: false });
    }

    return res.status(200).json({
      configured: squareConfigured(),
      connected: !!acct,
      ready: !!(acct && acct.charges_enabled && acct.location_id),
      name: (acct && acct.business_name) || "",
      preferred: !!(acct && acct.preferred),
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error." });
  }
}
