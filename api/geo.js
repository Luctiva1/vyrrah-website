// V-Rank — AI SEO + Generative Engine Optimization backend.
// Three contract endpoints, all routed via ?path=:
//   POST /api/geo?path=scorecard  {url} -> visibility scorecard + ranked gaps
//   POST /api/geo?path=generate   {url_or_topic,type} -> SEO/GEO content + JSON-LD
//   GET  /api/geo?path=dashboard&client_id=X -> tracked growth metrics
//
// Design rules (match api/tool.js + api/analyze.js conventions):
//   • Self-contained serverless function. Does not touch api/index.js or api/tool.js.
//   • LLM via OPENAI_API_KEY (Gemini used if present, same cheap-first order as
//     the rest of the app). If NO key is set, every endpoint still returns clean,
//     deterministic heuristic/mock data so the tool demos perfectly offline.
//   • COLD START: scorecard/generate work for a brand-new business with no
//     reviews, no content, no history — the Engine generates foundational pages
//     and schema from scratch and the scorecard explains the cold-start path.
//
// vercel.json INTEGRATION NOTE (integrator must add, above the /api/(.*) catch-all):
//   { "src": "/api/geo", "dest": "/api/geo" }
// so the ?path= query survives instead of being rewritten to /api/index.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { cors, requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');

// ─── V-Rank account constants ────────────────────────────────────────────────
// A V-Rank customer is just a row in the SHARED `tool_clients` table (the same
// table the Recaller product uses) with plan='vrank'. We reuse Recaller's auth
// (JWT shape, magic_token, bcrypt password hashes) and billing (Dodo) verbatim,
// so /api/tool/auth/login, /api/tool/admin-action and the Dodo webhook all keep
// working for V-Rank accounts with zero changes to tool.js.
const VRANK_PLAN = 'vrank';
const PUBLIC_BASE = process.env.PUBLIC_BASE || 'https://vyrrahlabs.com';

// Mirror of tool.js issueClientToken() — DO NOT import from tool.js (keep files
// independent). Same JWT shape so the existing applyBearerSession()/auth accepts it.
function issueClientToken(client) {
  return jwt.sign(
    { kind: 'client', cid: client.id, mt: client.magic_token },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// Resolve the calling CUSTOMER from either a client-session Bearer JWT (cid/mt)
// or a ?token= magic_token. Returns the tool_clients row, or null if neither
// identifies a real account. Used by the self-service dashboard.
async function resolveCustomer(req) {
  const supabase = getSupabase();
  // 1) Bearer client JWT → look up by cid (verify mt matches to prevent stale tokens).
  const hdr = req.headers['authorization'] || '';
  if (hdr.startsWith('Bearer ') && process.env.JWT_SECRET) {
    try {
      const d = jwt.verify(hdr.slice(7), process.env.JWT_SECRET);
      if (d && d.kind === 'client' && d.cid) {
        const { data } = await supabase.from('tool_clients').select('*').eq('id', d.cid).limit(1);
        const c = data && data[0];
        if (c && (!d.mt || c.magic_token === d.mt)) return c;
      }
    } catch (e) { /* not a valid client JWT — try token */ }
  }
  // 2) ?token= magic_token (the credential the dashboard stores in localStorage).
  const token = req.query && req.query.token;
  if (token) {
    const { data } = await supabase.from('tool_clients').select('*').eq('magic_token', token).limit(1);
    const c = data && data[0];
    if (c) return c;
  }
  return null;
}

// Map a tool_clients row to the safe public shape the dashboard/admin UI consumes.
function publicClient(c) {
  if (!c) return null;
  return {
    id: c.id,
    practice_name: c.practice_name || null,
    owner_name: c.owner_name || null,
    owner_email: c.owner_email || null,
    website: c.website || null,
    plan: c.plan || 'recaller',
    status: c.status || null,
    avg_customer_value: c.avg_customer_value || null,
    trial_started_at: c.trial_started_at || null,
    created_at: c.created_at || null
  };
}

// ─── Tunables ────────────────────────────────────────────────────────────────
const MAX_HTML_CHARS = 9000;
const FETCH_TIMEOUT_MS = 10000;
const LLM_TIMEOUT_MS = 22000;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// ─── Best-effort per-IP rate limit (per warm instance) ───────────────────────
const RL_WINDOW_MS = 60000;
const RL_MAX = 12;
const _hits = new Map();
function rateLimited(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown';
  const now = Date.now();
  const arr = (_hits.get(ip) || []).filter((t) => now - t < RL_WINDOW_MS);
  if (arr.length >= RL_MAX) { _hits.set(ip, arr); return true; }
  arr.push(now);
  _hits.set(ip, arr);
  if (_hits.size > 5000) _hits.clear();
  return false;
}

// ─── URL safety (SSRF guard — mirrors api/analyze.js) ────────────────────────
function isBlockedHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) || (a === 169 && b === 254)) return true;
  }
  if (h.includes(':')) return true; // IPv6 literals
  return false;
}
function safeUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    if (!/^https?:$/.test(u.protocol)) return null;
    if (!u.hostname.includes('.') || isBlockedHost(u.hostname)) return null;
    return u;
  } catch (e) { return null; }
}

async function fetchWithTimeout(url, ms, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(timer); }
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(n))); }
function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; }
}

// ─── LLM availability + cheap-first JSON call ────────────────────────────────
function llmAvailable() {
  return !!(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);
}

// Ask the cheapest available model for a JSON object. Gemini first (free tier),
// OpenAI (OPENAI_API_KEY) next. Returns a parsed object or null on any failure.
async function llmJson(system, user, { geminiSchema = null, maxTokens = 1400 } = {}) {
  const gem = process.env.GEMINI_API_KEY;
  const oa = process.env.OPENAI_API_KEY;
  const tryGemini = async () => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
    const gen = { temperature: 0, maxOutputTokens: maxTokens, responseMimeType: 'application/json' };
    if (geminiSchema) gen.responseSchema = geminiSchema;
    const r = await fetchWithTimeout(url, LLM_TIMEOUT_MS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': gem },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: gen
      })
    });
    if (!r.ok) throw new Error('gemini ' + r.status);
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
    if (!text) throw new Error('gemini empty');
    return JSON.parse(text);
  };
  const tryOpenAI = async () => {
    const r = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', LLM_TIMEOUT_MS, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${oa}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
      })
    });
    if (!r.ok) throw new Error('openai ' + r.status);
    const data = await r.json();
    return JSON.parse(data.choices[0].message.content);
  };
  try {
    if (gem) return await tryGemini();
    if (oa) return await tryOpenAI();
  } catch (e) {
    if (gem && oa) { try { return await tryOpenAI(); } catch (e2) { /* fall through */ } }
    console.error('llmJson failed:', e.message);
  }
  return null;
}

// ─── Vertical inference (reuse of the tool.js idea, standalone here) ──────────
function inferVertical(text) {
  const t = String(text || '').toLowerCase();
  if (/restoration|water damage|fire damage|flood|\bmold|mitigation|smoke damage|biohazard/.test(t)) return 'restoration';
  if (/dental|dentist|orthodon|med ?spa|medspa|aesthetic|botox|filler|cosmetic/.test(t)) return 'dental/med-spa';
  if (/staffing|recruit|talent|placement|hiring|headhunt/.test(t)) return 'staffing/recruitment';
  if (/roof|storm|hail|shingle|gutter/.test(t)) return 'roofing';
  if (/plumb|drain|sewer|hvac|heating|cooling|electric/.test(t)) return 'home services';
  if (/shop|store|product|cart|checkout|ecommerce|e-commerce/.test(t)) return 'DTC/ecommerce';
  return 'local business';
}

