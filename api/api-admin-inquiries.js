export default async function handler(req, res) {
  const adminId = req.headers['x-user-id'];
  
  if (!adminId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // Verify admin role
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data: adminCheck, error: adminError } = await supabase
    .from('members')
    .select('is_admin')
    .eq('id', adminId)
    .single();

  if (adminError || !adminCheck?.is_admin) {
    return res.status(403).json({ error: 'Admins only' });
  }

  // GET: List all inquiries
  if (req.method === 'GET') {
    try {
      const { data: inquiries, error } = await supabase
        .from('client_contracts')
        .select('*, marketer:marketer_id(id, name, email)')
        .order('created_at', { ascending: false });

      if (error) throw error;
      return res.status(200).json({ success: true, inquiries: inquiries || [] });
    } catch (err) {
      console.error('Fetch inquiries error:', err);
      return res.status(500).json({ error: 'Failed to load inquiries' });
    }
  }

  // POST: Approve or deny inquiry
  if (req.method === 'POST') {
    const { inquiryId, action, denialReason } = req.body; // action: 'approve' or 'deny'

    if (!inquiryId || !action) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
      if (action === 'approve') {
        const { data: inquiry, error: fetchError } = await supabase
          .from('client_contracts')
          .select('service_tier, pricing_model')
          .eq('id', inquiryId)
          .single();

        if (fetchError) throw fetchError;

        // Calculate monthly revenue based on tier and pricing model
        const prices = {
          foundation: { contract: 500, 'month-to-month': 800 },
          growth: { contract: 1200, 'month-to-month': 1500 },
          premium: { contract: 2500, 'month-to-month': 3500 },
          special: { contract: 5000, 'month-to-month': 5000 }
        };

        const tier = inquiry.service_tier;
        const model = inquiry.pricing_model || 'contract';
        const fullPrice = prices[tier]?.[model] || 0;
        const monthlyRevenue = fullPrice; // Chelsea's revenue (marketer gets 50%)

        const { error: updateError } = await supabase
          .from('client_contracts')
          .update({
            status: 'approved',
            approved_at: new Date().toISOString(),
            approved_by: adminId,
            monthly_revenue: monthlyRevenue
          })
          .eq('id', inquiryId);

        if (updateError) throw updateError;
        return res.status(200).json({ success: true, message: 'Inquiry approved' });
      }

      if (action === 'deny') {
        const { error: updateError } = await supabase
          .from('client_contracts')
          .update({
            status: 'denied',
            denial_reason: denialReason || null
          })
          .eq('id', inquiryId);

        if (updateError) throw updateError;
        return res.status(200).json({ success: true, message: 'Inquiry denied' });
      }

      return res.status(400).json({ error: 'Invalid action' });
    } catch (err) {
      console.error('Update inquiry error:', err);
      return res.status(500).json({ error: 'Failed to update inquiry' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
