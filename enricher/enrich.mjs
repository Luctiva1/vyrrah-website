#!/usr/bin/env node
/**
 * Vyrrah lead enricher — bulk, cheap, no per-lead AI.
 * CSV in (Apollo/Maps export) -> concurrent fetch + signal extract + V-Rank score
 * + templated opener -> enriched CSV + dial-list + email-list (sorted by score).
 *
 * Usage:
 *   node enricher/enrich.mjs <input.csv> [--limit N] [--out DIR] [--concurrency 20]
 *                                        [--source LABEL] [--no-persist]
 * Optional env:
 *   PAGESPEED_API_KEY   (real mobile speed score; free quota — added to sweet-spot leads)
 *   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET) — when both are set,
 *     results are upserted into the enriched_leads table (on conflict host, so a lead's
 *     outreach status is never reset by a re-run). --no-persist forces CSV-only.
 *
 * Design: fully deterministic scoring (mirrors the V-Rank heuristic) so it runs at
 * 50K for ~$0. Per-domain cache (.cache.json) makes re-runs + daily incrementals free
 * and lets a big run resume. Phase-2 signal hooks (Places/Ad-Library) are stubbed below.
 * TODO(shared-core): replace the local scoring with api/_lib/vrank-core so batch + the
 * live scorecard endpoint can never drift.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleOpener } from './templates.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const INPUT = args.find(a => !a.startsWith('--'));
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const LIMIT = parseInt(opt('limit', '0'), 10) || 0;
const CONC = parseInt(opt('concurrency', '20'), 10);
const OUTDIR = opt('out', join(HERE, 'out'));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36';
if (!INPUT) { console.error('usage: node enricher/enrich.mjs <input.csv> [--limit N]'); process.exit(1); }
if (!existsSync(OUTDIR)) mkdirSync(OUTDIR, { recursive: true });

// ---- tiny RFC-4180-ish CSV parser/writer (no deps) ----
function parseCSV(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift();
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}
const csvCell = v => { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const toCSV = (rows, cols) => [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n') + '\n';

// ---- column auto-detect (works across Apollo / Maps / custom exports) ----
function pick(row, ...cands) {
  const keys = Object.keys(row);
  for (const cand of cands) { const k = keys.find(k => k.toLowerCase().replace(/[^a-z]/g, '') === cand.replace(/[^a-z]/g, '')); if (k && row[k]) return row[k]; }
  for (const cand of cands) { const k = keys.find(k => k.toLowerCase().includes(cand.toLowerCase())); if (k && row[k]) return row[k]; }
  return '';
}

// ---- fetch + signal extraction (deterministic) ----
async function fetchSite(url) {
  if (!/^https?:/i.test(url)) url = 'https://' + url;
  const t = Date.now();
  try {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow', signal: ctrl.signal });
    clearTimeout(to);
    const html = (await r.text()).slice(0, 400000);
    return { html, ms: Date.now() - t, status: r.status };
  } catch (e) { return { html: '', ms: Date.now() - t, status: 0, err: e.name }; }
}
function signals(html) {
  const L = html.toLowerCase();
  const types = [...html.matchAll(/"@type"\s*:\s*"([^"]+)"/g)].map(m => m[1]);
  return {
    metaPixel: /fbq\(|connect\.facebook\.net\/[^"]*fbevents/.test(html),
    googleAds: /AW-[0-9]{9,}|googleadservices|gtag_report_conversion/.test(html),
    ga: /gtag\(|G-[A-Z0-9]{9,}|google-analytics/.test(html),
    schema: types.length > 0,
    localbiz: types.some(t => /LocalBusiness|Organization/i.test(t)),
    hasForm: /<form|mailto:/i.test(html),
    hasChat: /tawk\.to|intercom|tidio|livechat|podium|drift|hubspot/.test(L),
    hasTel: /tel:/i.test(html),
    reviews: /google review|trustpilot|productreview|aggregaterating|[0-9]\.[0-9] stars?|based on [0-9]+ review/.test(L),
    textLen: html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').length,
  };
}
// Deterministic V-Rank-style score (0-100). TODO: swap for shared vrank-core.
function scoreOf(s, blocked) {
  if (blocked) return null;
  let x = 45;
  x += s.localbiz ? 18 : (s.schema ? 8 : -12);
  x += s.textLen > 6000 ? 12 : (s.textLen > 2000 ? 6 : -8);
  x += s.reviews ? 6 : -6;
  x += (s.hasForm || s.hasChat) ? 5 : -5;
  return Math.max(18, Math.min(85, Math.round(x)));
}
const COMP = { restoration: ['SERVPRO', 'ServiceMaster Restore', 'PuroClean'], dental: ['Aspen Dental'], 'med-spa': ['Ideal Image', 'LaserAway'], roofing: ['Erie Home'], legal: ['Morgan & Morgan'], default: ['your top competitor'] };
function inferVertical(t) {
  t = (t || '').toLowerCase();
  if (/restoration|water damage|fire|flood|mold|mitigation/.test(t)) return 'restoration';
  if (/dental|dentist|orthodon/.test(t)) return 'dental';
  if (/med ?spa|medspa|aesthetic|botox/.test(t)) return 'med-spa';
  if (/roof|storm|shingle/.test(t)) return 'roofing';
  if (/attorney|lawyer|law firm|legal/.test(t)) return 'legal';
  return 'default';
}

// ---- phase-2 (cheap APIs, sweet-spot only) — stubs with real hooks ----
async function pageSpeed(url) {
  const key = process.env.PAGESPEED_API_KEY; if (!key) return null;
  try {
    const u = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?strategy=mobile&url=${encodeURIComponent(url)}&key=${key}`;
    const r = await fetch(u); if (!r.ok) return null; const d = await r.json();
    return Math.round((d.lighthouseResult?.categories?.performance?.score ?? 0) * 100);
  } catch { return null; }
}
// TODO phase-2: placesReviews(name,city) via Google Places; metaAdLibrary(domain) for live ad count/creatives.

// ---- optional Supabase persistence (upsert on host; never resets status) ----
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET || process.env.SUPABASE_KEY;
const PERSIST = !!(SB_URL && SB_KEY) && !args.includes('--no-persist');
function dbRow(o, source) {
  let host = '';
  try { host = new URL(/^https?:/i.test(o.Website) ? o.Website : 'https://' + o.Website).hostname.replace(/^www\./, ''); } catch { return null; }
  if (!host) return null;
  return {
    host, company: o.Company || null, contact: o.Contact || null, title: o.Title || null,
    phone: o.Phone || null, email: o.Email || null, city: o.City || null, state: o.State || null,
    website: o.Website || null, vertical: o.Vertical || null,
    score: typeof o.Score === 'number' ? o.Score : null, tier: o.Tier || null,
    runs_ads: o.RunsAds === 'Y',
    signals: { schema: o.Schema === 'Y', localbiz: o.LocalBiz === 'Y', hasCapture: o.LeadCapture === 'Y', reviews: o.Reviews === 'Y', loadMs: o.LoadMs === '' ? null : Number(o.LoadMs), pageSpeed: o.PageSpeed === '' ? null : Number(o.PageSpeed) },
    call_opener: o.CallOpener || null, email_line: o.EmailLine || null, source_list: source || null,
  };
}
async function persist(rows, source) {
  const seen = new Set(); const batch = [];
  for (const o of rows) { const r = dbRow(o, source); if (!r || seen.has(r.host)) continue; seen.add(r.host); batch.push(r); }
  let saved = 0;
  for (let i = 0; i < batch.length; i += 500) {
    const chunk = batch.slice(i, i + 500);
    try {
      const res = await fetch(`${SB_URL}/rest/v1/enriched_leads?on_conflict=host`, {
        method: 'POST',
        headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(chunk),
      });
      if (res.ok) saved += chunk.length;
      else console.error('  persist chunk failed:', res.status, (await res.text()).slice(0, 200));
    } catch (e) { console.error('  persist chunk error:', e.message); }
  }
  return saved;
}

// ---- cache (resumable) ----
const CACHE_PATH = join(HERE, '.cache.json');
const cache = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf8')) : {};
let cacheDirty = 0;

async function enrichOne(row) {
  const website = pick(row, 'companywebsite', 'website', 'domain', 'url', 'companydomain');
  const company = pick(row, 'companyname', 'company', 'organization', 'name') || 'this company';
  const host = website.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  const key = host || company;
  let sig, ms, blocked, unreachable;
  if (cache[key]) { ({ sig, ms, blocked, unreachable } = cache[key]); }
  else {
    const { html, ms: m, status, err } = await fetchSite(website || company);
    const noContent = !!err || html.length < 200;
    // blocked = a LIVE server refusing a readable response (a real, assertable fact).
    // unreachable = DNS/connection failure or empty page — NOT crawler-blocking, so no
    // "your site blocks crawlers" claim (would be fabricated). Mirrors api/geo.js.
    blocked = noContent && [401, 403, 406, 429, 503].includes(status);
    unreachable = noContent && !blocked;
    sig = noContent ? {} : signals(html); ms = m;
    cache[key] = { sig, ms, blocked, unreachable }; if (++cacheDirty % 25 === 0) writeFileSync(CACHE_PATH, JSON.stringify(cache));
  }
  const vertical = inferVertical([company, pick(row, 'industry', 'keywords', 'companyseodescription'), website].join(' '));
  const score = scoreOf(sig, blocked || unreachable);
  const tech = (pick(row, 'companytechnologies') || '').toLowerCase();
  const runsAds = !!(sig.metaPixel || sig.googleAds) || /google ads|facebook|meta pixel|adroll|taboola/.test(tech);
  const f = {
    first: pick(row, 'firstname', 'first') || 'there',
    company, city: pick(row, 'city', 'companycity'), vertical,
    score, blocked, runsAds, localbiz: !!sig.localbiz, schema: !!sig.schema,
    hasForm: !!sig.hasForm, hasChat: !!sig.hasChat, reviews: !!sig.reviews,
    loadS: (blocked || unreachable) ? null : +(ms / 1000).toFixed(1),
    competitor: (COMP[vertical] || COMP.default)[0],
    reviewCount: null, compReviews: null, adCount: 0, // filled by phase-2
  };
  // phase-2 on the sweet-spot band only (cost control)
  if (!blocked && score != null && score >= 30 && score <= 70) {
    const ps = await pageSpeed(website); if (ps != null) { f.loadS = null; f.pageSpeed = ps; }
  }
  return {
    Company: company, Contact: `${pick(row, 'firstname', 'first')} ${pick(row, 'lastname', 'last')}`.trim(),
    Title: pick(row, 'title'), Phone: pick(row, 'mobilenumber', 'companyphonenumber', 'phone'),
    Email: pick(row, 'email'), City: f.city, State: pick(row, 'state', 'companystate'),
    Website: website, Vertical: vertical, Score: score == null ? '' : score,
    RunsAds: runsAds ? 'Y' : '', Schema: sig.schema ? 'Y' : '', LocalBiz: sig.localbiz ? 'Y' : '',
    LeadCapture: (sig.hasForm || sig.hasChat) ? 'Y' : '', Reviews: sig.reviews ? 'Y' : '',
    LoadMs: (blocked || unreachable) ? '' : ms, PageSpeed: f.pageSpeed ?? '',
    Tier: blocked ? 'BLOCKED' : unreachable ? 'UNREACHABLE' : (score >= 72 ? 'SKIP' : score < 28 ? 'WEAK' : 'SWEET-SPOT'),
    CallOpener: assembleOpener(f, 'call'), EmailLine: assembleOpener(f, 'email'),
  };
}

// ---- concurrency pool ----
async function run() {
  const raw = parseCSV(readFileSync(INPUT, 'utf8'));
  let leads = raw.filter(r => pick(r, 'companywebsite', 'website', 'domain', 'url', 'companydomain'));
  if (LIMIT) leads = leads.slice(0, LIMIT);
  console.log(`enriching ${leads.length} leads @ concurrency ${CONC}${process.env.PAGESPEED_API_KEY ? ' (+PageSpeed)' : ''}...`);
  const out = new Array(leads.length); let done = 0, next = 0;
  async function worker() {
    while (next < leads.length) {
      const i = next++;
      try { out[i] = await enrichOne(leads[i]); } catch (e) { out[i] = { Company: leads[i]['Company Name'] || '?', Score: 'error', CallOpener: e.message }; }
      if (++done % 25 === 0) process.stdout.write(`  ${done}/${leads.length}\r`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, leads.length) }, worker));
  writeFileSync(CACHE_PATH, JSON.stringify(cache));
  const cols = Object.keys(out[0]);
  const sv = x => typeof x.Score === 'number' ? x.Score : -1;
  const bySalience = [...out].sort((a, b) => sv(b) - sv(a));
  const sweet = out.filter(o => o.Tier === 'SWEET-SPOT');
  const dial = sweet.filter(o => o.Phone).sort((a, b) => a.Score - b.Score);
  const email = sweet.filter(o => o.Email).sort((a, b) => a.Score - b.Score);
  const stamp = basename(INPUT).replace(/\.csv$/i, '');
  writeFileSync(join(OUTDIR, `${stamp}_ENRICHED.csv`), toCSV(bySalience, cols));
  writeFileSync(join(OUTDIR, `${stamp}_DIAL.csv`), toCSV(dial, cols));
  writeFileSync(join(OUTDIR, `${stamp}_EMAIL.csv`), toCSV(email, cols));
  const scored = out.filter(o => typeof o.Score === 'number');
  console.log(`\nDONE. reachable ${scored.length}/${out.length} | run ads ${out.filter(o => o.RunsAds).length} | sweet-spot ${sweet.length} | avg ${Math.round(scored.reduce((s, o) => s + o.Score, 0) / (scored.length || 1))}`);
  console.log(`out/: ${stamp}_ENRICHED.csv (all) · ${stamp}_DIAL.csv (${dial.length}) · ${stamp}_EMAIL.csv (${email.length})`);
  if (PERSIST) {
    const source = opt('source', stamp);
    process.stdout.write(`persisting to enriched_leads (source=${source})...`);
    const saved = await persist(out, source);
    console.log(` ${saved}/${out.length} upserted`);
  } else if (!args.includes('--no-persist')) {
    console.log('(DB persist off: set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to also upsert into enriched_leads)');
  }
}
run();
