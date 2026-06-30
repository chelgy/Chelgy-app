export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const marketerId = req.headers['x-user-id']; // passed from frontend

  if (!marketerId) {
    return res.status(400).json({ error: 'Not authenticated' });
  }

  try {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const { data: contracts, error } = await supabase
      .from('client_contracts')
      .select('*')
      .eq('marketer_id', marketerId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return res.status(200).json({ success: true, contracts: contracts || [] });
  } catch (err) {
    console.error('Load contracts error:', err);
    return res.status(500).json({ error: 'Failed to load contracts' });
  }
}
