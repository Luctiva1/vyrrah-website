const { getSupabase } = require('../_lib/supabase');
const { requireAuth, cors } = require('../_lib/auth');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ error: 'phone query param required' });

    const supabase = getSupabase();

    const { data: messages, error } = await supabase
      .from('sms_messages')
      .select('*')
      .eq('phone', phone)
      .order('created_at', { ascending: true });

    if (error) throw error;

    // Find associated lead
    const { data: lead } = await supabase
      .from('leads')
      .select('id, first_name, last_name, company, status')
      .eq('phone', phone)
      .maybeSingle();

    return res.status(200).json({ messages: messages || [], lead });
  } catch (err) {
    console.error('Conversation error:', err);
    return res.status(500).json({ error: err.message });
  }
};
