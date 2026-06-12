// Website Leak Finder backend.
// Fetches the submitted homepage, trims it, and asks gpt-4o-mini for the
// single biggest conversion leak. Standalone function; does not touch api/index.js.

const MAX_HTML_CHARS = 9000;
const FETCH_TIMEOUT_MS = 10000;
const OPENAI_TIMEOUT_MS = 20000;

function isBlockedHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  // raw IPv4: block private/loopback/link-local ranges
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
  // keep structure-relevant tags readable, drop attributes noise except href/tel hints
  t = t.replace(/\s(?!href|src|alt|action|type|placeholder)[a-z-]+="[^"]*"/gi, '');
  t = t.replace(/\s+/g, ' ');
  return t.slice(0, MAX_HTML_CHARS);
}

async function fetchWithTimeout(url, ms, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ ok: false, reason: 'method_not_allowed' }));
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

  // 2. Ask gpt-4o-mini for the verdict
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, reason: 'not_configured' }));
  }

  const system = `You are a conversion rate auditor for local service business websites (dental, medspa, law, home services and similar). You are given the trimmed homepage HTML of a business website. Find the SINGLE biggest conversion leak you can actually detect in the HTML. Candidate leaks, in rough order of typical severity: no clear primary call to action above the fold, no click-to-call (tel:) link, no online booking or appointment path, no reviews or trust signals shown, no service area or location clarity, weak or generic headline that does not say what the business does, contact info buried, no offer or reason to act now. Pick the one leak the evidence best supports. Be specific to THIS site: reference what you actually saw or did not see. Voice rules: confident, plain, punchy, second person ("your site"). Short sentences. No em dashes, no en dashes, use commas or periods. Never use these words: unlock, elevate, supercharge, seamless, game-changing, revolutionize, delve, empower, leverage, transform, journey. Return JSON with exactly these keys: leak_title (one punchy sentence naming the leak, max 110 chars), impact (one line estimating the dollar or customer impact in plain terms, clearly an estimate, max 160 chars), fix (one specific actionable fix the owner could do this week, max 200 chars).`;

  try {
    const r = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', OPENAI_TIMEOUT_MS, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.4,
        max_tokens: 350,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `Site: ${target.hostname}\n\nTrimmed homepage HTML:\n${trimmed}` }
        ]
      })
    });
    if (!r.ok) throw new Error(`openai ${r.status}`);
    const data = await r.json();
    const out = JSON.parse(data.choices[0].message.content);
    if (!out.leak_title || !out.impact || !out.fix) throw new Error('bad shape');
    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok: true,
      leak_title: String(out.leak_title).slice(0, 160),
      impact: String(out.impact).slice(0, 220),
      fix: String(out.fix).slice(0, 280)
    }));
  } catch (e) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, reason: 'analysis_failed' }));
  }
};
