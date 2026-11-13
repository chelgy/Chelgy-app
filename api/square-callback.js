// api/square-callback.js — where Square sends a member back after they sign in and
// allow Chelgy to take payments for them. Swaps the one-time code for their tokens,
// finds the location payments go to, saves it all, and returns them to the app.
//
// The redirect URL registered with the Square app must be exactly
//   https://chelgy.app/api/square-callback
//
// Env: SQUARE_APP_ID, SQUARE_APP_SECRET, SQUARE_ENV, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
import { APP_URL, SQ_REDIRECT, readState, exchangeToken, pickLocation, sq, saveSquareAccount } from "./_square.js";

export default async function handler(req, res) {
  const back = (status) => { res.statusCode = 302; res.setHeader("Location", APP_URL + "/?square=" + status); res.end(); };
  try {
    const q = req.query || {};
    if (q.error) return back(q.error === "access_denied" ? "cancelled" : "error");
    const userId = readState(q.state);
    if (!userId || !q.code) return back("error");

    const t = await exchangeToken({ grant_type: "authorization_code", code: String(q.code), redirect_uri: SQ_REDIRECT });
    if (!t) return back("error");

    const loc = await pickLocation(t.access_token);
    let businessName = loc ? loc.name : "";
    try {
      const m = await sq("/v2/merchants/" + encodeURIComponent(t.merchant_id), { token: t.access_token });
      if (m.ok && m.j.merchant && m.j.merchant.business_name) businessName = m.j.merchant.business_name;
    } catch {}

    const saved = await saveSquareAccount({
      user_id: userId,
      merchant_id: t.merchant_id,
      access_token: t.access_token,
      refresh_token: t.refresh_token || null,
      expires_at: t.expires_at || null,
      location_id: loc ? loc.id : null,
      currency: loc ? loc.currency : "USD",
      country: loc ? loc.country : "US",
      business_name: String(businessName || "").slice(0, 120),
      charges_enabled: !!loc,
      // Connecting Square is saying "take payments through Square" — so it's the one
      // checkouts use from now on, even if Stripe is connected too. Switchable in the app.
      preferred: true,
    });
    return back(saved ? (loc ? "done" : "nolocation") : "error");
  } catch {
    return back("error");
  }
}
