const { getSupabase } = require('../_lib/supabase');
const { requireAuth, cors } = require('../_lib/auth');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const supabase = getSupabase();

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayISO = todayStart.toISOString();

    const [
      { count: callsToday },
      { count: smsSent },
      { count: totalLeads },
      { count: newLeads },
      { count: contacted },
      { count: replied },
      { count: booked },
      { count: notInterested },
      { count: followUp },
      { data: answeredCalls },
      { data: recentCalls },
      { data: recentSms }
    ] = await Promise.all([
      supabase.from('calls').select('*', { count: 'exact', head: true }).gte('created_at', todayISO),
      supabase.from('sms_messages').select('*', { count: 'exact', head: true }).eq('direction', 'outbound').gte('created_at', todayISO),
      supabase.from('leads').select('*', { count: 'exact', head: true }),
      supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'new'),
      supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'contacted'),
      supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'replied'),
      supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'booked'),
      supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'not_interested'),
      supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'follow_up'),
      supabase.from('calls').select('id').eq('outcome', 'answered').gte('created_at', todayISO),
      supabase.from('calls').select('*').order('created_at', { ascending: false }).limit(10),
      supabase.from('sms_messages').select('*').order('created_at', { ascending: false }).limit(10)
    ]);

    const answerRate = callsToday > 0
      ? Math.round(((answeredCalls?.length || 0) / callsToday) * 100)
      : 0;

    return res.status(200).json({
      today: {
        calls: callsToday || 0,
        sms_sent: smsSent || 0,
        answered: answeredCalls?.length || 0,
        answer_rate: answerRate
      },
      leads: {
        total: totalLeads || 0,
        new: newLeads || 0,
        contacted: contacted || 0,
        replied: replied || 0,
        booked: booked || 0,
        not_interested: notInterested || 0,
        follow_up: followUp || 0
      },
      recent_calls: recentCalls || [],
      recent_sms: recentSms || []
    });
  } catch (err) {
    console.error('Stats error:', err);
    return res.status(500).json({ error: err.message });
  }
};
