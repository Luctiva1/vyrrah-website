const twilio = require('twilio');

let client = null;

function getTwilio() {
  if (!client) {
    // Use Account SID + Auth Token (API Key auth does not work for this account)
    client = new twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
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

function getFromNumber(toPhone) {
  // Select outbound number based on destination country prefix
  // Falls back to US number if country-specific number not configured
  const digits = (toPhone || '').replace(/\D/g, '');
  if (digits.startsWith('44') && process.env.TWILIO_UK_NUMBER) return process.env.TWILIO_UK_NUMBER;
  if (digits.startsWith('61') && process.env.TWILIO_AU_NUMBER) return process.env.TWILIO_AU_NUMBER;
  return process.env.TWILIO_PHONE_NUMBER; // US default (+15106310835)
}

module.exports = { getTwilio, validateTwilioSignature, getFromNumber };
