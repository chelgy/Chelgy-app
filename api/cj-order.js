// api/cj-order.js
// Auto-creates a fulfillment order on CJdropshipping for a member's sale.
// Reuses the member's stored CJ connection saved by cj-connect.js.
//
// Call this when an order is completed (e.g. after Stripe checkout succeeds).
// Expected POST body:
// {
//   orderNumber?: "CHELGY-123",           // optional; auto-generated if omitted
//   orderId?: "<your orders row id>",      // optional; we'll write cj_order_id back to it
//   shipping: {
//     name, phone, email,
//     address, address2?, city, province/state, zip/postalCode,
//     country, countryCode                 // countryCode like "US"
//   },
//   products: [ { vid: "<CJ variant id>", quantity: 2 } ],
//   logisticName?, fromCountryCode?, remark?
// }
import { createClient } from '@supabase/supabase-js';

const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0';

// Returns { token } using the stored access token, refreshing it if expired.
async function ensureAccessToken(admin, row) {
  const now = Date.now();
  const exp = row.access_token_expiry ? new Date(row.access_token_expiry).getTime() : 0;
  if (row.access_token && exp && exp - now > 60 * 1000) {
    return { token: row.access_token };
  }

  let data = null;
  // Prefer a refresh (getAccessToken is rate-limited to once per 5 min on CJ).
  if (row.refresh_token) {
    try {
      const r = await fetch(`${CJ_BASE}/v1/authentication/refreshAccessToken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: row.refresh_token }),
      });
      const j = await r.json();
      if (j && j.success && j.data && j.data.accessToken) data = j.data;
    } catch (e) { /* fall through */ }
  }
  if (!data && row.api_key) {
    try {
      const r = await fetch(`${CJ_BASE}/v1/authentication/getAccessToken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: row.api_key }),
      });
      const j = await r.json();
      if (j && j.success && j.data && j.data.accessToken) data = j.data;
    } catch (e) { /* fall through */ }
  }
  if (!data) {
    return { error: 'Could not refresh CJ access. The member may need to reconnect their CJ account.' };
  }

  try {
    await admin.from('cj_accounts').update({
      access_token: data.accessToken,
      access_token_expiry: data.accessTokenExpiryDate || null,
      refresh_token: data.refreshToken || row.refresh_token,
      refresh_token_expiry: data.refreshTokenExpiryDate || row.refresh_token_expiry,
      updated_at: new Date().toISOString(),
    }).eq('user_id', row.user_id);
  } catch (e) { /* non-fatal */ }

  return { token: data.accessToken };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // --- Identify the logged-in member ---
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

    // --- Validate the order ---
    const body = req.body || {};
    const products = Array.isArray(body.products)
      ? body.products
          .map((p) => ({ vid: p.vid || p.variantId || p.cjVid, quantity: Number(p.quantity || p.qty || 1) }))
          .filter((p) => p.vid && p.quantity > 0)
      : [];
    const ship = body.shipping || body.address || {};
    if (!products.length) return res.status(400).json({ error: 'No CJ products in this order.' });
    if (!ship.name || !ship.address || !ship.countryCode) {
      return res.status(400).json({ error: 'Missing shipping name, address, or country code.' });
    }

    // --- Load the member's CJ connection (service role bypasses RLS) ---
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: rows, error: readErr } = await admin
      .from('cj_accounts').select('*').eq('user_id', user.id).limit(1);
    if (readErr || !rows || !rows.length) {
      return res.status(400).json({ error: 'No CJ account connected. Connect CJ first in the dropshipping tool.' });
    }
    const row = rows[0];

    const at = await ensureAccessToken(admin, row);
    if (at.error) return res.status(400).json({ error: at.error });

    // --- Build + send the CJ order ---
    const orderNumber = body.orderNumber || `CHELGY-${Date.now()}`;
    const payload = {
      orderNumber,
      shippingCustomerName: ship.name,
      shippingPhone: ship.phone || '',
      shippingCountryCode: ship.countryCode,
      shippingCountry: ship.country || '',
      shippingProvince: ship.province || ship.state || '',
      shippingCity: ship.city || '',
      shippingAddress: ship.address,
      shippingAddress2: ship.address2 || '',
      shippingZip: ship.zip || ship.postalCode || '',
      email: ship.email || '',
      remark: body.remark || 'Order placed via Chelgy',
      fromCountryCode: body.fromCountryCode || '',
      logisticName: body.logisticName || '',
      products,
    };

    let cj;
    try {
      const r = await fetch(`${CJ_BASE}/v1/shopping/order/createOrderV2`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CJ-Access-Token': at.token },
        body: JSON.stringify(payload),
      });
      cj = await r.json();
    } catch (e) {
      return res.status(502).json({ error: 'Could not reach CJ. Try again in a moment.' });
    }

    if (!cj || cj.success !== true) {
      const msg = (cj && cj.message) ? cj.message : 'CJ rejected the order.';
      return res.status(400).json({ error: `CJ: ${msg}` });
    }

    const cjOrderId = cj.data && (cj.data.orderId || cj.data.orderNumber);

    // Best-effort: write the CJ order id back onto your own order row.
    if (body.orderId) {
      try {
        await admin.from('orders')
          .update({ cj_order_id: cjOrderId ? String(cjOrderId) : null, cj_status: 'created' })
          .eq('id', body.orderId);
      } catch (e) { /* non-fatal */ }
    }

    return res.status(200).json({ created: true, cjOrderId: cjOrderId ? String(cjOrderId) : null, orderNumber });
  } catch (e) {
    return res.status(500).json({ error: 'Server error creating CJ order.' });
  }
}
