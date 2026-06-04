const twilio = require('twilio');

let client = null;

function getTwilio() {
  if (!client) {
    client = new twilio(
      process.env.TWILIO_API_KEY,
      process.env.TWILIO_API_SECRET,
      { accountSid: process.env.TWILIO_ACCOUNT_SID }
    );
  }
  return client;
}

function validateTwilioSignature(req) {
  const authToken = process.env.TWILIO_API_SECRET;
  const twilioSignature = req.headers['x-twilio-signature'];
  const url = `https://${req.headers.host}${req.url}`;
  const params = req.body || {};
  return twilio.validateRequest(authToken, twilioSignature, url, params);
}

module.exports = { getTwilio, validateTwilioSignature };
