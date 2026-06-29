// Vyrrah GEO — AI SEO + Generative Engine Optimization backend.
// A cheaper FlyRank.ai clone. Three contract endpoints, all routed via ?path=:
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

const { cors, requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');

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
    const gen = { temperature: 0.5, maxOutputTokens: maxTokens, responseMimeType: 'application/json' };
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
        temperature: 0.5,
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
function heuristicBreakdown(sig) {
  let seo = 30;
  if (sig.titleLen >= 15 && sig.titleLen <= 65) seo += 20; else if (sig.titleLen) seo += 8;
  if (sig.metaDescLen >= 50 && sig.metaDescLen <= 165) seo += 18; else if (sig.metaDescLen) seo += 6;
  if (sig.h1Count === 1) seo += 14; else if (sig.h1Count > 1) seo += 6;
  if (sig.hasCanonical) seo += 8;
  if (sig.hasViewport) seo += 10;

  let schema = sig.jsonLdCount ? 45 : 8;
  if (sig.schemaTypes.some((t) => /Organization|LocalBusiness/i.test(t))) schema += 22;
  if (sig.schemaTypes.some((t) => /FAQ/i.test(t))) schema += 18;
  if (sig.schemaTypes.some((t) => /Review|AggregateRating|Service|Product/i.test(t))) schema += 15;

  let aeo = 18; // answer-engine readiness
  if (sig.hasFaq) aeo += 22;
  if (sig.schemaTypes.some((t) => /FAQ|HowTo|QAPage/i.test(t))) aeo += 20;
  if (sig.metaDescLen >= 50) aeo += 10;
  if (sig.textLen > 1800) aeo += 18; else if (sig.textLen > 600) aeo += 8;

  let content = 20;
  if (sig.textLen > 4000) content += 45; else if (sig.textLen > 1800) content += 32;
  else if (sig.textLen > 600) content += 18;
  if (sig.hasOpenGraph) content += 8;
  if (sig.h1Count >= 1) content += 10;

  let reviews = sig.hasReviews ? 55 : 12;
  if (sig.schemaTypes.some((t) => /AggregateRating|Review/i.test(t))) reviews += 25;

  return {
    seo: clamp(seo, 0, 100),
    aeo: clamp(aeo, 0, 100),
    schema: clamp(schema, 0, 100),
    content: clamp(content, 0, 100),
    reviews: clamp(reviews, 0, 100)
  };
}

function overallFromBreakdown(b) {
  // Weighted toward AEO/schema since this is a GEO product.
  return clamp(b.seo * 0.22 + b.aeo * 0.26 + b.schema * 0.22 + b.content * 0.18 + b.reviews * 0.12, 0, 100);
}

// Per-engine AI visibility estimate derived from breakdown (heuristic baseline).
function heuristicAiVisibility(b) {
  return {
    chatgpt: clamp(b.aeo * 0.5 + b.content * 0.3 + b.schema * 0.2, 0, 100),
    perplexity: clamp(b.aeo * 0.4 + b.schema * 0.35 + b.reviews * 0.25, 0, 100),
    google: clamp(b.seo * 0.5 + b.schema * 0.3 + b.content * 0.2, 0, 100)
  };
}

// Ranked, deterministic gaps from signals — used as fallback AND merged with LLM.
function heuristicGaps(sig, vertical) {
  const gaps = [];
  if (!sig.jsonLdCount || !sig.schemaTypes.some((t) => /Organization|LocalBusiness/i.test(t))) {
    gaps.push({ title: 'No LocalBusiness / Organization schema', impact: 'AI engines and Google cannot reliably identify who you are, where you serve, or your contact details, so you are skipped in AI answers.', fix: 'Add JSON-LD LocalBusiness (or Organization) schema with name, address, phone, hours and serviceArea. The Engine can generate this for you in one click.' });
  }
  if (!sig.hasFaq && !sig.schemaTypes.some((t) => /FAQ/i.test(t))) {
    gaps.push({ title: 'No FAQ content or FAQPage schema', impact: 'ChatGPT, Perplexity and Google AI pull answers from Q&A-shaped content. Without it you rarely get cited.', fix: 'Publish a 6-10 question FAQ written in natural question form and mark it up with FAQPage JSON-LD.' });
  }
  if (sig.titleLen === 0 || sig.titleLen > 65) {
    gaps.push({ title: sig.titleLen ? 'Title tag too long' : 'Missing title tag', impact: 'Weak or missing titles cut click-through and confuse AI crawlers about your core service.', fix: `Write a 50-60 char title leading with your primary ${vertical} service and city.` });
  }
  if (sig.metaDescLen === 0 || sig.metaDescLen > 165) {
    gaps.push({ title: sig.metaDescLen ? 'Meta description too long' : 'Missing meta description', impact: 'Search and AI snippets fall back to random page text, lowering relevance.', fix: 'Add a 140-160 char meta description naming the service, location and a reason to choose you.' });
  }
  if (sig.h1Count !== 1) {
    gaps.push({ title: sig.h1Count === 0 ? 'No H1 heading' : 'Multiple H1 headings', impact: 'Unclear page hierarchy makes it harder for AI to extract the main topic.', fix: 'Use exactly one descriptive H1 that states the service and city.' });
  }
  if (sig.textLen < 1800) {
    gaps.push({ title: 'Thin page content', impact: 'AI engines favour pages with depth they can quote. Thin pages get passed over for cited sources.', fix: 'Expand to 800+ words of genuinely useful, specific content. The Engine can draft foundational pages from scratch.' });
  }
  if (!sig.hasReviews) {
    gaps.push({ title: 'No visible reviews or rating signals', impact: 'Trust signals heavily influence whether AI recommends you over competitors.', fix: 'Surface reviews on-page and add AggregateRating schema. Start gathering reviews from new customers via SMS, then seed reputation content.' });
  }
  if (!sig.hasViewport) {
    gaps.push({ title: 'No mobile viewport tag', impact: 'Mobile-unfriendly pages are demoted in search and AI sourcing.', fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.' });
  }
  return gaps;
}

async function handleScorecard(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (rateLimited(req)) return res.status(429).json({ error: 'Too many requests, slow down.' });

  const body = readBody(req);
  const u = safeUrl(body.url);
  if (!u) return res.status(400).json({ error: 'A valid http(s) url is required.' });

  // 1) Fetch the page. A fetch failure is NOT fatal — we treat it as a cold-start
  //    site with no data and still return a useful, generative-path scorecard.
  let html = '', fetchOk = false;
  try {
    const r = await fetchWithTimeout(u.href, FETCH_TIMEOUT_MS, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 VyrrahGEO/1.0',
        'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    const ctype = r.headers.get('content-type') || '';
    if (r.ok && ctype.includes('html')) { html = await r.text(); fetchOk = html.length >= 200; }
  } catch (e) { /* treat as cold start below */ }

  const sig = inspectHtml(html);
  const vertical = inferVertical((sig.title + ' ' + sig.metaDesc) || u.hostname);
  const baseBreakdown = heuristicBreakdown(sig);
  const baseGaps = heuristicGaps(sig, vertical);
  const coldStart = !fetchOk || sig.textLen < 400;

  // 2) If an LLM is available, let it assess AEO/GEO readiness and rewrite the
  //    score, gaps, summary and per-engine estimates — anchored to real signals.
  let out = null;
  if (llmAvailable()) {
    const system = [
      'You are a Generative Engine Optimization (GEO) and AI-search visibility auditor for local and DTC businesses.',
      'You assess how likely a site is to be CITED by ChatGPT, Perplexity, Claude and Google AI Overviews, plus classic SEO.',
      'You are given deterministic on-page signals extracted from the HTML. Judge AEO/GEO readiness from them.',
      'Voice: confident, plain, second person ("your site"). Short sentences. No em dashes or en dashes. Never use: unlock, elevate, supercharge, seamless, leverage, transform, journey, delve, empower, revolutionize.',
      'Return JSON with EXACTLY these keys:',
      'score (int 0-100 overall AI-visibility score),',
      'breakdown {seo,aeo,schema,content,reviews} (each int 0-100),',
      'aiVisibility {chatgpt,perplexity,google} (each int 0-100, your estimate of current citation likelihood per engine),',
      'gaps (array of 3-6 objects {title,impact,fix}, ranked most-impactful first, specific to the signals),',
      'summary (2-3 sentences, the headline verdict and the single biggest opportunity).',
      coldStart ? 'IMPORTANT COLD START: this site has little or no fetchable content. Score honestly low, and make the summary and gaps about GENERATING foundational pages, FAQ and schema from scratch, plus starting to gather reviews from new customers going forward.' : ''
    ].join('\n');
    const user = JSON.stringify({
      host: u.hostname, vertical, coldStart,
      signals: sig,
      heuristic_breakdown: baseBreakdown,
      heuristic_gaps: baseGaps.slice(0, 6)
    });
    const geminiSchema = {
      type: 'OBJECT',
      properties: {
        score: { type: 'INTEGER' },
        breakdown: { type: 'OBJECT', properties: { seo: { type: 'INTEGER' }, aeo: { type: 'INTEGER' }, schema: { type: 'INTEGER' }, content: { type: 'INTEGER' }, reviews: { type: 'INTEGER' } }, required: ['seo', 'aeo', 'schema', 'content', 'reviews'] },
        aiVisibility: { type: 'OBJECT', properties: { chatgpt: { type: 'INTEGER' }, perplexity: { type: 'INTEGER' }, google: { type: 'INTEGER' } }, required: ['chatgpt', 'perplexity', 'google'] },
        gaps: { type: 'ARRAY', items: { type: 'OBJECT', properties: { title: { type: 'STRING' }, impact: { type: 'STRING' }, fix: { type: 'STRING' } }, required: ['title', 'impact', 'fix'] } },
        summary: { type: 'STRING' }
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
  const aiVisibility = (out && out.aiVisibility && ['chatgpt', 'perplexity', 'google'].every((k) => Number.isFinite(out.aiVisibility[k])))
    ? { chatgpt: clamp(out.aiVisibility.chatgpt, 0, 100), perplexity: clamp(out.aiVisibility.perplexity, 0, 100), google: clamp(out.aiVisibility.google, 0, 100) }
    : heuristicAiVisibility(breakdown);
  let gaps = (out && Array.isArray(out.gaps) && out.gaps.length)
    ? out.gaps.filter((g) => g && g.title && g.fix).map((g) => ({ title: String(g.title).slice(0, 120), impact: String(g.impact || '').slice(0, 240), fix: String(g.fix || '').slice(0, 280) }))
    : baseGaps;
  if (!gaps.length) gaps = baseGaps;
  gaps = gaps.slice(0, 6);
  const summary = (out && out.summary) ? String(out.summary).slice(0, 600)
    : (coldStart
        ? `We could not read much content at ${u.hostname}, so you are close to invisible in AI search today. The fast path is to generate foundational pages, an FAQ and LocalBusiness schema from scratch, then start gathering reviews from new customers. Your AI-visibility score is ${score}/100.`
        : `${u.hostname} scores ${score}/100 for AI visibility. The biggest lever is ${(gaps[0] && gaps[0].title) || 'adding structured data and answer-shaped content'} so engines like ChatGPT and Perplexity can cite you.`);

  return res.status(200).json({
    score, breakdown, gaps, aiVisibility, summary,
    meta: { url: u.href, host: u.hostname, vertical, coldStart, fetched: fetchOk, mock: !out, signals: sig }
  });
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
      description: `Foundational ${vertical} landing page generated by Vyrrah GEO.`,
      url, areaServed: 'Local service area',
      aggregateRating: { '@type': 'AggregateRating', ratingValue: '5.0', reviewCount: '1', description: 'Reputation gathering in progress for this new business.' }
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

  return res.status(200).json({
    title, content, schema,
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
function representativeDashboard(clientId) {
  const rnd = seededRandom(String(clientId || 'demo'));
  const score = clamp(58 + rnd() * 34, 0, 100);
  const traffic = Math.round(900 + rnd() * 4200);
  const verticals = ['restoration', 'dental', 'staffing', 'med-spa'];
  const keywords = {
    restoration: ['water damage restoration near me', 'emergency flood cleanup', 'mold remediation cost', '24 hour water removal'],
    dental: ['dentist near me', 'teeth whitening cost', 'emergency dentist', 'invisalign price'],
    staffing: ['staffing agency near me', 'temp to hire jobs', 'warehouse staffing', 'how to find workers fast'],
    'med-spa': ['botox near me', 'lip filler cost', 'med spa near me', 'best facial treatments']
  };
  const v = verticals[Math.floor(rnd() * verticals.length)];
  const kw = keywords[v] || keywords.restoration;
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

async function handleDashboard(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  // Admin-gated when ADMIN_KEY/JWT is configured; open otherwise (same posture as tool.js admin reads).
  if (!requireAuth(req, res)) return; // sends 401 itself when locked down
  const clientId = req.query.client_id || 'demo';

  // Best-effort: pull the latest stored metrics row if a geo_metrics table exists.
  let stored = null;
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('geo_metrics')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(1);
    if (!error && data && data[0]) stored = data[0];
  } catch (e) { /* table may not exist — fall back to representative data */ }

  const base = representativeDashboard(clientId);
  if (stored) {
    // Map known columns over the representative base; keep arrays from JSON columns if present.
    const merged = {
      score: Number.isFinite(stored.score) ? clamp(stored.score, 0, 100) : base.score,
      traffic: Number.isFinite(stored.traffic) ? stored.traffic : base.traffic,
      aiReferrals: Number.isFinite(stored.ai_referrals) ? stored.ai_referrals : base.aiReferrals,
      indexedPages: Number.isFinite(stored.indexed_pages) ? stored.indexed_pages : base.indexedPages,
      rankings: Array.isArray(stored.rankings) ? stored.rankings : base.rankings,
      citations: Array.isArray(stored.citations) ? stored.citations : base.citations,
      generatedThisMonth: Number.isFinite(stored.generated_this_month) ? stored.generated_this_month : base.generatedThisMonth
    };
    return res.status(200).json({ ...merged, meta: { client_id: clientId, source: 'supabase' } });
  }

  return res.status(200).json({ ...base, meta: { client_id: clientId, source: 'representative', mock: true } });
}

// ─── Router ──────────────────────────────────────────────────────────────────
// vercel.json: { "src": "/api/geo", "dest": "/api/geo" } so ?path= is preserved.
module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  res.setHeader('Content-Type', 'application/json');

  const path = String((req.query && req.query.path) || '').replace(/^\/+/, '');
  try {
    if (path === 'scorecard') return await handleScorecard(req, res);
    if (path === 'generate') return await handleGenerate(req, res);
    if (path === 'dashboard') return await handleDashboard(req, res);
    return res.status(404).json({ error: 'Route not found. Use ?path=scorecard|generate|dashboard' });
  } catch (err) {
    console.error('geo router error:', err);
    if (!res.headersSent) return res.status(500).json({ error: 'Internal server error' });
  }
};
