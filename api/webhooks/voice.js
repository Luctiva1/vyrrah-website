const twilio = require('twilio');
const { getSupabase } = require('../_lib/supabase');

// Godwin's mobile number to forward inbound calls to
const FORWARD_TO = process.env.FORWARD_TO_MOBILE || '+918778974646';

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  // Validate Twilio signature
  const twilioSignature = req.headers['x-twilio-signature'];
  const url = `https://${req.headers.host}${req.url}`;
  const params = req.body || {};
  const authToken = process.env.TWILIO_API_SECRET;

  if (!twilio.validateRequest(authToken, twilioSignature, url, params)) {
    console.warn('Invalid Twilio signature on voice webhook');
    // In production, uncomment the next line:
    // return res.status(403).end();
  }

  const { From: from, CallSid: callSid, Direction: direction } = req.body;
  const supabase = getSupabase();

  try {
    if (direction === 'inbound') {
      // Find lead
      const { data: lead } = await supabase
        .from('leads')
        .select('id')
        .eq('phone', from)
        .maybeSingle();

      // Log inbound call
      await supabase.from('calls').insert([{
        lead_id: lead?.id || null,
        phone: from,
        direction: 'inbound',
        call_sid: callSid
      }]);
    }
  } catch (err) {
    console.error('Voice webhook error:', err);
  }

  // TwiML: dial forward to Godwin's number, or play a message
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  if (FORWARD_TO && FORWARD_TO !== process.env.TWILIO_PHONE_NUMBER) {
    twiml.dial(FORWARD_TO);
  } else {
    twiml.say(
      { voice: 'alice' },
      "Hi, you've reached Vyrrah Labs. Please leave a message after the tone or send us an SMS."
    );
    twiml.record({
      maxLength: 120,
      playBeep: true,
      transcribe: false
    });
  }

  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(twiml.toString());
};
