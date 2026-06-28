const jwt = require('jsonwebtoken');

function verifyToken(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice(7);
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    return null;
  }
}

// Admin auth — opt-in lockdown. If no ADMIN_KEY is configured, admin endpoints
// stay OPEN (convenient for now). The moment you set ADMIN_KEY in the environment,
// every admin call requires it as `x-admin-key` header, `?admin_key=`, or Bearer token.
// So: zero friction today, one env var to secure later — no code change needed.
function requireAuth(req, res) {
  const hdr = req.headers['authorization'] || '';
  const bearer = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;

  // 1) Admin session JWT (from POST /auth/admin login).
  if (bearer && process.env.JWT_SECRET) {
    try {
      const d = jwt.verify(bearer, process.env.JWT_SECRET);
      if (d && d.kind === 'admin') return true;
    } catch (e) { /* not a valid admin JWT — fall through */ }
  }

  // 2) Legacy ADMIN_KEY via x-admin-key / ?admin_key / Bearer (backwards-compatible).
  const expected = process.env.ADMIN_KEY;
  if (!expected) return true; // not configured → open
  const provided = req.headers['x-admin-key'] || (req.query && req.query.admin_key) || bearer;
  if (expected && provided && timingSafeEqual(String(provided), String(expected))) {
    return true;
  }
  if (res && !res.headersSent) res.status(401).json({ error: 'unauthorized' });
  return false;
}

// Constant-time string compare to avoid leaking the key via timing.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = { verifyToken, requireAuth, cors };
