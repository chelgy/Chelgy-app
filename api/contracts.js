// Contract / inquiry / deliverable endpoint.
// Talks to Supabase over its REST API with fetch (no @supabase/supabase-js
// package needed) — same pattern as video.js.
// Route with ?action=submit | list | deliverable-submit | deliverable-list | admin-list | admin-update

export default async function handler(req, res) {
  const action = req.query.action;

  const SB_URL = (process.env.SUPABASE_URL || '').trim();
  const SVC = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();
  const SB_ANON = (process.env.SUPABASE_ANON_KEY || '').trim();
  if (!SB_URL || !SVC) {
    return res.status(500).json({ error: 'Server not configured', detail: 'Missing SUPABASE_URL or service role key in Vercel env' });
  }

  // Call Supabase REST (PostgREST) with the service key.
  async function sb(path, { method = 'GET', body, prefer } = {}) {
    const headers = { apikey: SVC, Authorization: 'Bearer ' + SVC, 'Content-Type': 'application/json' };
    if (prefer) headers.Prefer = prefer;
    const r = await fetch(SB_URL + '/rest/v1/' + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!r.ok) {
      const msg = (data && (data.message || data.hint || data.details || data.error)) || text || ('HTTP ' + r.status);
      const e = new Error(msg); e.status = r.status; throw e;
    }
    return data;
  }

  try {
    // Resolve the acting user: prefer a verified login token, fall back to x-user-id header.
    let userId = null;
    let userEmail = null;
    const authz = req.headers['authorization'] || '';
    const token = authz.startsWith('Bearer ') ? authz.slice(7) : '';
    if (token) {
      try {
        const ur = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_ANON || SVC, Authorization: 'Bearer ' + token } });
        if (ur.ok) { const uj = await ur.json(); userId = (uj && uj.id) || null; userEmail = (uj && uj.email) || null; }
      } catch {}
    }
    if (!userId) userId = req.headers['x-user-id'] || null;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
    b = b || {};

    // ── Marketer submits a client inquiry ──
    if (action === 'submit') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { clientName, businessType, serviceTier, pricingModel, notes } = b;
      if (!clientName || !serviceTier) return res.status(400).json({ error: 'Missing required fields' });
      const data = await sb('client_contracts', {
        method: 'POST', prefer: 'return=representation',
        body: [{
          marketer_id: userId, client_name: clientName, business_type: businessType || null,
          service_tier: serviceTier, pricing_model: pricingModel || 'contract',
          notes: notes || null, status: 'submitted',
        }],
      });
      return res.status(200).json({ success: true, inquiry: (data && data[0]) || null });
    }

    // ── Marketer lists their own contracts ──
    if (action === 'list') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const contracts = await sb('client_contracts?select=*&marketer_id=eq.' + encodeURIComponent(userId) + '&order=created_at.desc');
      return res.status(200).json({ success: true, contracts: contracts || [] });
    }

    // ── Marketer submits a generated deliverable for review ──
    if (action === 'deliverable-submit') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { dvType, dvLabel, clientName, content } = b;
      if (!content) return res.status(400).json({ error: 'Missing content' });
      const data = await sb('marketer_deliverables', {
        method: 'POST', prefer: 'return=representation',
        body: [{
          marketer_id: userId, dv_type: dvType || null, dv_label: dvLabel || null,
          client_name: clientName || null, content: content, status: 'submitted',
        }],
      });
      return res.status(200).json({ success: true, deliverable: (data && data[0]) || null });
    }

    // ── Admin-only actions ──
    if (action === 'admin-list' || action === 'admin-update' || action === 'deliverable-list') {
      let isAdmin = false;
      try {
        const byId = await sb('members?select=is_admin&id=eq.' + encodeURIComponent(userId) + '&limit=1');
        if (Array.isArray(byId) && byId[0] && byId[0].is_admin === true) isAdmin = true;
      } catch {}
      if (!isAdmin && userEmail) {
        try {
          const byEmail = await sb('members?select=is_admin&email=eq.' + encodeURIComponent(userEmail) + '&limit=1');
          if (Array.isArray(byEmail) && byEmail[0] && byEmail[0].is_admin === true) isAdmin = true;
        } catch {}
      }
      if (!isAdmin) return res.status(403).json({ error: 'Admins only', detail: 'No admin members row for this login (checked by id and email).' });

      async function withMarketers(rows) {
        rows = rows || [];
        try {
          const ids = [...new Set(rows.map(r => r.marketer_id).filter(Boolean))];
          if (!ids.length) return rows.map(r => ({ ...r, marketer: null }));
          const list = ids.map(encodeURIComponent).join(',');
          const members = await sb('members?select=id,name,email&id=in.(' + list + ')');
          const byId = {};
          (members || []).forEach(m => { byId[m.id] = m; });
          return rows.map(r => ({ ...r, marketer: byId[r.marketer_id] || null }));
        } catch { return rows.map(r => ({ ...r, marketer: null })); }
      }

      if (action === 'admin-list') {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        const rows = await sb('client_contracts?select=*&order=created_at.desc');
        return res.status(200).json({ success: true, inquiries: await withMarketers(rows) });
      }

      if (action === 'deliverable-list') {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        const rows = await sb('marketer_deliverables?select=*&order=created_at.desc');
        return res.status(200).json({ success: true, deliverables: await withMarketers(rows) });
      }

      if (action === 'admin-update') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const { inquiryId, action: decision, denialReason } = b;
        if (!inquiryId || !decision) return res.status(400).json({ error: 'Missing required fields' });

        if (decision === 'approve') {
          const found = await sb('client_contracts?select=service_tier,pricing_model&id=eq.' + encodeURIComponent(inquiryId) + '&limit=1');
          const inquiry = (found && found[0]) || {};
          const prices = {
            foundation: { contract: 650, 'month-to-month': 800 },
            growth: { contract: 1200, 'month-to-month': 1500 },
            premium: { contract: 3000, 'month-to-month': 3500 },
            special: { contract: 5000, 'month-to-month': 5000 },
          };
          const tier = inquiry.service_tier;
          const model = inquiry.pricing_model || 'contract';
          const monthlyRevenue = (prices[tier] && prices[tier][model]) || 0;
          await sb('client_contracts?id=eq.' + encodeURIComponent(inquiryId), {
            method: 'PATCH',
            body: { status: 'approved', approved_at: new Date().toISOString(), approved_by: userId, monthly_revenue: monthlyRevenue },
          });
          return res.status(200).json({ success: true, message: 'Inquiry approved' });
        }

        if (decision === 'deny') {
          await sb('client_contracts?id=eq.' + encodeURIComponent(inquiryId), {
            method: 'PATCH',
            body: { status: 'denied', denial_reason: denialReason || null },
          });
          return res.status(200).json({ success: true, message: 'Inquiry denied' });
        }

        return res.status(400).json({ error: 'Invalid action' });
      }
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('contracts endpoint error:', err);
    return res.status(500).json({ error: 'Request failed', detail: (err && (err.message || String(err))) || 'unknown' });
  }
}
