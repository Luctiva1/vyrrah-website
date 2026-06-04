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
    console.warn('Invalid Twilio signature on recording webhook');
    // In production, uncomment the next line:
    // return res.status(403).end();
  }

  const {
    CallSid: callSid,
    RecordingUrl: recordingUrl,
    RecordingSid: recordingSid,
    RecordingStatus: recordingStatus
  } = req.body;

  if (recordingStatus !== 'completed' || !recordingUrl) {
    return res.status(200).end();
  }

  try {
    const supabase = getSupabase();
    // Append .mp3 for easy playback
    const mp3Url = `${recordingUrl}.mp3`;

    await supabase
      .from('calls')
      .update({ recording_url: mp3Url })
      .eq('call_sid', callSid);
  } catch (err) {
    console.error('Recording webhook error:', err);
  }

  return res.status(200).end();
};
