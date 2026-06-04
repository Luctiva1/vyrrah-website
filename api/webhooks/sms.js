const twilio = require('twilio');
const { getSupabase } = require('../_lib/supabase');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  // Validate Twilio signature
  const twilioSignature = req.headers['x-twilio-signature'];
  const url = `https://${req.headers.host}${req.url}`;
  const params = req.body || {};
  const authToken = process.env.TWILIO_API_SECRET;

  if (!twilio.validateRequest(authToken, twilioSignature, url, params)) {
    console.warn('Invalid Twilio signature on SMS webhook');
    // In production, uncomment the next line:
    // return res.status(403).end();
  }

  const { From: from, Body: body, MessageSid: messageSid } = req.body;
  const supabase = getSupabase();

  try {
    // Find lead by phone
    const { data: lead } = await supabase
      .from('leads')
      .select('id')
      .eq('phone', from)
      .maybeSingle();

    // Log inbound message
    await supabase.from('sms_messages').insert([{
      lead_id: lead?.id || null,
      phone: from,
      direction: 'inbound',
      body: body || '',
      twilio_sid: messageSid,
      status: 'received'
    }]);

    // Check for STOP keyword
    const trimmed = (body || '').trim().toUpperCase();
    const stopKeywords = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];

    if (stopKeywords.includes(trimmed)) {
      // Add to opt-outs
      await supabase
        .from('opt_outs')
        .upsert([{ phone: from }], { onConflict: 'phone' });

      // Mark pending sequences as skipped
      if (lead?.id) {
        await supabase
          .from('sequences')
          .update({ status: 'skipped' })
          .eq('lead_id', lead.id)
          .eq('status', 'pending');

        await supabase
          .from('leads')
          .update({ status: 'not_interested' })
          .eq('id', lead.id);
      }
    } else {
      // Update lead status to replied
      if (lead?.id) {
        await supabase
          .from('leads')
          .update({ status: 'replied' })
          .eq('id', lead.id)
          .in('status', ['new', 'contacted']);
      }
    }
  } catch (err) {
    console.error('SMS webhook error:', err);
  }

  // Return empty TwiML response
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
};
