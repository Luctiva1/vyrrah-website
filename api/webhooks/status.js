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
    console.warn('Invalid Twilio signature on status webhook');
    // In production, uncomment the next line:
    // return res.status(403).end();
  }

  const { CallSid: callSid, CallStatus: callStatus, CallDuration: callDuration } = req.body;

  try {
    const supabase = getSupabase();
    const updates = {};

    if (callDuration) updates.duration_seconds = parseInt(callDuration);

    // Map Twilio status to our outcome
    if (callStatus === 'completed' && parseInt(callDuration || 0) === 0) {
      updates.outcome = 'no_answer';
    } else if (callStatus === 'no-answer') {
      updates.outcome = 'no_answer';
    } else if (callStatus === 'busy') {
      updates.outcome = 'no_answer';
    } else if (callStatus === 'failed') {
      updates.outcome = 'no_answer';
    }

    if (Object.keys(updates).length > 0) {
      await supabase
        .from('calls')
        .update(updates)
        .eq('call_sid', callSid);
    }
  } catch (err) {
    console.error('Status webhook error:', err);
  }

  return res.status(200).end();
};
