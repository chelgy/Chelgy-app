// api/cj-search.js
// Searches the CJ catalog for the logged-in member using their connected CJ token.
import { createClient } from '@supabase/supabase-js';

const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0';

// Returns a valid CJ access token for this member, refreshing / re-authing as needed.
async function getCjToken(admin, userId) {
  const { data } = await admin.from('cj_accounts').select('*').eq('user_id', userId).maybeSingle();
  if (!data) return null;

  const now = Date.now();
  const exp = data.access_token_expiry ? new Date(data.access_token_expiry).getTime() : 0;
  if (data.access_token && exp > now + 60000) return data.access_token;

  // Try refresh first
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
    } catch (e) { /* fall through to re-auth */ }
  }

  // Fall back to a fresh getAccessToken with the stored api key
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

    const keyword = (req.query.keyword || (req.body && req.body.keyword) || '').toString().trim();
    const page = parseInt(req.query.page || (req.body && req.body.page) || '1', 10) || 1;
    if (!keyword) return res.status(400).json({ error: 'Enter a search term.' });

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const cjToken = await getCjToken(admin, user.id);
    if (!cjToken) return res.status(400).json({ error: 'Connect your CJ account first.' });

    const url = `${CJ_BASE}/v1/product/listV2?page=${page}&size=20&keyWord=${encodeURIComponent(keyword)}`;
    let cj;
    try {
      const r = await fetch(url, { headers: { 'CJ-Access-Token': cjToken } });
      cj = await r.json();
    } catch (e) {
      return res.status(502).json({ error: 'Could not reach CJ. Try again in a moment.' });
    }
    if (!cj || cj.success !== true || !cj.data) {
      return res.status(400).json({ error: (cj && cj.message) ? `CJ: ${cj.message}` : 'CJ search failed.' });
    }

    // listV2: data.content[] each has productList[]
    const content = Array.isArray(cj.data.content) ? cj.data.content : [];
    const raw = content.flatMap((c) => (Array.isArray(c.productList) ? c.productList : []));
    const products = raw.map((p) => ({
      pid: p.id,
      name: p.nameEn,
      image: p.bigImage,
      cost: p.nowPrice || p.sellPrice || null, // CJ cost in USD
      inventory: p.warehouseInventoryNum != null ? p.warehouseInventoryNum : null,
    })).filter((p) => p.pid && p.name);

    return res.status(200).json({
      products,
      page: cj.data.pageNumber || page,
      totalPages: cj.data.totalPages || null,
    });
  } catch (e) {
    return res.status(500).json({ error: 'Server error searching CJ.' });
  }
}
