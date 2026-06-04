const { getSupabase } = require('../_lib/supabase');
const { requireAuth, cors } = require('../_lib/auth');

// Default SMS templates per step
const DEFAULT_TEMPLATES = [
  null, // step 1 must be provided
  "Hey {first_name}, just following up on my message. Would love to chat about how we can help {company}. Got 15 mins this week?",
  "Last follow-up {first_name} — if now's not the right time, no worries. Feel free to reach out whenever. Cheers, Godwin @ Vyrrah Labs"
];

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { lead_id, campaign, step1_message } = req.body;

    if (!lead_id || !campaign) {
      return res.status(400).json({ error: 'lead_id and campaign are required' });
    }
    if (!step1_message) {
      return res.status(400).json({ error: 'step1_message is required' });
    }

    const supabase = getSupabase();

    // Check if lead exists
    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('id, phone')
      .eq('id', lead_id)
      .single();

    if (leadError || !lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    // Check opt-out
    const { data: optOut } = await supabase
      .from('opt_outs')
      .select('id')
      .eq('phone', lead.phone)
      .maybeSingle();

    if (optOut) {
      return res.status(400).json({ error: 'Lead has opted out' });
    }

    // Cancel existing pending sequences for this lead+campaign
    await supabase
      .from('sequences')
      .update({ status: 'skipped' })
      .eq('lead_id', lead_id)
      .eq('campaign', campaign)
      .eq('status', 'pending');

    const now = new Date();
    const steps = [
      { step: 1, scheduled_at: now.toISOString(), message: step1_message },
      { step: 2, scheduled_at: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(), message: DEFAULT_TEMPLATES[1] },
      { step: 3, scheduled_at: new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString(), message: DEFAULT_TEMPLATES[2] }
    ];

    const rows = steps.map(s => ({
      lead_id,
      campaign,
      step: s.step,
      scheduled_at: s.scheduled_at,
      status: 'pending',
      message_body: s.message
    }));

    const { data, error } = await supabase
      .from('sequences')
      .insert(rows)
      .select();

    if (error) throw error;

    return res.status(200).json({ success: true, sequences: data });
  } catch (err) {
    console.error('Sequence trigger error:', err);
    return res.status(500).json({ error: err.message });
  }
};
