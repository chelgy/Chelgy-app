export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { clientName, businessType, serviceTier, pricingModel, notes } = req.body;
  const marketerId = req.headers['x-user-id']; // passed from frontend

  if (!marketerId || !clientName || !serviceTier) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const { data, error } = await supabase
      .from('client_contracts')
      .insert([
        {
          marketer_id: marketerId,
          client_name: clientName,
          business_type: businessType || null,
          service_tier: serviceTier,
          pricing_model: pricingModel || 'contract',
          notes: notes || null,
          status: 'submitted'
        }
      ])
      .select();

    if (error) throw error;

    return res.status(200).json({ success: true, inquiry: data[0] });
  } catch (err) {
    console.error('Submit inquiry error:', err);
    return res.status(500).json({ error: 'Failed to submit inquiry' });
  }
}
