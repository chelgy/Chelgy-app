// api/delete-account.js
// Permanently deletes the logged-in member's account + their data.
// Required by Apple App Store Guideline 5.1.1(v): apps that let users create
// an account must let them delete it from inside the app.
import { createClient } from '@supabase/supabase-js';

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

    // --- Service role: clean up the member's own rows, then delete the account ---
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Best-effort cleanup. Tables that don't exist (or don't have a user_id
    // column) are skipped silently so this never blocks the deletion.
    const userTables = [
      'cj_accounts', 'products', 'orders', 'clients', 'invoices',
      'proposals', 'contracts', 'sites', 'domains', 'tool_media', 'ledger',
    ];
    for (const t of userTables) {
      try { await admin.from(t).delete().eq('user_id', user.id); } catch (e) { /* skip */ }
    }

    // Delete the auth account itself. This is the piece Apple requires.
    const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
    if (delErr) {
      return res.status(500).json({ error: 'Could not delete your account. Please try again.' });
    }

    return res.status(200).json({ deleted: true });
  } catch (e) {
    return res.status(500).json({ error: 'Server error deleting account.' });
  }
}
