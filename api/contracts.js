// Merged contract/inquiry endpoint — replaces submit-inquiry.js,
// marketer-contracts.js and admin-inquiries.js (3 functions -> 1).
// Route with ?action=submit | list | admin-list | admin-update
export default async function handler(req, res) {
  const action = req.query.action;
  const userId = req.headers['x-user-id'];

  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const { createClient } = await import('@supabase/supabase-js');
    const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
    if (!process.env.SUPABASE_URL || !svcKey) {
      return res.status(500).json({ error: 'Server not configured', detail: 'Missing SUPABASE_URL or service role key in Vercel env' });
    }
    const supabase = createClient(process.env.SUPABASE_URL, svcKey);

    // ── Marketer submits a client inquiry ──────────────────────────────
    if (action === 'submit') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { clientName, businessType, serviceTier, pricingModel, notes } = req.body;
      if (!clientName || !serviceTier) return res.status(400).json({ error: 'Missing required fields' });

      const { data, error } = await supabase
        .from('client_contracts')
        .insert([{
          marketer_id: userId,
          client_name: clientName,
          business_type: businessType || null,
          service_tier: serviceTier,
          pricing_model: pricingModel || 'contract',
          notes: notes || null,
          status: 'submitted'
        }])
        .select();
      if (error) throw error;
      return res.status(200).json({ success: true, inquiry: data[0] });
    }

    // ── Marketer lists their own contracts ─────────────────────────────
    if (action === 'list') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const { data: contracts, error } = await supabase
        .from('client_contracts')
        .select('*')
        .eq('marketer_id', userId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return res.status(200).json({ success: true, contracts: contracts || [] });
    }

    // ── Marketer submits a generated deliverable for review ────────────
    if (action === 'deliverable-submit') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { dvType, dvLabel, clientName, content } = req.body;
      if (!content) return res.status(400).json({ error: 'Missing content' });

      const { data, error } = await supabase
        .from('marketer_deliverables')
        .insert([{
          marketer_id: userId,
          dv_type: dvType || null,
          dv_label: dvLabel || null,
          client_name: clientName || null,
          content: content,
          status: 'submitted'
        }])
        .select();
      if (error) throw error;
      return res.status(200).json({ success: true, deliverable: data[0] });
    }

    // ── Admin-only actions: verify is_admin first ──────────────────────
    if (action === 'admin-list' || action === 'admin-update' || action === 'deliverable-list') {
      const { data: adminCheck, error: adminError } = await supabase
        .from('members')
        .select('is_admin')
        .eq('id', userId)
        .single();
      if (adminError || !adminCheck?.is_admin) return res.status(403).json({ error: 'Admins only' });

      // Admin lists every inquiry
      if (action === 'admin-list') {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        const { data: inquiries, error } = await supabase
          .from('client_contracts')
          .select('*, marketer:marketer_id(id, name, email)')
          .order('created_at', { ascending: false });
        if (error) throw error;
        return res.status(200).json({ success: true, inquiries: inquiries || [] });
      }

      // Admin lists every submitted deliverable
      if (action === 'deliverable-list') {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        const { data: deliverables, error } = await supabase
          .from('marketer_deliverables')
          .select('*, marketer:marketer_id(id, name, email)')
          .order('created_at', { ascending: false });
        if (error) throw error;
        return res.status(200).json({ success: true, deliverables: deliverables || [] });
      }

      // Admin approves or denies an inquiry
      if (action === 'admin-update') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const { inquiryId, action: decision, denialReason } = req.body; // decision: 'approve' | 'deny'
        if (!inquiryId || !decision) return res.status(400).json({ error: 'Missing required fields' });

        if (decision === 'approve') {
          const { data: inquiry, error: fetchError } = await supabase
            .from('client_contracts')
            .select('service_tier, pricing_model')
            .eq('id', inquiryId)
            .single();
          if (fetchError) throw fetchError;

          const prices = {
            foundation: { contract: 500, 'month-to-month': 800 },
            growth: { contract: 1200, 'month-to-month': 1500 },
            premium: { contract: 2500, 'month-to-month': 3500 },
            special: { contract: 5000, 'month-to-month': 5000 }
          };
          const tier = inquiry.service_tier;
          const model = inquiry.pricing_model || 'contract';
          const monthlyRevenue = prices[tier]?.[model] || 0;

          const { error: updateError } = await supabase
            .from('client_contracts')
            .update({
              status: 'approved',
              approved_at: new Date().toISOString(),
              approved_by: userId,
              monthly_revenue: monthlyRevenue
            })
            .eq('id', inquiryId);
          if (updateError) throw updateError;
          return res.status(200).json({ success: true, message: 'Inquiry approved' });
        }

        if (decision === 'deny') {
          const { error: updateError } = await supabase
            .from('client_contracts')
            .update({ status: 'denied', denial_reason: denialReason || null })
            .eq('id', inquiryId);
          if (updateError) throw updateError;
          return res.status(200).json({ success: true, message: 'Inquiry denied' });
        }

        return res.status(400).json({ error: 'Invalid action' });
      }
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('contracts endpoint error:', err);
    return res.status(500).json({ error: 'Request failed', detail: (err && (err.message || err.hint || err.code)) || String(err) });
  }
}
