// api/cj-product.js
// Returns a CJ product's details + variants (with vid, the ID CJ ships against)
// for the logged-in member.
import { createClient } from '@supabase/supabase-js';

const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0';

async function getCjToken(admin, userId) {
  const { data } = await admin.from('cj_accounts').select('*').eq('user_id', userId).maybeSingle();
  if (!data) return null;

  const now = Date.now();
  const exp = data.access_token_expiry ? new Date(data.access_token_expiry).getTime() : 0;
  if (data.access_token && exp > now + 60000) return data.access_token;

  if (data.refresh_token) {
    try {
      const r = await fetch(`${CJ_BASE}/v1/authentication/refreshAccessToken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: data.refresh_token }),
      });
      const j = await r.json();
      if (j && j.success && j.data && j.data.accessToken) {
        await admin.from('cj_accounts').update({
          access_token: j.data.accessToken,
          access_token_expiry: j.data.accessTokenExpiryDate || null,
          refresh_token: j.data.refreshToken || data.refresh_token,
          refresh_token_expiry: j.data.refreshTokenExpiryDate || data.refresh_token_expiry,
          updated_at: new Date().toISOString(),
        }).eq('user_id', userId);
        return j.data.accessToken;
      }
    } catch (e) { /* fall through */ }
  }

  if (data.api_key) {
    try {
      const r = await fetch(`${CJ_BASE}/v1/authentication/getAccessToken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: data.api_key }),
      });
      const j = await r.json();
      if (j && j.success && j.data && j.data.accessToken) {
        await admin.from('cj_accounts').update({
          access_token: j.data.accessToken,
          access_token_expiry: j.data.accessTokenExpiryDate || null,
          refresh_token: j.data.refreshToken || null,
          refresh_token_expiry: j.data.refreshTokenExpiryDate || null,
          updated_at: new Date().toISOString(),
        }).eq('user_id', userId);
        return j.data.accessToken;
      }
    } catch (e) { /* give up */ }
  }
  return null;
}

export default async function handler(req, res) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Not authenticated' });

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return res.status(401).json({ error: 'Not authenticated' });

    const pid = (req.query.pid || (req.body && req.body.pid) || '').toString().trim();
    if (!pid) return res.status(400).json({ error: 'Missing product id.' });

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const cjToken = await getCjToken(admin, user.id);
    if (!cjToken) return res.status(400).json({ error: 'Connect your CJ account first.' });

    let cj;
    try {
      const r = await fetch(`${CJ_BASE}/v1/product/query?pid=${encodeURIComponent(pid)}`, {
        headers: { 'CJ-Access-Token': cjToken },
      });
      cj = await r.json();
    } catch (e) {
      return res.status(502).json({ error: 'Could not reach CJ. Try again in a moment.' });
    }
    if (!cj || cj.success !== true || !cj.data) {
      return res.status(400).json({ error: (cj && cj.message) ? `CJ: ${cj.message}` : 'Could not load product.' });
    }

    const d = cj.data;
    const images = Array.isArray(d.productImageSet) ? d.productImageSet : (d.bigImage ? [d.bigImage] : []);
    const variants = (Array.isArray(d.variants) ? d.variants : []).map((v) => ({
      vid: v.vid,
      name: v.variantNameEn || v.variantKey || 'Default',
      sku: v.variantSku,
      cost: v.variantSellPrice != null ? v.variantSellPrice : null, // USD
      image: v.variantImage || null,
      key: v.variantKey || null,
    })).filter((v) => v.vid);

    return res.status(200).json({
      pid: d.pid,
      name: d.productNameEn,
      image: d.bigImage,
      images,
      description: d.description || '',
      suggestSellPrice: d.suggestSellPrice || null,
      variants,
    });
  } catch (e) {
    return res.status(500).json({ error: 'Server error loading CJ product.' });
  }
}
