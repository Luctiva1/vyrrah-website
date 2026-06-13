// Website Leak Finder backend.
// Fetches the submitted homepage, trims it, and asks the cheapest capable LLM
// (Gemini 2.5 Flash-Lite by default, OpenAI as fallback) for the single biggest
// conversion leak. Standalone function; does not touch api/index.js.

const MAX_HTML_CHARS = 9000;
const FETCH_TIMEOUT_MS = 10000;
const LLM_TIMEOUT_MS = 20000;
const GEMINI_MODEL = 'gemini-2.5-flash-lite';

// Best-effort per-IP rate limit (per warm instance; pair with a KV store for hard limits).
const RL_WINDOW_MS = 60000;
const RL_MAX = 8;
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < RL_WINDOW_MS);
  if (arr.length >= RL_MAX) { hits.set(ip, arr); return true; }
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return false;
}

const ALLOWED_HOSTS = ['vyrrahlabs.com', 'www.vyrrahlabs.com'];
function originAllowed(req) {
  const o = req.headers.origin;
  if (!o) return true; // no Origin (server-side / curl): allow, rate limit still applies
  try {
    const h = new URL(o).hostname;
    return ALLOWED_HOSTS.includes(h) || h.endsWith('.vercel.app');
  } catch (e) { return false; }
}

function isBlockedHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return true;
  }
  if (h.includes(':')) return true; // IPv6 literals
  return false;
}

function trimHtml(html) {
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/\s(?!href|src|alt|action|type|placeholder)[a-z-]+="[^"]*"/gi, '');
  t = t.replace(/\s+/g, ' ');
  return t.slice(0, MAX_HTML_CHARS);
}

async function fetchWithTimeout(url, ms, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(timer); }
}

const SYSTEM = `You are a conversion rate auditor for local service business websites (dental, medspa, law, home services and similar). You are given the trimmed homepage HTML of a business website. Find the SINGLE biggest conversion leak you can actually detect in the HTML. Candidate leaks, in rough order of typical severity: no clear primary call to action above the fold, no click-to-call (tel:) link, no online booking or appointment path, no reviews or trust signals shown, no service area or location clarity, weak or generic headline that does not say what the business does, contact info buried, no offer or reason to act now. Pick the one leak the evidence best supports. Be specific to THIS site: reference what you actually saw or did not see. Voice rules: confident, plain, punchy, second person ("your site"). Short sentences. No em dashes, no en dashes, use commas or periods. Never use these words: unlock, elevate, supercharge, seamless, game-changing, revolutionize, delve, empower, leverage, transform, journey. Return JSON with exactly these keys: leak_title (one punchy sentence naming the leak, max 110 chars), impact (one line estimating the dollar or customer impact in plain terms, clearly an estimate, max 160 chars), fix (one specific actionable fix the owner could do this week, max 200 chars).`;

function userPrompt(host, trimmed) {
  return `Site: ${host}\n\nTrimmed homepage HTML:\n${trimmed}`;
}

async function callGemini(key, host, trimmed) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const r = await fetchWithTimeout(url, LLM_TIMEOUT_MS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt(host, trimmed) }] }],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 400,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: { leak_title: { type: 'STRING' }, impact: { type: 'STRING' }, fix: { type: 'STRING' } },
          required: ['leak_title', 'impact', 'fix']
        }
      }
    })
  });
  if (!r.ok) throw new Error('gemini ' + r.status);
  const data = await r.json();
  const text = data && data.candidates && data.candidates[0] && data.candidates[0].content
    && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
    && data.candidates[0].content.parts[0].text;
  if (!text) throw new Error('gemini empty');
  return JSON.parse(text);
}

async function callOpenAI(key, host, trimmed) {
  const r = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', LLM_TIMEOUT_MS, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.4,
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userPrompt(host, trimmed) }
      ]
    })
  });
  if (!r.ok) throw new Error('openai ' + r.status);
  const data = await r.json();
  return JSON.parse(data.choices[0].message.content);
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ ok: false, reason: 'method_not_allowed' }));
  }
  if (!originAllowed(req)) {
    res.statusCode = 403;
    return res.end(JSON.stringify({ ok: false, reason: 'forbidden_origin' }));
  }
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
  if (rateLimited(ip)) {
    res.statusCode = 429;
    return res.end(JSON.stringify({ ok: false, reason: 'rate_limited' }));
  }

  let target;
  try {
    const body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');
    target = new URL(String(body.url || ''));
    if (!/^https?:$/.test(target.protocol)) throw new Error('bad protocol');
    if (!target.hostname.includes('.') || isBlockedHost(target.hostname)) throw new Error('bad host');
  } catch (e) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, reason: 'invalid_url' }));
  }

  // 1. Fetch their homepage
  let html;
  try {
    const r = await fetchWithTimeout(target.href, FETCH_TIMEOUT_MS, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 VyrrahLeakFinder/1.0',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    const ctype = r.headers.get('content-type') || '';
    if (!r.ok || !ctype.includes('html')) throw new Error('fetch blocked');
    html = await r.text();
    if (!html || html.length < 200) throw new Error('empty page');
  } catch (e) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, reason: 'fetch_failed' }));
  }

  const trimmed = trimHtml(html);

  // 2. Verdict from the cheapest available model (Gemini preferred, OpenAI fallback)
  const gemKey = process.env.GEMINI_API_KEY;
  const oaKey = process.env.OPENAI_API_KEY;
  if (!gemKey && !oaKey) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, reason: 'not_configured' }));
  }

  let out = null;
  try {
    out = gemKey ? await callGemini(gemKey, target.hostname, trimmed) : await callOpenAI(oaKey, target.hostname, trimmed);
  } catch (e) {
    if (gemKey && oaKey) { try { out = await callOpenAI(oaKey, target.hostname, trimmed); } catch (e2) { out = null; } }
  }

  if (!out || !out.leak_title || !out.impact || !out.fix) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, reason: 'analysis_failed' }));
  }
  res.statusCode = 200;
  return res.end(JSON.stringify({
    ok: true,
    leak_title: String(out.leak_title).slice(0, 160),
    impact: String(out.impact).slice(0, 220),
    fix: String(out.fix).slice(0, 280)
  }));
};
