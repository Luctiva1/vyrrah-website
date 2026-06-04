const { getTwilio } = require('../_lib/twilio');
const { getSupabase } = require('../_lib/supabase');
const { requireAuth, cors } = require('../_lib/auth');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { to, lead_id } = req.body;
    if (!to) return res.status(400).json({ error: 'to is required' });

    const supabase = getSupabase();

    // Check opt-out
    const { data: optOut } = await supabase
      .from('opt_outs')
      .select('id')
      .eq('phone', to)
      .maybeSingle();

    if (optOut) {
      return res.status(400).json({ error: 'This number has opted out' });
    }

    const twilio = getTwilio();
    const baseUrl = `https://${req.headers.host}`;

    const call = await twilio.calls.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
      url: `${baseUrl}/api/webhooks/voice`,
      statusCallback: `${baseUrl}/api/webhooks/status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      record: true,
      recordingStatusCallback: `${baseUrl}/api/webhooks/recording`
    });

    // Log call to DB
    const { data: callRecord, error: dbError } = await supabase
      .from('calls')
      .insert([{
        lead_id: lead_id || null,
        phone: to,
        direction: 'outbound',
        call_sid: call.sid,
        outcome: null
      }])
      .select()
      .single();

    if (dbError) console.error('DB log error:', dbError);

    // Update lead status
    if (lead_id) {
      await supabase
        .from('leads')
        .update({ status: 'contacted' })
        .eq('id', lead_id)
        .eq('status', 'new');
    }

    return res.status(200).json({ success: true, call_sid: call.sid, record: callRecord });
  } catch (err) {
    console.error('Dial error:', err);
    return res.status(500).json({ error: err.message });
  }
};
