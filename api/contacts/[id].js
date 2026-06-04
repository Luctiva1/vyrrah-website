const { getSupabase } = require('../_lib/supabase');
const { requireAuth, cors } = require('../_lib/auth');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });

  const supabase = getSupabase();

  if (req.method === 'GET') {
    try {
      const { data: lead, error: leadError } = await supabase
        .from('leads')
        .select('*')
        .eq('id', id)
        .single();

      if (leadError) throw leadError;
      if (!lead) return res.status(404).json({ error: 'Lead not found' });

      const [{ data: sms }, { data: calls }, { data: sequences }] = await Promise.all([
        supabase.from('sms_messages').select('*').eq('lead_id', id).order('created_at', { ascending: false }).limit(50),
        supabase.from('calls').select('*').eq('lead_id', id).order('created_at', { ascending: false }).limit(50),
        supabase.from('sequences').select('*').eq('lead_id', id).order('step', { ascending: true })
      ]);

      return res.status(200).json({ lead, sms: sms || [], calls: calls || [], sequences: sequences || [] });
    } catch (err) {
      console.error('GET contact error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'PUT') {
    try {
      const { status, notes, company, email, niche, campaign } = req.body;
      const updates = {};
      if (status !== undefined) updates.status = status;
      if (notes !== undefined) updates.notes = notes;
      if (company !== undefined) updates.company = company;
      if (email !== undefined) updates.email = email;
      if (niche !== undefined) updates.niche = niche;
      if (campaign !== undefined) updates.campaign = campaign;

      const { data, error } = await supabase
        .from('leads')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return res.status(200).json(data);
    } catch (err) {
      console.error('PUT contact error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
