const { verifyToken, cors } = require('../_lib/auth');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = verifyToken(req);
  if (!payload) {
    return res.status(401).json({ valid: false, error: 'Invalid or expired token' });
  }
  return res.status(200).json({ valid: true, username: payload.username });
};
