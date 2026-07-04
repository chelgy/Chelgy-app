// api/cj-status.js
// Returns whether the logged-in member has a connected CJ account.
import { createClient } from '@supabase/supabase-js';

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

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data } = await admin
      .from('cj_accounts')
      .select('open_id, updated_at')
      .eq('user_id', user.id)
      .maybeSingle();

    return res.status(200).json({
      connected: !!(data && data.open_id),
      openId: data ? data.open_id : null,
    });
  } catch (e) {
    return res.status(200).json({ connected: false });
  }
}
