const { getTwilio } = require('../_lib/twilio');
const { getSupabase } = require('../_lib/supabase');
const { requireAuth, cors } = require('../_lib/auth');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { to, body, lead_id } = req.body;

    if (!to || !body) {
      return res.status(400).json({ error: 'to and body are required' });
    }

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
    const message = await twilio.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
      body
    });

    // Log to DB
    const { data: smsRecord, error: dbError } = await supabase
      .from('sms_messages')
      .insert([{
        lead_id: lead_id || null,
        phone: to,
        direction: 'outbound',
        body,
        twilio_sid: message.sid,
        status: message.status
      }])
      .select()
      .single();

    if (dbError) console.error('DB log error:', dbError);

    // Update lead status if lead_id provided
    if (lead_id) {
      await supabase
        .from('leads')
        .update({ status: 'contacted' })
        .eq('id', lead_id)
        .eq('status', 'new');
    }

    return res.status(200).json({ success: true, sid: message.sid, record: smsRecord });
  } catch (err) {
    console.error('SMS send error:', err);
    return res.status(500).json({ error: err.message });
  }
};
