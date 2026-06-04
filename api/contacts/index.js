const { getSupabase } = require('../_lib/supabase');
const { requireAuth, cors } = require('../_lib/auth');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const supabase = getSupabase();

  if (req.method === 'GET') {
    try {
      const { page = 1, limit = 50, search, status, niche, campaign } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      let query = supabase
        .from('leads')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + parseInt(limit) - 1);

      if (search) {
        query = query.or(
          `first_name.ilike.%${search}%,last_name.ilike.%${search}%,company.ilike.%${search}%,phone.ilike.%${search}%,email.ilike.%${search}%`
        );
      }
      if (status) query = query.eq('status', status);
      if (niche) query = query.eq('niche', niche);
      if (campaign) query = query.eq('campaign', campaign);

      const { data, error, count } = await query;
      if (error) throw error;

      return res.status(200).json({
        leads: data,
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(count / parseInt(limit))
      });
    } catch (err) {
      console.error('GET contacts error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const { first_name, last_name, company, phone, email, country, niche, status, campaign, notes } = req.body;

      if (!first_name || !phone) {
        return res.status(400).json({ error: 'first_name and phone are required' });
      }

      const { data, error } = await supabase
        .from('leads')
        .insert([{ first_name, last_name, company, phone, email, country, niche, status: status || 'new', campaign, notes }])
        .select()
        .single();

      if (error) throw error;
      return res.status(201).json(data);
    } catch (err) {
      console.error('POST contact error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
