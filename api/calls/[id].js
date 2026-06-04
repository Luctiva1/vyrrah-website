const { getSupabase } = require('../_lib/supabase');
const { requireAuth, cors } = require('../_lib/auth');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== 'PUT') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id required' });

    const { outcome, notes, duration_seconds } = req.body;

    const updates = {};
    if (outcome !== undefined) updates.outcome = outcome;
    if (notes !== undefined) updates.notes = notes;
    if (duration_seconds !== undefined) updates.duration_seconds = duration_seconds;

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('calls')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Call not found' });

    // Update lead status based on outcome
    if (data.lead_id && outcome) {
      let leadStatus = null;
      if (outcome === 'interested') leadStatus = 'replied';
      else if (outcome === 'not_interested') leadStatus = 'not_interested';
      else if (outcome === 'callback') leadStatus = 'follow_up';

      if (leadStatus) {
        await supabase
          .from('leads')
          .update({ status: leadStatus })
          .eq('id', data.lead_id);
      }
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error('PUT call error:', err);
    return res.status(500).json({ error: err.message });
  }
};
