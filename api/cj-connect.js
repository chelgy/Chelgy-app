// api/cj-connect.js
// Links a member's CJdropshipping account to Chelgy.
// Flow: member pastes their CJ API Key -> we verify it by calling CJ's
// getAccessToken -> we store the key + returned tokens for later fulfillment.
import { createClient } from '@supabase/supabase-js';

const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // --- Identify the logged-in member from their Supabase token ---
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Not authenticated' });

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return res.status(401).json({ error: 'Not authenticated' });

    // --- Read + basic-validate the API key ---
    const apiKey = (req.body && typeof req.body.apiKey === 'string') ? req.body.apiKey.trim() : '';
    if (!apiKey) return res.status(400).json({ error: 'Paste your CJ API key.' });

    // --- Verify with CJ by requesting an access token ---
    let cj;
    try {
      const cjRes = await fetch(`${CJ_BASE}/v1/authentication/getAccessToken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      });
      cj = await cjRes.json();
    } catch (e) {
      return res.status(502).json({ error: 'Could not reach CJ. Try again in a moment.' });
    }

    if (!cj || cj.success !== true || !cj.data || !cj.data.accessToken) {
      const msg = (cj && cj.message) ? cj.message : 'CJ rejected that API key.';
      return res.status(400).json({ error: `CJ: ${msg}. Double-check the key from My CJ -> Authorization -> API.` });
    }

    const d = cj.data;

    // --- Store the connection (service role bypasses RLS for the write) ---
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { error: writeErr } = await admin.from('cj_accounts').upsert(
      {
        user_id: user.id,
        api_key: apiKey,
        open_id: d.openId != null ? String(d.openId) : null,
        access_token: d.accessToken,
        access_token_expiry: d.accessTokenExpiryDate || null,
        refresh_token: d.refreshToken || null,
        refresh_token_expiry: d.refreshTokenExpiryDate || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );
    if (writeErr) {
      return res.status(500).json({ error: 'Connected to CJ but could not save it. Try again.' });
    }

    return res.status(200).json({ connected: true, openId: d.openId != null ? String(d.openId) : null });
  } catch (e) {
    return res.status(500).json({ error: 'Server error connecting CJ.' });
  }
}