// ─── Domain authority / real-world recognition estimate ──────────────────────
// The heart of the scoring fix. AI-search and Google visibility is driven first
// by how authoritative and recognized a DOMAIN is, NOT by whether a page ships a
// LocalBusiness/FAQ checklist. Reddit, Wikipedia, NYT etc. are cited constantly
// by ChatGPT/Perplexity/Google AI even though they carry none of the local-SEO
// markup a small business needs. This returns a 0-100 authority estimate from
// the hostname alone (deterministic, works with no LLM and no network).
const MEGA_AUTHORITY = new Set([
  'reddit.com', 'wikipedia.org', 'youtube.com', 'amazon.com', 'github.com',
  'stackoverflow.com', 'nytimes.com', 'medium.com', 'linkedin.com', 'quora.com',
  'forbes.com', 'bbc.com', 'cnn.com', 'theguardian.com', 'apple.com',
  'microsoft.com', 'google.com', 'imdb.com', 'yelp.com', 'tripadvisor.com',
  'healthline.com', 'mayoclinic.org', 'webmd.com', 'investopedia.com',
  'nih.gov', 'cdc.gov', 'harvard.edu', 'mit.edu', 'wikihow.com',
  'facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'pinterest.com',
  'ebay.com', 'etsy.com', 'walmart.com', 'target.com', 'bestbuy.com',
  'wsj.com', 'bloomberg.com', 'reuters.com', 'techcrunch.com', 'wired.com'
]);
function registrableHost(hostname) {
  const parts = String(hostname || '').toLowerCase().replace(/^www\./, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  // Handle common two-level public suffixes (co.uk, com.au, org.uk, gov.uk...).
  const twoLevel = /^(co|com|org|net|gov|edu|ac)\.(uk|au|nz|in|za|jp|br|sg)$/;
  const lastTwo = parts.slice(-2).join('.');
  if (twoLevel.test(lastTwo)) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}
function domainAuthority(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
  const reg = registrableHost(host);
  const tld = host.split('.').pop();
  let score = 40; // an ordinary, real, resolvable business domain baseline
  let recognized = false;
  if (MEGA_AUTHORITY.has(reg)) { score = 96; recognized = true; }
  else {
    // High-trust TLDs lift authority for sites we do not explicitly know.
    if (tld === 'gov' || tld === 'edu') { score += 35; recognized = true; }
    else if (tld === 'org') score += 8;
    // Short, brandable registrable domains tend to be more established.
    const core = reg.split('.')[0] || '';
    if (core.length > 0 && core.length <= 6) score += 8;
    else if (core.length <= 10) score += 4;
    // Hyphen/number-heavy domains read as smaller / newer / spammier.
    if ((core.match(/-/g) || []).length >= 1) score -= 6;
    if (/\d/.test(core)) score -= 4;
  }
  return { authority: clamp(score, 0, 100), recognized };
}

// ════════════════════════════════════════════════════════════════════════════
// 1) SCORECARD  —  POST /api/geo?path=scorecard  {url}
//    -> {score, breakdown:{seo,aeo,schema,content,reviews}, gaps:[{title,impact,fix}],
//        aiVisibility:{chatgpt,perplexity,google}, summary}
// ════════════════════════════════════════════════════════════════════════════

// Deterministic on-page signal extraction from raw HTML (no LLM, always runs).
function inspectHtml(html) {
  const h = String(html || '');
  const lower = h.toLowerCase();
  const titleMatch = h.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';
  const metaDesc = (h.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
                    h.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i) || [])[1] || '';
  const h1Count = (h.match(/<h1[\b >]/gi) || []).length;
  const jsonLdBlocks = h.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  const schemaTypes = [];
  for (const block of jsonLdBlocks) {
    const types = block.match(/"@type"\s*:\s*"([^"]+)"/gi) || [];
    for (const ty of types) { const m = /"@type"\s*:\s*"([^"]+)"/i.exec(ty); if (m) schemaTypes.push(m[1]); }
  }
  // crude visible-text length
  const textLen = h.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
  return {
    title, titleLen: title.length,
    metaDesc, metaDescLen: metaDesc.length,
    h1Count,
    hasViewport: /<meta[^>]+name=["']viewport["']/i.test(h),
    hasCanonical: /<link[^>]+rel=["']canonical["']/i.test(h),
    hasOpenGraph: /property=["']og:/i.test(h),
    hasFaq: /\bfaq\b|frequently asked/i.test(lower) || schemaTypes.some((t) => /faq/i.test(t)),
    hasTel: /href=["']tel:/i.test(h),
    hasReviews: /review|testimonial|★|stars?\b|rating/i.test(lower) || schemaTypes.some((t) => /review|aggregaterating/i.test(t)),
    jsonLdCount: jsonLdBlocks.length,
    schemaTypes: Array.from(new Set(schemaTypes)),
    textLen
  };
}

// Heuristic breakdown from signals (the no-LLM baseline and the LLM's anchor).
// `auth` is the {authority,recognized} estimate from domainAuthority(). The
// breakdown blends real-world domain authority with on-page signals so a
// recognized, content-rich domain (reddit.com) reads as HIGHLY visible even
// without local-SEO markup, while a thin/new site reads as low.
function heuristicBreakdown(sig, auth) {
  const A = (auth && Number.isFinite(auth.authority)) ? auth.authority : 40;
  const recognized = !!(auth && auth.recognized);
  // Authority floor per dimension. A recognized mega-authority (reddit, etc.)
  // is already trusted and surfaced everywhere, so it gets a HIGH floor in the
  // visibility dimensions regardless of on-page markup. An unknown small biz
  // (A~40) gets only a modest lift.
  const floor = recognized ? Math.round(A * 0.85) : Math.round(A * 0.55);

  // SEO = crawlability/classic ranking. Authority dominates real ranking power.
  let seo = Math.round(A * (recognized ? 0.8 : 0.55));
  if (sig.titleLen >= 15 && sig.titleLen <= 65) seo += 12; else if (sig.titleLen) seo += 6;
  if (sig.metaDescLen >= 50 && sig.metaDescLen <= 165) seo += 8; else if (sig.metaDescLen) seo += 4;
  if (sig.h1Count === 1) seo += 6; else if (sig.h1Count > 1) seo += 3;
  if (sig.hasCanonical) seo += 4;
  if (sig.hasViewport) seo += 5;
  seo = Math.max(seo, recognized ? floor : 0);

  // Schema is the one dimension that legitimately depends on on-page markup.
  // It informs GAPS, not the headline, so its low weight in the overall keeps it
  // from tanking an obviously-visible site. Authority gives only a small floor.
  let schema = sig.jsonLdCount ? 45 : 8;
  if (sig.schemaTypes.some((t) => /Organization|LocalBusiness|ProfessionalService|Corporation|Store|MedicalBusiness|MedicalOrganization|Dentist|Physician|HomeAndConstructionBusiness|LegalService|FinancialService/i.test(t))) schema += 22;
  if (sig.schemaTypes.some((t) => /FAQ/i.test(t))) schema += 18;
  if (sig.schemaTypes.some((t) => /Review|AggregateRating|Service|Product/i.test(t))) schema += 15;
  schema = Math.max(schema, Math.round(A * 0.35));

  // AEO = answer-engine citation likelihood. Recognized, broad sites get cited
  // constantly regardless of FAQ markup, so authority is the primary driver.
  let aeo = Math.round(A * (recognized ? 0.8 : 0.55));
  if (sig.hasFaq) aeo += 10;
  if (sig.schemaTypes.some((t) => /FAQ|HowTo|QAPage/i.test(t))) aeo += 10;
  if (sig.textLen > 1800) aeo += 8; else if (sig.textLen > 600) aeo += 4;
  aeo = Math.max(aeo, floor);

  // Content breadth/depth. Big platforms have enormous breadth even if the
  // single fetched page is short, so authority lifts the floor.
  let content = 20;
  if (sig.textLen > 6000) content += 46;
  else if (sig.textLen > 4000) content += 40;
  else if (sig.textLen > 2800) content += 33;
  else if (sig.textLen > 1800) content += 27;
  else if (sig.textLen > 1000) content += 19;
  else if (sig.textLen > 600) content += 13;
  else if (sig.textLen > 250) content += 7;
  if (sig.hasOpenGraph) content += 6;
  if (sig.h1Count >= 1) content += 8;
  content = Math.max(content, recognized ? floor : Math.round(A * 0.3));

  // Reviews/trust. Authority is itself a trust signal at the domain level.
  let reviews = sig.hasReviews ? 52 : 14;
  if (sig.schemaTypes.some((t) => /AggregateRating|Review/i.test(t))) reviews += 25;
  reviews = Math.max(reviews, Math.round(A * 0.3));

  return {
    seo: clamp(seo, 0, 100),
    aeo: clamp(aeo, 0, 100),
    schema: clamp(schema, 0, 100),
    content: clamp(content, 0, 100),
    reviews: clamp(reviews, 0, 100),
    authority: clamp(A, 0, 100)
  };
}

function overallFromBreakdown(b) {
  // Real discoverability is led by domain authority + AEO citation likelihood +
  // content breadth + classic SEO. Schema/reviews matter but must NOT tank the
  // headline score of an obviously-visible site, so they carry low weight.
  const A = Number.isFinite(b.authority) ? b.authority : 50;
  return clamp(
    A * 0.22 + b.aeo * 0.24 + b.content * 0.18 + b.seo * 0.18 + b.schema * 0.12 + b.reviews * 0.06,
    0, 100
  );
}

// Per-engine AI visibility estimate derived from breakdown (heuristic baseline).
function heuristicAiVisibility(b) {
  return {
    chatgpt: clamp(b.aeo * 0.5 + b.content * 0.3 + b.schema * 0.2, 0, 100),
    perplexity: clamp(b.aeo * 0.4 + b.schema * 0.35 + b.reviews * 0.25, 0, 100),
    google: clamp(b.seo * 0.5 + b.schema * 0.3 + b.content * 0.2, 0, 100)
  };
}

// Deterministic candidate gaps from signals. Each carries a `tier`:
//   'hard' = strategy/architecture/authority work that needs real expertise
//            (the kind a client should hire us for).
//   'easy' = trivial DIY on-page fixes (meta description, viewport, one H1).
// We surface only the HARD gaps in the headline list and withhold the easy wins,
// so the prospect feels they need help rather than a checklist they can DIY.
function candidateGaps(sig, vertical) {
  const gaps = [];
  // ── HARD: GEO/AEO strategy, schema architecture, content authority ──
  if (!sig.jsonLdCount || !sig.schemaTypes.some((t) => /Organization|LocalBusiness|ProfessionalService|Corporation|Store|MedicalBusiness|MedicalOrganization|Dentist|Physician|HomeAndConstructionBusiness|LegalService|FinancialService/i.test(t))) {
    gaps.push({ tier: 'hard', title: 'No entity / schema architecture for AI engines', impact: 'AI engines cannot resolve who you are as an entity, so you are absent from the knowledge graph that ChatGPT, Perplexity and Google AI draw answers from. This is the single biggest reason invisible businesses stay invisible.', fix: 'Design a connected schema architecture (Organization/LocalBusiness plus Service, FAQ and Review entities) so engines can model your business, not just read a page. This is strategy work, not a one-click plugin.' });
  }
  if (!sig.hasFaq && !sig.schemaTypes.some((t) => /FAQ/i.test(t))) {
    gaps.push({ tier: 'hard', title: 'No answer-engine (AEO) content strategy', impact: 'ChatGPT, Perplexity and Google AI cite Q&A-shaped, intent-matched content. Without an AEO content layer you are not in the consideration set when buyers ask AI for a recommendation.', fix: 'Build a researched AEO content program: map the questions buyers actually ask AI in your vertical, then publish authoritative answer pages with FAQPage structure that engines quote. Requires query research and editorial judgement.' });
  }
  if (sig.textLen < 1800) {
    gaps.push({ tier: 'hard', title: 'Insufficient topical authority / content depth', impact: 'Engines favour sources with demonstrated depth on a topic. A thin footprint means you lose citations to deeper competitors even when you are the better business.', fix: 'Develop a topical authority plan: a hub-and-spoke content map that covers your service area and expertise comprehensively enough for engines to treat you as a primary source. Strategic content architecture, not a single page.' });
  }
  const hasReviewSchema = sig.schemaTypes.some((t) => /AggregateRating|Review/i.test(t));
  if (sig.hasReviews && !hasReviewSchema) {
    gaps.push({ tier: 'hard', title: 'Reviews not marked up for AI engines', impact: 'You clearly have customer reviews, but they are not exposed as Review or AggregateRating schema, so ChatGPT, Perplexity and Google AI cannot read or weigh them when deciding who to recommend.', fix: 'Mark up your existing reviews with connected Review/AggregateRating schema and wire in a pipeline that keeps fresh ratings flowing into it, so engines can see the reputation you have already earned.' });
  } else if (!sig.hasReviews) {
    gaps.push({ tier: 'hard', title: 'No structured reputation / trust signal system', impact: 'Trust is decisive in whether AI recommends you over a competitor. Without a system that captures and structures reputation, engines have nothing to weigh in your favour.', fix: 'Stand up a reputation pipeline that gathers reviews from new customers and surfaces them with connected Review/AggregateRating schema engines can read. Ongoing system, not a widget.' });
  }
  // ── EASY: trivial DIY on-page fixes (withheld from the headline list) ──
  if (sig.titleLen === 0 || sig.titleLen > 65) {
    gaps.push({ tier: 'easy', title: sig.titleLen ? 'Title tag too long' : 'Missing title tag', impact: 'Weak or missing titles cut click-through and confuse crawlers about your core service.', fix: `Write a 50-60 char title leading with your primary ${vertical} service and city.` });
  }
  if (sig.metaDescLen === 0 || sig.metaDescLen > 165) {
    gaps.push({ tier: 'easy', title: sig.metaDescLen ? 'Meta description too long' : 'Missing meta description', impact: 'Search and AI snippets fall back to random page text, lowering relevance.', fix: 'Add a 140-160 char meta description naming the service, location and a reason to choose you.' });
  }
  if (sig.h1Count !== 1) {
    gaps.push({ tier: 'easy', title: sig.h1Count === 0 ? 'No H1 heading' : 'Multiple H1 headings', impact: 'Unclear page hierarchy makes it harder for AI to extract the main topic.', fix: 'Use exactly one descriptive H1 that states the service and city.' });
  }
  if (!sig.hasViewport) {
    gaps.push({ tier: 'easy', title: 'No mobile viewport tag', impact: 'Mobile-unfriendly pages are demoted in search and AI sourcing.', fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.' });
  }
  if (!sig.hasCanonical) {
    gaps.push({ tier: 'easy', title: 'No canonical tag', impact: 'Without a canonical, duplicate URLs can split your ranking signals.', fix: 'Add <link rel="canonical"> pointing to the preferred URL of each page.' });
  }
  return gaps;
}

// Back-compat helper: total count of real gaps found across both tiers.
function heuristicGaps(sig, vertical) {
  return candidateGaps(sig, vertical);
}

// Per-host scorecard cache: a rescan of the same site on a live call returns the
// IDENTICAL score/gaps (within a warm instance). Keyed by host + adSpend bucket.
const SCORECARD_CACHE = new Map();
const SCORECARD_TTL_MS = 30 * 60 * 1000;

async function handleScorecard(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (rateLimited(req)) return res.status(429).json({ error: 'Too many requests, slow down.' });

  const body = readBody(req);
  const u = safeUrl(body.url);
  if (!u) return res.status(400).json({ error: 'A valid http(s) url is required.' });

  // Return a cached payload for a repeat scan so the number never moves on a live rescan.
  const adSpendBucket = (Number.isFinite(Number(body.adSpend)) && Number(body.adSpend) > 0) ? Math.round(Number(body.adSpend)) : 0;
  const cacheKey = u.hostname.replace(/^www\./, '') + '|' + adSpendBucket;
  const forceRefresh = !!(body.refresh || (req.query && req.query.refresh));
  const cachedHit = forceRefresh ? null : SCORECARD_CACHE.get(cacheKey);
  if (cachedHit && (Date.now() - cachedHit.at) < SCORECARD_TTL_MS) {
    return res.status(200).json(cachedHit.payload);
  }

  // 1) Fetch the page. A fetch failure is NOT fatal — we treat it as a cold-start
  //    site with no data and still return a useful, generative-path scorecard.
  let html = '', fetchOk = false;
  try {
    const r = await fetchWithTimeout(u.href, FETCH_TIMEOUT_MS, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 VRank/1.0',
        'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    const ctype = r.headers.get('content-type') || '';
    if (r.ok && ctype.includes('html')) { html = await r.text(); fetchOk = html.length >= 200; }
  } catch (e) { /* treat as cold start below */ }

  const sig = inspectHtml(html);
  const vertical = inferVertical((sig.title + ' ' + sig.metaDesc) || u.hostname);
  const auth = domainAuthority(u.hostname);
  const baseBreakdown = heuristicBreakdown(sig, auth);
  const candGaps = candidateGaps(sig, vertical);
  // Only the HARD gaps are the headline list; total counts every real gap found.
  const baseHardGaps = candGaps.filter((g) => g.tier === 'hard').map(({ tier, ...g }) => g);
  // Pad the headline list to 3 so a heuristic fallback never collapses to 1 gap
  // (keeps parity with the LLM's "exactly 3" contract on a live rescan).
  const allStripped = candGaps.map(({ tier, ...g }) => g);
  const baseGaps = (baseHardGaps.length >= 3
    ? baseHardGaps
    : [...baseHardGaps, ...allStripped.filter((g) => !baseHardGaps.some((h) => h.title === g.title))]
  ).slice(0, 3);
  const totalGapsFound = candGaps.length;
  // A recognized mega-authority is never "cold start" even if the fetch was
  // blocked (Reddit etc. often refuse bot UAs): the domain is demonstrably
  // visible, so a cold-start verdict would directly contradict its high score.
  const coldStart = !auth.recognized && (!fetchOk || sig.textLen < 400);

  // Optional ad-spend value anchor — frames V-Rank's $500-750/mo as tiny vs ads.
  const adSpendRaw = Number(body.adSpend);
  const adSpend = Number.isFinite(adSpendRaw) && adSpendRaw > 0 ? Math.round(adSpendRaw) : null;

  // 2) If an LLM is available, let it assess AEO/GEO readiness and rewrite the
  //    score, gaps, summary and per-engine estimates — anchored to real signals.
  let out = null;
  if (llmAvailable()) {
    const system = [
      'You are a Generative Engine Optimization (GEO) and AI-search visibility auditor for local and DTC businesses.',
      'You assess how likely a site is to be CITED by ChatGPT, Perplexity, Claude and Google AI Overviews, plus classic SEO.',
      'CRITICAL SCORING RULE: the headline score reflects REAL-WORLD search and AI discoverability — how visible and how often cited the site actually is today. Judge that from what YOU know about this domain: its authority, recognition, brand presence, and breadth/depth of content. A hugely visible, authoritative domain (for example reddit.com, wikipedia.org, a major newspaper, a well-known national brand) MUST score HIGH (80-100) even if the fetched page lacks LocalBusiness schema, an FAQ, or visible reviews. Those local-SEO checklist items are NOT what makes a site visible. Do NOT anchor the score to the on-page checklist.',
      'The on-page signals and the heuristic checklist are provided ONLY to inform the GAPS (what to improve), not to lower the headline score of an obviously-visible site. A thin, brand-new, unknown site with little content should score LOW. A small local business with a modest real site should score MID.',
      'You are also given a domainAuthority estimate (0-100) and whether the domain is recognized. Treat a high authority/recognized domain as strong evidence of high real visibility.',
      'Voice: confident, plain, second person ("your site"). Short sentences. No em dashes or en dashes. Never use: unlock, elevate, supercharge, seamless, leverage, transform, journey, delve, empower, revolutionize.',
      'Return JSON with EXACTLY these keys:',
      'score (int 0-100 overall real AI/search-visibility score, judged as described above),',
      'breakdown {seo,aeo,schema,content,reviews} (each int 0-100),',
      'aiVisibility {chatgpt,perplexity,google} (each int 0-100, your estimate of current citation likelihood per engine),',
      'gaps (array of EXACTLY the 3 HARDEST, most expertise-requiring gaps {title,impact,fix} — GEO/AEO strategy, schema architecture, content/topical authority, structured reputation. Do NOT include trivial DIY fixes like "add a meta description", "add a viewport tag", or "fix the H1". Each fix should read as strategic work that needs a specialist, not a checklist item.),',
      'summary (2-3 sentences, the headline verdict and the single biggest strategic opportunity).',
      'competitorGap {competitor, theirVisibility, yourVisibility, line}: name a real, plausible competitor in this EXACT vertical and area that IS cited by AI today (a well-known category brand, or a realistic strong local-competitor name if you are unsure). theirVisibility = int 0-100, clearly higher than this site. yourVisibility = int 0-100, about equal to score. line = ONE punchy second-person sentence, e.g. "When someone asks ChatGPT for a water damage company near them, ServiceMaster gets named and you do not."',
      coldStart ? 'IMPORTANT COLD START: this site has little or no fetchable content AND is not a recognized authority. Score honestly low, and make the summary and gaps about GENERATING foundational pages, FAQ and schema from scratch, plus standing up a reputation system going forward.' : ''
    ].join('\n');
    const user = JSON.stringify({
      host: u.hostname, vertical, coldStart,
      domainAuthority: auth.authority, recognizedAuthority: auth.recognized,
      signals: sig,
      heuristic_breakdown: baseBreakdown,
      note: 'heuristic_hard_gaps are candidate strategic gaps; return only the 3 hardest. Easy on-page fixes are deliberately excluded.',
      heuristic_hard_gaps: baseHardGaps
    });
    const geminiSchema = {
      type: 'OBJECT',
      properties: {
        score: { type: 'INTEGER' },
        breakdown: { type: 'OBJECT', properties: { seo: { type: 'INTEGER' }, aeo: { type: 'INTEGER' }, schema: { type: 'INTEGER' }, content: { type: 'INTEGER' }, reviews: { type: 'INTEGER' } }, required: ['seo', 'aeo', 'schema', 'content', 'reviews'] },
        aiVisibility: { type: 'OBJECT', properties: { chatgpt: { type: 'INTEGER' }, perplexity: { type: 'INTEGER' }, google: { type: 'INTEGER' } }, required: ['chatgpt', 'perplexity', 'google'] },
        gaps: { type: 'ARRAY', items: { type: 'OBJECT', properties: { title: { type: 'STRING' }, impact: { type: 'STRING' }, fix: { type: 'STRING' } }, required: ['title', 'impact', 'fix'] } },
        summary: { type: 'STRING' },
        competitorGap: { type: 'OBJECT', properties: { competitor: { type: 'STRING' }, theirVisibility: { type: 'INTEGER' }, yourVisibility: { type: 'INTEGER' }, line: { type: 'STRING' } }, required: ['competitor', 'theirVisibility', 'yourVisibility', 'line'] }
      },
      required: ['score', 'breakdown', 'aiVisibility', 'gaps', 'summary']
    };
    out = await llmJson(system, user, { geminiSchema, maxTokens: 1600 });
  }

  // 3) Validate / fall back to heuristics. Always return the full contract shape.
  const breakdown = (out && out.breakdown && ['seo', 'aeo', 'schema', 'content', 'reviews'].every((k) => Number.isFinite(out.breakdown[k])))
    ? { seo: clamp(out.breakdown.seo, 0, 100), aeo: clamp(out.breakdown.aeo, 0, 100), schema: clamp(out.breakdown.schema, 0, 100), content: clamp(out.breakdown.content, 0, 100), reviews: clamp(out.breakdown.reviews, 0, 100) }
    : baseBreakdown;
  const score = (out && Number.isFinite(out.score)) ? clamp(out.score, 0, 100) : overallFromBreakdown(breakdown);
  const rawAi = (out && out.aiVisibility && ['chatgpt', 'perplexity', 'google'].every((k) => Number.isFinite(out.aiVisibility[k])))
    ? out.aiVisibility
    : heuristicAiVisibility(breakdown);
  // Keep per-engine visibility coherent with the headline score (within ±15) so a
  // low overall never sits next to "strong" engine bars on a live call.
  const cohere = (v) => clamp(Math.round(Math.max(score - 15, Math.min(score + 15, v))), 0, 100);
  const aiVisibility = { chatgpt: cohere(rawAi.chatgpt), perplexity: cohere(rawAi.perplexity), google: cohere(rawAi.google) };
  let gaps = (out && Array.isArray(out.gaps) && out.gaps.length)
    ? out.gaps.filter((g) => g && g.title && g.fix).map((g) => ({ title: String(g.title).slice(0, 120), impact: String(g.impact || '').slice(0, 240), fix: String(g.fix || '').slice(0, 280) }))
    : baseGaps;
  if (!gaps.length) gaps = baseGaps.length ? baseGaps : candGaps.map(({ tier, ...g }) => g);
  // FEWER, HARDER: surface only the top 3 hardest gaps. The full count is exposed
  // separately so the prospect sees there is more than they would want to DIY.
  gaps = gaps.slice(0, 3);
  const summary = (out && out.summary) ? String(out.summary).slice(0, 600)
    : (coldStart
        ? `We could not read much content at ${u.hostname}, so you are close to invisible in AI search today. The fast path is to generate foundational pages, an FAQ and connected schema from scratch, then stand up a reputation system. Your AI-visibility score is ${score}/100.`
        : `${u.hostname} scores ${score}/100 for AI visibility. The biggest lever right now is ${((gaps[0] && gaps[0].title) || 'building schema architecture and answer-shaped content').charAt(0).toLowerCase() + ((gaps[0] && gaps[0].title) || 'building schema architecture and answer-shaped content').slice(1)}, so engines like ChatGPT and Perplexity cite you more often.`);

  // AD-SPEND VALUE ANCHOR (optional). Frames $500-750/mo V-Rank vs rented ad traffic.
  let valueAnchor = null;
  if (adSpend) {
    const annualAdSpend = adSpend * 12;
    const fmt = (n) => '$' + n.toLocaleString('en-US');
    valueAnchor = {
      annualAdSpend,
      monthlyAdSpend: adSpend,
      message: `You spend ${fmt(annualAdSpend)} a year renting traffic through ads. The moment you stop paying, that traffic stops. V-Rank earns you traffic you OWN, citations and rankings that keep working, for a fraction of that at around $750 a month. If you can grow on ${fmt(adSpend)}/mo of rented clicks, imagine what owning the same visibility does to your numbers.`
    };
  }

  // COMPETITOR CITATION GAP — the highest-urgency line: someone else is in the AI answer, you're not.
  const competitorGap = (out && out.competitorGap && out.competitorGap.competitor)
    ? {
        competitor: String(out.competitorGap.competitor).slice(0, 80),
        theirVisibility: clamp(Number(out.competitorGap.theirVisibility) || Math.min(96, score + 30), 0, 100),
        yourVisibility: clamp(Number.isFinite(Number(out.competitorGap.yourVisibility)) ? Number(out.competitorGap.yourVisibility) : score, 0, 100),
        line: String(out.competitorGap.line || '').slice(0, 240)
      }
    : {
        competitor: 'Your top competitors',
        theirVisibility: clamp(score + (score < 50 ? 40 : 22), 0, 100),
        yourVisibility: score,
        line: `When someone asks ChatGPT or Google AI who to hire for ${vertical} near them, your competitors get named and you do not. Every one of those answers is a call going somewhere else.`
      };
  if (!competitorGap.line) competitorGap.line = `Your competitors are showing up in AI answers for ${vertical}, and you are not.`;

  const payload = {
    score, breakdown, gaps, totalGapsFound, aiVisibility, summary, competitorGap,
    valueAnchor,
    meta: { url: u.href, host: u.hostname, vertical, coldStart, fetched: fetchOk, mock: !out, domainAuthority: auth.authority, recognizedAuthority: auth.recognized, signals: sig }
  };
  SCORECARD_CACHE.set(cacheKey, { at: Date.now(), payload });
  return res.status(200).json(payload);
}

// ════════════════════════════════════════════════════════════════════════════
// 2) GENERATE  —  POST /api/geo?path=generate  {url_or_topic, type}
//    type: 'article' | 'landing' | 'listicle' | 'schema'
//    -> {title, content, schema}
//    COLD START: no history needed — generates net-new content + valid JSON-LD.
// ════════════════════════════════════════════════════════════════════════════

const GEN_TYPES = new Set(['article', 'landing', 'listicle', 'schema']);

function buildSchemaFor(type, { topic, host, vertical }) {
  // Deterministic, valid JSON-LD by type. Used as the mock AND as a safety net.
  const url = host ? (host.startsWith('http') ? host : `https://${host}`) : undefined;
  const base = { '@context': 'https://schema.org' };
  if (type === 'landing') {
    return {
      ...base, '@type': 'LocalBusiness', name: topic || `Your ${vertical} business`,
      description: `Foundational ${vertical} landing page generated by V-Rank.`,
      url, areaServed: 'Local service area'
      // No aggregateRating: never fabricate reviews/ratings — invalid + a trust risk.
    };
  }
  if (type === 'listicle') {
    return {
      ...base, '@type': 'ItemList', name: topic || `Top ${vertical} picks`,
      itemListElement: [1, 2, 3].map((i) => ({ '@type': 'ListItem', position: i, name: `Item ${i}` }))
    };
  }
  if (type === 'schema') {
    // FAQPage is the highest-leverage schema for AI citation.
    return {
      ...base, '@type': 'FAQPage',
      mainEntity: [
        { '@type': 'Question', name: `What does ${topic || 'this business'} do?`, acceptedAnswer: { '@type': 'Answer', text: `It provides ${vertical} services to local customers.` } },
        { '@type': 'Question', name: 'How fast can you respond?', acceptedAnswer: { '@type': 'Answer', text: 'We respond quickly and can usually help the same day.' } },
        { '@type': 'Question', name: 'What areas do you serve?', acceptedAnswer: { '@type': 'Answer', text: 'We serve the local area and surrounding neighborhoods.' } }
      ]
    };
  }
  // article
  return {
    ...base, '@type': 'Article', headline: topic || `A guide to ${vertical}`,
    author: { '@type': 'Organization', name: host || 'Your business' },
    publisher: { '@type': 'Organization', name: host || 'Your business' },
    datePublished: new Date().toISOString().slice(0, 10)
  };
}

function mockContent(type, { topic, vertical, host }) {
  const subject = topic || host || `your ${vertical} business`;
  if (type === 'schema') {
    return `JSON-LD FAQPage schema generated for ${subject}. Paste this into a <script type="application/ld+json"> tag in your page <head>. This is the highest-leverage structured data for getting cited by ChatGPT, Perplexity and Google AI.`;
  }
  if (type === 'landing') {
    return [
      `# ${subject}: Fast, Trusted ${vertical} Help`,
      ``,
      `## Why choose us`,
      `We answer fast, show up on time, and treat your home or business like our own. Even as a newer ${vertical} provider, we put service first and back our work.`,
      ``,
      `## What we do`,
      `- Clear pricing with no surprises`,
      `- Quick response when you need us most`,
      `- Friendly, local team`,
      ``,
      `## Get started`,
      `Call now or request a callback. We will confirm details and book you in.`,
      ``,
      `> New business note: we are actively gathering reviews from every customer, so your feedback helps others find us.`
    ].join('\n');
  }
  if (type === 'listicle') {
    return [
      `# Top Things to Know About ${vertical} (${subject})`,
      ``,
      `1. **Response speed matters most.** The first business to reply usually wins the job.`,
      `2. **Ask about the process.** A clear, explained process is a sign of a pro.`,
      `3. **Check for structured info.** Businesses that publish clear FAQs are easier to trust.`,
      `4. **Look for transparent pricing.** No surprises means a better experience.`,
      `5. **Read recent reviews.** Fresh feedback beats old, stale ratings.`
    ].join('\n');
  }
  // article
  return [
    `# ${subject}: What You Need to Know`,
    ``,
    `When you are looking for ${vertical} help, a few things make the difference between a smooth experience and a stressful one. This guide walks through what to expect and how to choose well.`,
    ``,
    `## Know what you need`,
    `Start by writing down the problem in plain words. The clearer you are, the faster a good provider can help.`,
    ``,
    `## What good service looks like`,
    `Fast replies, clear pricing, and a team that explains the work. Those three signals predict a good outcome more than anything else.`,
    ``,
    `## Common questions`,
    `**How fast can I get help?** Often the same day for urgent needs. **What does it cost?** Ask for a clear estimate up front.`,
    ``,
    `## Next step`,
    `Reach out, describe your situation, and get a clear plan. A good ${vertical} provider makes the next step obvious.`
  ].join('\n');
}

// ── Multi-pass QA + risk gate ────────────────────────────────────────────────
// Nothing risky ever auto-publishes under a client's brand. Regulated verticals
// (medical/legal/financial) and unverifiable claims are FORCE-flagged for human
// review even when the QA model is unavailable (fail closed, never fail open).
const REGULATED_RX = /\b(medical|med ?spa|clinic|dental|dentist|doctor|physician|health|therapy|botox|filler|weight ?loss|glp-?1|hormone|trt|law|lawyer|attorney|legal|injury|financial|insurance)\b/i;
// Only genuinely-dangerous claims hard-flag in the heuristic (fail-safe when the QA
// model is down). Soft words ("best", "proven", "licensed") are left to the QA model
// to judge in context, so we don't flag 100% of normal marketing copy.
const CLAIM_RX = /\b(guarantee\w*|cure|#1|number one|clinically|fda|100%|risk-free|painless|permanent)\b/i;

function heuristicRisk(text, vertical) {
  const t = String(text || '');
  if (REGULATED_RX.test(String(vertical)) || REGULATED_RX.test(t)) return 'high';
  if (CLAIM_RX.test(t)) return 'high';
  return 'low';
}

async function qaContent(content, { type, vertical, host }) {
  const baseRisk = heuristicRisk(content + ' ' + vertical, vertical);
  const fallback = (msg) => ({ risk: baseRisk, autoApprove: baseRisk === 'low', issues: baseRisk === 'high' ? [msg] : [], content });
  if (!llmAvailable()) return fallback('Regulated/claim content — human review required (no QA model available).');
  const system = [
    'You are a STRICT content QA + compliance reviewer. This content will be PUBLISHED under a real client business brand, so a mistake costs them money or breaks the law.',
    'Flag: factual hallucinations, invented specifics (fake reviews/awards/stats/credentials), and unverifiable or non-compliant CLAIMS (medical, legal, financial, "guaranteed", "best", "cure", "#1", "FDA").',
    'If the vertical is regulated (medical, dental, health, legal, financial) OR any claim could be false/non-compliant, set risk "high" and autoApprove false — a human MUST review.',
    'Otherwise, remove or soften any problem phrasing and set risk "low", autoApprove true.',
    'Return JSON: { risk:"low"|"high", autoApprove:boolean, issues:[short strings], content: the reviewed/cleaned Markdown }.'
  ].join('\n');
  const schema = { type: 'OBJECT', properties: { risk: { type: 'STRING' }, autoApprove: { type: 'BOOLEAN' }, issues: { type: 'ARRAY', items: { type: 'STRING' } }, content: { type: 'STRING' } }, required: ['risk', 'autoApprove', 'issues', 'content'] };
  const rev = await llmJson(system, JSON.stringify({ type, vertical, host, content }), { geminiSchema: schema, maxTokens: 2500 });
  if (!rev) return fallback('Regulated/claim content — human review required (QA pass failed).');
  const risk = (baseRisk === 'high' || rev.risk === 'high') ? 'high' : 'low'; // QA can never DOWNgrade heuristic risk
  return {
    risk,
    autoApprove: risk === 'low' && rev.autoApprove !== false,
    issues: Array.isArray(rev.issues) ? rev.issues.slice(0, 8) : [],
    content: (typeof rev.content === 'string' && rev.content.trim()) ? rev.content : content,
  };
}

async function handleGenerate(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (rateLimited(req)) return res.status(429).json({ error: 'Too many requests, slow down.' });

  const body = readBody(req);
  const type = GEN_TYPES.has(String(body.type)) ? String(body.type) : 'article';
  const rawInput = String(body.url_or_topic || '').trim();
  if (!rawInput) return res.status(400).json({ error: 'url_or_topic is required.' });

  // Input may be a URL (use its host as context) or a free-text topic.
  const asUrl = safeUrl(rawInput);
  const host = asUrl ? asUrl.hostname : '';
  const topic = asUrl ? '' : rawInput;
  const vertical = inferVertical(rawInput);

  let out = null;
  if (llmAvailable()) {
    const system = [
      'You are an expert SEO + Generative Engine Optimization (GEO) content writer for local and DTC businesses.',
      'You write net-new, foundational content that is genuinely useful and structured so AI engines (ChatGPT, Perplexity, Claude, Google AI) will cite it.',
      'COLD START is normal: assume the business may have no existing content or reviews. Write from scratch. Do not invent fake specific reviews, fake awards, or fake statistics.',
      'Voice: clear, confident, second person where natural. Short sentences. No em dashes or en dashes. Never use: unlock, elevate, supercharge, seamless, leverage, transform, journey, delve, empower, revolutionize.',
      `Deliverable type: ${type}.`,
      type === 'article' ? 'Write a 500-800 word helpful article in Markdown with H2 sections and a short FAQ block.' : '',
      type === 'landing' ? 'Write a conversion landing page in Markdown: H1, value props, a what-we-do list, social-proof placeholder appropriate for a new business, and a clear call to action.' : '',
      type === 'listicle' ? 'Write a numbered listicle in Markdown with 5-8 specific, useful items and bold lead-ins.' : '',
      type === 'schema' ? 'Focus on the schema. Keep content short: one line explaining what the schema is and where to paste it.' : '',
      'Return JSON with EXACTLY these keys: title (string), content (string, Markdown for the deliverable), schema (a valid schema.org JSON-LD OBJECT appropriate to the type: Article for article, LocalBusiness for landing, ItemList for listicle, FAQPage for schema). The schema MUST be a JSON object, not a string.'
    ].filter(Boolean).join('\n');
    const user = JSON.stringify({ input: rawInput, isUrl: !!asUrl, host, topic, vertical, type });
    const geminiSchema = {
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING' },
        content: { type: 'STRING' },
        schema: { type: 'OBJECT' }
      },
      required: ['title', 'content', 'schema']
    };
    out = await llmJson(system, user, { geminiSchema, maxTokens: 2200 });
  }

  const title = (out && out.title) ? String(out.title).slice(0, 200)
    : (topic || (host ? `${host} — foundational ${type}` : `Foundational ${vertical} ${type}`));
  const content = (out && typeof out.content === 'string' && out.content.trim())
    ? out.content : mockContent(type, { topic, vertical, host });
  // Schema must be a valid object. Accept the LLM's if it parses, else build one.
  let schema = null;
  if (out && out.schema) {
    if (typeof out.schema === 'object') schema = out.schema;
    else { try { schema = JSON.parse(out.schema); } catch (e) { schema = null; } }
  }
  if (!schema || typeof schema !== 'object') schema = buildSchemaFor(type, { topic: title, host, vertical });
  if (!schema['@context']) schema['@context'] = 'https://schema.org';

  // Multi-pass QA + risk gate: auto-approve low-risk, flag regulated/claim content for review.
  const qa = await qaContent(content, { type, vertical, host });

  return res.status(200).json({
    title, content: qa.content, schema,
    qa: { status: qa.autoApprove ? 'approved' : 'needs_review', risk: qa.risk, autoApprove: qa.autoApprove, issues: qa.issues },
    meta: { type, vertical, coldStart: true, source: asUrl ? host : 'topic', mock: !out }
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 3) DASHBOARD  —  GET /api/geo?path=dashboard&client_id=X
//    -> {score, traffic, aiReferrals, indexedPages, rankings:[], citations:[], generatedThisMonth}
//    Reads from supabase geo_metrics/geo_clients if those tables exist; otherwise
//    returns representative mock data so COMMAND always renders.
// ════════════════════════════════════════════════════════════════════════════

// Deterministic, stable representative data seeded off client_id (so a given
// client always sees the same plausible numbers across loads in mock mode).
function seededRandom(seedStr) {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function representativeDashboard(clientId, siteText) {
  const rnd = seededRandom(String(clientId || 'demo'));
  const score = clamp(58 + rnd() * 34, 0, 100);
  const traffic = Math.round(900 + rnd() * 4200);
  const keywords = {
    restoration: ['water damage restoration near me', 'emergency flood cleanup', 'mold remediation cost', '24 hour water removal'],
    dental: ['dentist near me', 'teeth whitening cost', 'emergency dentist', 'invisalign price'],
    medspa: ['botox near me', 'lip filler cost', 'med spa near me', 'best facial treatments'],
    staffing: ['staffing agency near me', 'temp to hire jobs', 'warehouse staffing', 'how to find workers fast'],
    roofing: ['roof replacement cost', 'roofers near me', 'storm damage roof repair', 'metal roof installation'],
    legal: ['lawyer near me', 'free legal consultation', 'personal injury attorney', 'how much does a lawyer cost'],
    home: ['plumber near me', 'hvac repair cost', 'emergency electrician near me', 'same day home repair'],
    generic: ['best provider near me', 'top rated local service', 'same day service near me', 'service cost and quotes']
  };
  // Seed the vertical from the client's OWN site so a roofer never sees dental terms.
  const t = String(siteText || '').toLowerCase();
  let v = 'generic';
  if (/restoration|water damage|mold|flood|fire damage|remediation/.test(t)) v = 'restoration';
  else if (/roof/.test(t)) v = 'roofing';
  else if (/med ?spa|botox|filler|aesthetic|facial/.test(t)) v = 'medspa';
  else if (/dental|dentist|orthodont|invisalign/.test(t)) v = 'dental';
  else if (/staffing|recruit|temp agency|workforce/.test(t)) v = 'staffing';
  else if (/lawyer|attorney|legal|law firm|injury/.test(t)) v = 'legal';
  else if (/plumb|hvac|electric|contractor|handyman|landscap/.test(t)) v = 'home';
  const kw = keywords[v] || keywords.generic;
  const rankings = kw.map((keyword) => ({ keyword, position: clamp(1 + rnd() * 18, 1, 50), change: Math.round((rnd() - 0.4) * 8) }));
  const engines = ['ChatGPT', 'Perplexity', 'Google AI Overview', 'Claude'];
  const citations = engines.map((engine) => ({
    engine, query: kw[Math.floor(rnd() * kw.length)], cited: rnd() > 0.35,
    snippet: rnd() > 0.5 ? 'Your business listed among recommended local providers.' : 'Mentioned with phone and service area.',
    detectedAt: new Date(Date.now() - Math.floor(rnd() * 14) * 86400000).toISOString().slice(0, 10)
  }));
  return {
    score,
    traffic,
    aiReferrals: Math.round(traffic * (0.08 + rnd() * 0.22)),
    indexedPages: Math.round(18 + rnd() * 90),
    rankings,
    citations,
    generatedThisMonth: Math.round(4 + rnd() * 16)
  };
}

// Fetch the latest stored geo_metrics row for a client (best-effort).
async function latestMetrics(clientId) {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('geo_metrics')
      .select('*')
      .eq('client_id', String(clientId))
      .order('created_at', { ascending: false })
      .limit(1);
    if (!error && data && data[0]) return data[0];
  } catch (e) { /* table may not exist */ }
  return null;
}

// Build the dashboard contract payload for a client, merging stored metrics over
// deterministic representative data so the dashboard always renders.
function buildDashboard(clientId, stored, siteText) {
  const base = representativeDashboard(clientId, siteText);
  if (!stored) return { ...base, source: 'representative', mock: true };
  // Treat 0 / empty as "not yet populated" so a score-only seed (fresh trial) shows the
  // representative growth view instead of bare zeros. mock stays true until REAL work lands.
  const hasReal = (Number.isFinite(stored.traffic) && stored.traffic > 0) ||
    (Array.isArray(stored.citations) && stored.citations.length > 0) ||
    (Number.isFinite(stored.ai_referrals) && stored.ai_referrals > 0);
  return {
    score: Number.isFinite(stored.score) ? clamp(stored.score, 0, 100) : base.score,
    traffic: (Number.isFinite(stored.traffic) && stored.traffic > 0) ? stored.traffic : base.traffic,
    aiReferrals: (Number.isFinite(stored.ai_referrals) && stored.ai_referrals > 0) ? stored.ai_referrals : base.aiReferrals,
    indexedPages: (Number.isFinite(stored.indexed_pages) && stored.indexed_pages > 0) ? stored.indexed_pages : base.indexedPages,
    rankings: (Array.isArray(stored.rankings) && stored.rankings.length) ? stored.rankings : base.rankings,
    citations: (Array.isArray(stored.citations) && stored.citations.length) ? stored.citations : base.citations,
    generatedThisMonth: (Number.isFinite(stored.generated_this_month) && stored.generated_this_month > 0) ? stored.generated_this_month : base.generatedThisMonth,
    source: hasReal ? 'supabase' : 'representative',
    mock: !hasReal
  };
}

// GET /api/geo?path=dashboard
//   MODE A (self):  Authorization: Bearer <client JWT>  OR  ?token=<magic_token>
//                   → returns ONLY the calling customer's own metrics.
//   MODE B (admin): ?client_id=X  +  admin auth (requireAuth)
//                   → returns any client's metrics (used by command.html links).
async function handleDashboard(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // ── MODE A: self-service customer (per-account, ownership-bound) ──
  const hasBearer = String(req.headers['authorization'] || '').startsWith('Bearer ');
  const hasToken = !!(req.query && req.query.token);
  if ((hasBearer || hasToken) && !req.query.client_id) {
    const customer = await resolveCustomer(req);
    if (!customer) return res.status(401).json({ error: 'Sign in to view your dashboard.' });
    // Gate by lifecycle status: a paused/past_due/churned account (incl. a free trial the
    // cron flipped to 'paused' at expiry) must NOT keep full dashboard access forever.
    if (customer.status && !['trial', 'active'].includes(customer.status)) {
      return res.status(402).json({
        locked: true, status: customer.status,
        error: customer.status === 'paused' ? 'Your free trial has ended.' : 'Your subscription is not active.',
        upgrade_url: '/api/geo?path=checkout'
      });
    }
    const stored = await latestMetrics(customer.id);
    const { source, mock, ...data } = buildDashboard(customer.id, stored, customer.website || customer.practice_name);
    return res.status(200).json({
      ...data,
      meta: {
        client_id: customer.id, mode: 'self', source: source || 'representative',
        mock: !!mock, website: customer.website || null, plan: customer.plan || 'recaller',
        practice_name: customer.practice_name || null, status: customer.status || null
      }
    });
  }

  // ── MODE B: admin / command.html lookup by client_id ──
  // Admin-gated when ADMIN_KEY/JWT is configured; open otherwise (same posture as tool.js admin reads).
  if (!requireAuth(req, res)) return; // sends 401 itself when locked down
  const clientId = req.query.client_id || 'demo';
  const stored = await latestMetrics(clientId);
  const { source, mock, ...data } = buildDashboard(clientId, stored, '');
  return res.status(200).json({
    ...data,
    meta: { client_id: clientId, mode: 'admin', source: source || 'representative', mock: !!mock }
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 4) SIGNUP  —  POST /api/geo?path=signup  {email, password, website, name?, score?}
//    Creates a V-Rank account = a tool_clients row with plan='vrank'. Reuses the
//    Recaller account shape + magic_token + bcrypt so /api/tool/auth/login,
//    Dodo checkout and the admin panel all work against it unchanged.
// ════════════════════════════════════════════════════════════════════════════
async function handleSignup(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (rateLimited(req)) return res.status(429).json({ error: 'Too many requests, slow down.' });

  const body = readBody(req);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !email.includes('@') || email.length > 200) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  // Website is the V-Rank target site. Accept a bare host or full URL; normalize.
  let website = typeof body.website === 'string' ? body.website.trim() : '';
  if (website) {
    const withScheme = /^https?:\/\//i.test(website) ? website : `https://${website}`;
    const u = safeUrl(withScheme);
    website = u ? u.href : website.slice(0, 300);
  }
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
  // Use the host as a friendly practice_name fallback so the admin list reads well.
  let practiceName = name;
  if (!practiceName && website) {
    try { practiceName = new URL(website).hostname.replace(/^www\./, ''); } catch (e) { /* keep */ }
  }
  if (!practiceName) practiceName = email.split('@')[0];

  const supabase = getSupabase();

  // Reject duplicate signups (an existing account should log in, not re-create).
  try {
    const { data: existing } = await supabase
      .from('tool_clients').select('id').ilike('owner_email', email).limit(1);
    if (existing && existing[0]) {
      return res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });
    }
  } catch (e) { /* if lookup fails, fall through and let insert surface conflicts */ }

  const magicToken = crypto.randomBytes(24).toString('hex');
  let passwordHash;
  try { passwordHash = await bcrypt.hash(password, 10); }
  catch (e) { return res.status(500).json({ error: 'Could not secure password.' }); }

  // V-Rank does not use a phone line, but real_line is NOT NULL on the shared
  // table (Recaller requires it). geo.js owns its own validation here, so we set a
  // placeholder rather than touching Recaller's handleClients. plan/website are the
  // additive columns from the migration; insert degrades gracefully if absent.
  const row = {
    plan: VRANK_PLAN,
    practice_name: practiceName.slice(0, 120),
    owner_name: name || null,
    owner_email: email,
    website: website || null,
    real_line: 'n/a',
    avg_customer_value: 500,
    status: 'trial',
    trial_started_at: new Date().toISOString(),
    magic_token: magicToken,
    password_hash: passwordHash
  };

  let client = null;
  try {
    const { data, error } = await supabase.from('tool_clients').insert(row).select().single();
    if (error) throw error;
    client = data;
  } catch (e) {
    // If the additive columns (plan/website) are not migrated yet, retry without them
    // so signup still works pre-migration (the account is plan-less = recaller default).
    const msg = String(e.message || e);
    if (/column .*(plan|website)/i.test(msg) || /plan|website/i.test(msg)) {
      try {
        const { plan, website: _w, ...fallback } = row;
        const { data, error } = await supabase.from('tool_clients').insert(fallback).select().single();
        if (error) throw error;
        client = data;
      } catch (e2) {
        console.error('signup insert (fallback) failed:', e2.message);
        return res.status(500).json({ error: 'Could not create account.' });
      }
    } else {
      console.error('signup insert failed:', msg);
      return res.status(500).json({ error: 'Could not create account.' });
    }
  }

  // Optionally seed the dashboard with the scorecard result so it shows real data
  // immediately. Best-effort — never fail signup if geo_metrics is absent.
  const score = Number(body.score);
  if (Number.isFinite(score)) {
    try {
      await supabase.from('geo_metrics').insert({
        client_id: String(client.id),
        score: clamp(score, 0, 100),
        created_at: new Date().toISOString()
      });
    } catch (e) { /* geo_metrics may not exist — ignore */ }
  }

  return res.status(200).json({
    ok: true,
    token: issueClientToken(client),
    magic_token: client.magic_token,
    client_id: client.id,
    client: publicClient(client)
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 5) CHECKOUT  —  GET /api/geo?path=checkout&token=<magic_token>
//    V-Rank Dodo subscription. Mirrors tool.js handleCheckout but uses the V-Rank
//    product (DODO_VRANK_PRODUCT_ID, falling back to DODO_PRODUCT_ID) and returns
//    the customer to /dashboard instead of /recaller. Degrades to trial mode when
//    Dodo is not configured. Does NOT touch tool.js's checkout.
// ════════════════════════════════════════════════════════════════════════════
async function handleCheckout(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.DODO_API_KEY) {
    return res.status(200).json({ mode: 'trial', message: 'Free trial active' });
  }
  const token = req.query && req.query.token;
  const clientId = req.query && req.query.client_id;
  if (!token && !clientId) return res.status(400).json({ error: 'token or client_id required' });

  const supabase = getSupabase();
  let client = null;
  try {
    const { data } = await supabase
      .from('tool_clients')
      .select('*')
      .eq(token ? 'magic_token' : 'id', token || clientId)
      .limit(1);
    client = data && data[0];
  } catch (e) { /* fall through to 404 */ }
  if (!client) return res.status(404).json({ error: 'Client not found' });

  try {
    const successUrl = `${PUBLIC_BASE}/dashboard?token=${encodeURIComponent(client.magic_token || '')}&paid=1`;
    const productId = process.env.DODO_VRANK_PRODUCT_ID || process.env.DODO_PRODUCT_ID;
    const r = await fetch('https://live.dodopayments.com/subscriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.DODO_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        product_id: productId,
        quantity: 1,
        payment_link: true,
        return_url: successUrl,
        customer: { email: client.owner_email, name: client.owner_name || client.practice_name },
        billing: { country: 'US', state: '', city: '', street: '', zipcode: '' },
        metadata: { client_id: String(client.id), plan: VRANK_PLAN }
      })
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(200).json({ mode: 'trial', error: `Dodo API ${r.status}` });
    const checkout_url = out.payment_link || out.link || out.url || null;
    if (!checkout_url) return res.status(200).json({ mode: 'trial', error: 'No checkout URL returned' });
    return res.status(200).json({ mode: 'paid', checkout_url });
  } catch (apiErr) {
    console.error('geo/checkout Dodo API error:', apiErr);
    return res.status(200).json({ mode: 'trial', error: apiErr.message });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 6) ADMIN — V-Rank-aware reads + lifecycle for command.html (super-admin).
//    All admin-gated via requireAuth (admin JWT / ADMIN_KEY; open when neither set).
//      GET  ?path=admin-clients          → list all V-Rank accounts + latest metrics
//      GET  ?path=admin-client&client_id → one account + full dashboard metrics
//      POST ?path=admin-action {client_id, action, value?}
//             action ∈ pause|resume|churn|cancel|kick|set_status|set_value
//    NOTE: command.html may instead route pause/churn through the existing
//    /api/tool/admin-action (which already manages V-Rank rows). This handler is
//    provided so the admin can operate entirely against /api/geo if preferred.
// ════════════════════════════════════════════════════════════════════════════
async function handleAdminClients(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;
  const supabase = getSupabase();

  let clients = [];
  try {
    // Prefer filtering to V-Rank accounts. If the plan column is not migrated yet,
    // the .eq filter errors → retry unfiltered so command.html still gets a list.
    let resp = await supabase.from('tool_clients').select('*').eq('plan', VRANK_PLAN).order('created_at', { ascending: false });
    if (resp.error) {
      resp = await supabase.from('tool_clients').select('*').order('created_at', { ascending: false });
    }
    clients = resp.data || [];
  } catch (e) {
    console.error('admin-clients query failed:', e.message);
    return res.status(500).json({ error: 'Could not load clients.' });
  }

  // Attach latest metrics (score + citation count + generated count) per client.
  const out = [];
  for (const c of clients) {
    const m = await latestMetrics(c.id);
    out.push({
      ...publicClient(c),
      score: m && Number.isFinite(m.score) ? clamp(m.score, 0, 100) : null,
      citations: m && Array.isArray(m.citations) ? m.citations.length : null,
      generatedThisMonth: m && Number.isFinite(m.generated_this_month) ? m.generated_this_month : null
    });
  }
  return res.status(200).json({ clients: out });
}

async function handleAdminClient(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;
  const clientId = req.query && req.query.client_id;
  if (!clientId) return res.status(400).json({ error: 'client_id required' });

  const supabase = getSupabase();
  let client = null;
  try {
    const { data } = await supabase.from('tool_clients').select('*').eq('id', clientId).limit(1);
    client = data && data[0];
  } catch (e) { /* fall through */ }
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const stored = await latestMetrics(client.id);
  const { source, ...metrics } = buildDashboard(client.id, stored);
  return res.status(200).json({
    client: publicClient(client),
    metrics,
    meta: { source: source || 'representative', mock: !stored }
  });
}

// Admin lifecycle: cancel / kick / pause / resume a V-Rank customer + set status.
// Mirrors tool.js handleAdminAction's status patches so behaviour is identical.
async function handleAdminActionGeo(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const body = readBody(req);
  const clientId = body.client_id;
  const action = String(body.action || '').trim();
  if (!clientId) return res.status(400).json({ error: 'client_id required' });
  if (!action) return res.status(400).json({ error: 'action required' });

  const supabase = getSupabase();
  let client = null;
  try {
    const { data } = await supabase.from('tool_clients').select('*').eq('id', clientId).limit(1);
    client = data && data[0];
  } catch (e) { /* fall through */ }
  if (!client) return res.status(404).json({ error: 'Client not found' });

  let patch = {};
  switch (action) {
    case 'pause': patch = { status: 'paused' }; break;
    case 'resume': patch = { status: 'active' }; break;
    case 'churn':                       // alias
    case 'cancel':                      // alias
    case 'kick': patch = { status: 'churned' }; break;
    case 'set_value': patch = { avg_customer_value: Number(body.value) }; break;
    case 'set_status': {
      const allowed = ['trial', 'active', 'paused', 'churned', 'past_due'];
      const s = String(body.value || '').trim();
      if (!allowed.includes(s)) return res.status(400).json({ error: 'Invalid status value' });
      patch = { status: s };
      break;
    }
    default: return res.status(400).json({ error: 'Unknown action' });
  }

  try {
    const { data: updated, error } = await supabase
      .from('tool_clients').update(patch).eq('id', client.id).select().single();
    if (error) throw error;
    return res.status(200).json({ ok: true, client: publicClient(updated) });
  } catch (e) {
    console.error('geo/admin-action update failed:', e.message);
    return res.status(500).json({ error: 'Could not update client.' });
  }
}

// POST /api/geo?path=save-metrics — persist a scorecard/generate result into
// geo_metrics for the authenticated customer (self) or, with admin auth, for any
// client_id. Best-effort: if geo_metrics is absent it reports notStored.
async function handleSaveMetrics(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = readBody(req);

  // Identify target client: customer self (Bearer/token), else admin + client_id.
  let clientId = null;
  const customer = await resolveCustomer(req);
  if (customer) clientId = customer.id;
  else {
    if (!requireAuth(req, res)) return;
    clientId = body.client_id;
  }
  if (!clientId) return res.status(400).json({ error: 'Could not identify client.' });

  const metrics = {
    client_id: String(clientId),
    created_at: new Date().toISOString()
  };
  if (Number.isFinite(Number(body.score))) metrics.score = clamp(Number(body.score), 0, 100);
  if (Number.isFinite(Number(body.traffic))) metrics.traffic = Math.round(Number(body.traffic));
  if (Number.isFinite(Number(body.ai_referrals))) metrics.ai_referrals = Math.round(Number(body.ai_referrals));
  if (Number.isFinite(Number(body.indexed_pages))) metrics.indexed_pages = Math.round(Number(body.indexed_pages));
  if (Number.isFinite(Number(body.generated_this_month))) metrics.generated_this_month = Math.round(Number(body.generated_this_month));
  if (Array.isArray(body.rankings)) metrics.rankings = body.rankings;
  if (Array.isArray(body.citations)) metrics.citations = body.citations;

  try {
    const supabase = getSupabase();
    const { error } = await supabase.from('geo_metrics').insert(metrics);
    if (error) throw error;
    return res.status(200).json({ ok: true, client_id: clientId });
  } catch (e) {
    return res.status(200).json({ ok: true, stored: false, note: 'geo_metrics unavailable', client_id: clientId });
  }
}

// ─── Router ──────────────────────────────────────────────────────────────────
// vercel.json: { "src": "/api/geo", "dest": "/api/geo" } so ?path= is preserved.
// ════════════════════════════════════════════════════════════════════════════
// SOURCES — where AI actually pulls from  —  POST /api/geo?path=sources {url,vertical?,location?}
//   AI cites third-party sources (GBP, directories, review sites, Reddit, "best-of"
//   listicles), NOT your own articles. This returns the sources to get INTO to rank
//   FAST (days-weeks, not 90). With PERPLEXITY_API_KEY it LIVE-CONFIRMS which sources
//   are cited today and whether you already appear. Works with zero keys (the map).
// ════════════════════════════════════════════════════════════════════════════
const SOURCE_MAP = {
  restoration: [
    { name: 'Google Business Profile', type: 'gbp', why: 'Feeds Google AI Overviews + Maps directly; the #1 "near me" source.', action: 'Claim + fully complete profile, categories, service area, photos; post weekly; drive fresh reviews.' },
    { name: 'Yelp', type: 'directory', why: 'Heavily cited by ChatGPT + Google for local services.', action: 'Claim + complete the listing; build review volume + recency.' },
    { name: 'Angi / Thumbtack / HomeAdvisor', type: 'directory', why: 'Category directories AI treats as authoritative.', action: 'Get listed + verified on each; collect platform reviews.' },
    { name: 'IICRC locator + RIA', type: 'industry', why: 'Industry-trust directories engines use to vet restoration firms.', action: 'Keep certification current; ensure the listing is complete.' },
    { name: 'Reddit (r/HomeImprovement + city subs)', type: 'reddit', why: 'ChatGPT + Google lean on Reddit for real recommendations.', action: 'Earn genuine mentions by being helpful in relevant threads (not spam).' },
    { name: '"Best restoration company in [city]" listicles', type: 'listicle', why: 'Publishers own the "best-of" pages AI quotes verbatim.', action: 'Outreach to the publishers ranking for your city to get included.' },
  ],
  medspa: [
    { name: 'Google Business Profile', type: 'gbp', why: 'Feeds Google AI Overviews + Maps.', action: 'Claim + optimize; weekly posts; drive reviews.' },
    { name: 'RealSelf', type: 'industry', why: 'The category authority AI cites for aesthetics.', action: 'Build a complete provider profile + reviews + before/afters.' },
    { name: 'Yelp + Google reviews', type: 'directory', why: 'Review volume/recency is a top citation signal.', action: 'Claim listings; run a review-generation flow.' },
    { name: 'Healthgrades / Zocdoc', type: 'industry', why: 'Medical directories engines trust for clinics.', action: 'Complete profiles; enable booking; gather reviews.' },
    { name: 'Reddit (r/SkincareAddiction + city subs)', type: 'reddit', why: 'Heavily retrieved for honest recommendations.', action: 'Earn genuine mentions via helpful expertise.' },
    { name: '"Best med spa in [city]" listicles', type: 'listicle', why: 'AI quotes these "best-of" pages.', action: 'Outreach to the ranking publishers to get included.' },
  ],
  dental: [
    { name: 'Google Business Profile', type: 'gbp', why: 'Feeds Google AI + Maps.', action: 'Claim + optimize; drive reviews.' },
    { name: 'Healthgrades / Zocdoc', type: 'industry', why: 'Medical directories AI trusts.', action: 'Complete profiles + booking + reviews.' },
    { name: 'Yelp', type: 'directory', why: 'Cited for local services.', action: 'Claim + build reviews.' },
    { name: 'Reddit + "best dentist in [city]" listicles', type: 'listicle', why: 'Retrieved for recommendations.', action: 'Earn mentions + outreach to listicle publishers.' },
  ],
  staffing: [
    { name: 'Google Business Profile', type: 'gbp', why: 'Local visibility base.', action: 'Claim + optimize.' },
    { name: 'Clutch', type: 'industry', why: 'B2B services directory AI cites.', action: 'Build a profile + verified client reviews.' },
    { name: 'LinkedIn + Glassdoor', type: 'directory', why: 'Trust + presence signals for firms.', action: 'Complete company pages; gather reviews.' },
    { name: 'Reddit + "best staffing agency in [city]" listicles', type: 'listicle', why: 'Retrieved for recommendations.', action: 'Earn mentions + publisher outreach.' },
  ],
  home: [
    { name: 'Google Business Profile', type: 'gbp', why: 'Feeds Google AI + Maps.', action: 'Claim + optimize; drive reviews.' },
    { name: 'Angi / Thumbtack / HomeAdvisor', type: 'directory', why: 'Category directories AI trusts.', action: 'Get listed + verified; collect reviews.' },
    { name: 'Yelp + Nextdoor', type: 'directory', why: 'Local recommendation sources.', action: 'Claim listings; earn neighborhood recs.' },
    { name: 'Reddit + "best [trade] in [city]" listicles', type: 'listicle', why: 'Retrieved for recommendations.', action: 'Earn mentions + publisher outreach.' },
  ],
  legal: [
    { name: 'Google Business Profile', type: 'gbp', why: 'Feeds Google AI + Maps.', action: 'Claim + optimize; drive reviews.' },
    { name: 'Avvo / Justia / FindLaw', type: 'industry', why: 'Legal directories AI trusts.', action: 'Complete profiles + reviews.' },
    { name: 'Yelp + Google reviews', type: 'directory', why: 'Review signals.', action: 'Claim + build reviews.' },
    { name: 'Reddit + "best [practice] lawyer in [city]" listicles', type: 'listicle', why: 'Retrieved for recommendations.', action: 'Earn mentions + publisher outreach.' },
  ],
  saas: [
    { name: 'G2 + Capterra', type: 'industry', why: 'The software directories AI cites for tool recommendations.', action: 'Build complete profiles + drive verified reviews.' },
    { name: 'Reddit (r/SEO, r/marketing, r/SaaS)', type: 'reddit', why: 'ChatGPT + Google heavily cite Reddit for tools.', action: 'Earn genuine mentions by answering relevant threads.' },
    { name: 'Product Hunt', type: 'directory', why: 'Launch + discovery source engines index.', action: 'Launch + maintain the profile.' },
    { name: '"Best [category] tools" listicles', type: 'listicle', why: 'AI quotes these roundups.', action: 'Outreach to publishers ranking for your category.' },
    { name: 'Original research / data report', type: 'content', why: 'Becomes a citable primary source.', action: 'Publish proprietary data others (and AI) cite.' },
  ],
  generic: [
    { name: 'Google Business Profile', type: 'gbp', why: 'Feeds Google AI Overviews + Maps.', action: 'Claim + fully optimize; drive reviews.' },
    { name: 'Yelp + Trustpilot', type: 'directory', why: 'Review sources AI cites.', action: 'Claim listings; build review volume + recency.' },
    { name: 'Reddit', type: 'reddit', why: 'Heavily retrieved for recommendations.', action: 'Earn genuine mentions in relevant subreddits.' },
    { name: 'Your top industry directory', type: 'industry', why: 'Category directories AI trusts.', action: 'Get listed + verified.' },
    { name: '"Best [service] in [city]" listicles', type: 'listicle', why: 'AI quotes "best-of" pages.', action: 'Outreach to ranking publishers to get included.' },
  ],
};
function sourcesForVertical(v) {
  const key = ({ 'restoration': 'restoration', 'med-spa': 'medspa', 'medspa': 'medspa', 'dental/med-spa': 'medspa', 'dental': 'dental', 'staffing/recruitment': 'staffing', 'staffing': 'staffing', 'roofing': 'home', 'home services': 'home', 'legal': 'legal', 'saas': 'saas', 'technology': 'saas' })[String(v || '').toLowerCase()];
  return SOURCE_MAP[key] || SOURCE_MAP.generic;
}
function matchSource(domain, target) {
  const n = (target.name || '').toLowerCase(); const d = String(domain).toLowerCase();
  const pairs = [['google business', 'google.'], ['yelp', 'yelp'], ['reddit', 'reddit'], ['realself', 'realself'], ['healthgrades', 'healthgrades'], ['zocdoc', 'zocdoc'], ['angi', 'angi'], ['angi', 'homeadvisor'], ['thumbtack', 'thumbtack'], ['g2', 'g2.com'], ['capterra', 'capterra'], ['clutch', 'clutch'], ['avvo', 'avvo'], ['justia', 'justia'], ['findlaw', 'findlaw'], ['bbb', 'bbb.org'], ['product hunt', 'producthunt'], ['nextdoor', 'nextdoor'], ['trustpilot', 'trustpilot'], ['glassdoor', 'glassdoor'], ['linkedin', 'linkedin']];
  return pairs.some(([nk, dk]) => n.includes(nk) && d.includes(dk));
}
// Live citation check via Perplexity (its API returns the real cited URLs). Best-effort.
async function perplexityCitations(prompts, host) {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) return null;
  const domains = {}; let present = false; const promptResults = [];
  for (const p of prompts.slice(0, 3)) {
    try {
      const r = await fetchWithTimeout('https://api.perplexity.ai/chat/completions', LLM_TIMEOUT_MS, {
        method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'sonar', messages: [{ role: 'user', content: p }], max_tokens: 600 }),
      });
      if (!r.ok) continue;
      const data = await r.json();
      const cites = data.citations || (Array.isArray(data.search_results) ? data.search_results.map((s) => s.url) : []) || [];
      const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
      const found = [];
      for (const url of cites) { try { const h = new URL(url).hostname.replace(/^www\./, ''); domains[h] = (domains[h] || 0) + 1; found.push(h); } catch (e) {} }
      const hostBare = String(host || '').replace(/^www\./, '');
      const brand = hostBare.split('.')[0];
      const iAmCited = found.some((h) => h.includes(hostBare)) || (brand && brand.length > 2 && text.toLowerCase().includes(brand));
      if (iAmCited) present = true;
      promptResults.push({ prompt: p, cited: found.slice(0, 8), youCited: iAmCited });
    } catch (e) { /* skip */ }
  }
  const citedSources = Object.entries(domains).sort((a, b) => b[1] - a[1]).map(([domain, count]) => ({ domain, count }));
  return { engine: 'perplexity', present, citedSources, prompts: promptResults };
}
async function handleSources(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (rateLimited(req)) return res.status(429).json({ error: 'Too many requests, slow down.' });
  const body = readBody(req);
  const u = safeUrl(body.url);
  if (!u) return res.status(400).json({ error: 'A valid http(s) url is required.' });
  const vertical = body.vertical || inferVertical(u.hostname);
  const targets = sourcesForVertical(vertical);
  const loc = body.location ? ` in ${body.location}` : ' near me';
  const prompts = [
    `Who are the best ${vertical} companies${loc}? List specific businesses.`,
    `I need a ${vertical} provider${loc} — who do you recommend and why?`,
    `Top rated ${vertical} services${loc}`,
  ];
  let live = null;
  try { live = await perplexityCitations(prompts, u.hostname); } catch (e) { /* best-effort */ }
  const citedDomains = (live && live.citedSources || []).map((s) => s.domain);
  const enriched = targets.map((t) => ({ ...t, confirmedCited: citedDomains.some((d) => matchSource(d, t)) }));
  return res.status(200).json({
    host: u.hostname, vertical,
    live: live ? { engine: live.engine, youArePresent: live.present, citedSources: live.citedSources, prompts: live.prompts } : null,
    liveAvailable: !!live,
    targets: enriched,
    note: live
      ? (live.present ? 'You already appear in some AI answers — now expand coverage across the sources below.' : 'You are not appearing in AI answers yet. Getting into the sources below is how you start being cited within weeks, not months.')
      : 'These are the sources AI pulls from for your category. Get into them to rank fast. (Connect a Perplexity key to live-confirm exactly who is cited today.)',
  });
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  res.setHeader('Content-Type', 'application/json');

  const path = String((req.query && req.query.path) || '').replace(/^\/+/, '');
  try {
    if (path === 'scorecard') return await handleScorecard(req, res);
    if (path === 'sources') return await handleSources(req, res);
    if (path === 'generate') return await handleGenerate(req, res);
    if (path === 'dashboard') return await handleDashboard(req, res);
    // ── V-Rank account / billing / admin (reuse Recaller account system) ──
    if (path === 'signup') return await handleSignup(req, res);
    if (path === 'checkout') return await handleCheckout(req, res);
    if (path === 'save-metrics') return await handleSaveMetrics(req, res);
    if (path === 'admin-clients') return await handleAdminClients(req, res);
    if (path === 'admin-client') return await handleAdminClient(req, res);
    if (path === 'admin-action') return await handleAdminActionGeo(req, res);
    return res.status(404).json({ error: 'Route not found. Use ?path=scorecard|generate|dashboard|signup|checkout|save-metrics|admin-clients|admin-client|admin-action' });
  } catch (err) {
    console.error('geo router error:', err);
    if (!res.headersSent) return res.status(500).json({ error: 'Internal server error' });
  }
};
