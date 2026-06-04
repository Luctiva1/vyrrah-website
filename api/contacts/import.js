const { getSupabase } = require('../_lib/supabase');
const { requireAuth, cors } = require('../_lib/auth');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { contacts } = req.body;

    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ error: 'contacts must be a non-empty array' });
    }

    if (contacts.length > 1000) {
      return res.status(400).json({ error: 'Maximum 1000 contacts per import' });
    }

    const rows = contacts.map(c => ({
      first_name: c.first_name || c.firstName || c['First Name'] || '',
      last_name: c.last_name || c.lastName || c['Last Name'] || null,
      company: c.company || c.Company || null,
      phone: c.phone || c.Phone || c.mobile || '',
      email: c.email || c.Email || null,
      country: c.country || c.Country || 'AU',
      niche: c.niche || c.Niche || null,
      status: 'new',
      campaign: c.campaign || c.Campaign || null,
      notes: c.notes || c.Notes || null
    })).filter(c => c.first_name && c.phone);

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('leads')
      .insert(rows)
      .select();

    if (error) throw error;

    return res.status(200).json({
      imported: data.length,
      skipped: contacts.length - rows.length,
      leads: data
    });
  } catch (err) {
    console.error('Import error:', err);
    return res.status(500).json({ error: err.message });
  }
};
