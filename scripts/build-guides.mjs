#!/usr/bin/env node
/**
 * Dogfood pipeline: use V-Rank's OWN engine (/api/geo?path=generate) to build a
 * real GEO content library for vyrrahlabs.com, published as schema-marked-up pages.
 * This is what lifts the site's own "topical authority" score — and proves the engine.
 *
 * Run:  node scripts/build-guides.mjs            (hits live prod engine)
 *       BASE=http://localhost:3000 node scripts/build-guides.mjs
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE || 'https://vyrrahlabs.com';
const OUT = join(ROOT, 'guides');

// The library — GEO/AI-search topics that build topical authority for Vyrrah's ICP.
const TOPICS = [
  { slug: 'does-chatgpt-recommend-your-business', type: 'article', topic: 'Does ChatGPT recommend your business? How to check and fix your AI visibility' },
  { slug: 'geo-vs-seo', type: 'article', topic: 'GEO vs SEO: what Generative Engine Optimization means for local businesses' },
  { slug: 'how-to-get-cited-by-ai-search', type: 'article', topic: 'How to get cited by AI search engines (ChatGPT, Perplexity, Google AI Overviews)' },
  { slug: 'answer-engine-optimization-guide', type: 'article', topic: 'Answer Engine Optimization (AEO): a practical guide for service businesses' },
  { slug: 'schema-markup-for-ai-search', type: 'article', topic: 'Schema markup for AI search: the structured data that gets you cited by AI' },
  { slug: 'ai-visibility-for-restoration-companies', type: 'article', topic: 'AI visibility for water and fire damage restoration companies' },
  { slug: 'ai-search-for-med-spas', type: 'article', topic: 'AI search for med spas and aesthetic clinics: how to get recommended by AI' },
  { slug: 'why-your-business-is-invisible-in-ai-answers', type: 'listicle', topic: '7 reasons your business is invisible in AI answers (and how to fix each)' },
];

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal, safe Markdown -> HTML (headings, bold, links, ordered/unordered lists, paragraphs).
function mdToHtml(md) {
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  const out = [];
  let inUl = false, inOl = false, para = [];
  const flushPara = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  const closeLists = () => { if (inUl) { out.push('</ul>'); inUl = false; } if (inOl) { out.push('</ol>'); inOl = false; } };
  function inline(t) {
    return esc(t)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>');
  }
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (!l.trim()) { flushPara(); closeLists(); continue; }
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)$/))) { flushPara(); closeLists(); const lvl = Math.min(m[1].length + 1, 4); out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`); continue; }
    if ((m = l.match(/^\s*[-*]\s+(.*)$/))) { flushPara(); if (inOl) { out.push('</ol>'); inOl = false; } if (!inUl) { out.push('<ul>'); inUl = true; } out.push('<li>' + inline(m[1]) + '</li>'); continue; }
    if ((m = l.match(/^\s*\d+\.\s+(.*)$/))) { flushPara(); if (inUl) { out.push('</ul>'); inUl = false; } if (!inOl) { out.push('<ol>'); inOl = true; } out.push('<li>' + inline(m[1]) + '</li>'); continue; }
    para.push(l);
  }
  flushPara(); closeLists();
  return out.join('\n');
}

function page({ title, bodyHtml, schemaObjects, slug, desc }) {
  const canonical = `https://vyrrahlabs.com/guides/${slug}`;
  const graph = { '@context': 'https://schema.org', '@graph': schemaObjects };
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} | Vyrrah Labs</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${canonical}">
<script type="application/ld+json">${JSON.stringify(graph)}</script>
<style>
:root{--bg:#0c0c0e;--ink:#f2ede4;--muted:#a39c8e;--gold:#e8b23a;--line:rgba(242,237,228,.12)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--gold)}
.top{border-bottom:1px solid var(--line)}
.wrap{max-width:760px;margin:0 auto;padding:0 22px}
.nav{display:flex;justify-content:space-between;align-items:center;height:62px}
.mark{font-weight:800;letter-spacing:.02em;color:var(--ink);text-decoration:none}
.mark .d{color:var(--gold)}
.crumbs{font-size:13px;color:var(--muted);margin:26px 0 6px}
article h1{font-size:2.05rem;line-height:1.15;margin:.2em 0 .5em}
article h2{font-size:1.4rem;margin:1.6em 0 .4em}
article h3{font-size:1.15rem;margin:1.3em 0 .3em}
article p{color:#e7e2d7}article li{margin:.3em 0}
.meta{color:var(--muted);font-size:13.5px;margin-bottom:28px;border-bottom:1px solid var(--line);padding-bottom:18px}
.cta{margin:42px 0 20px;padding:26px;border:1px solid var(--gold);border-radius:14px;background:linear-gradient(180deg,rgba(232,178,58,.08),transparent)}
.cta h3{margin:0 0 8px}.cta p{color:var(--muted);margin:0 0 16px}
.btn{display:inline-block;background:var(--gold);color:#1a1400;font-weight:700;padding:13px 22px;border-radius:10px;text-decoration:none}
.rel{margin:40px 0;padding-top:22px;border-top:1px solid var(--line)}
.rel a{display:block;padding:8px 0;color:var(--ink);text-decoration:none;border-bottom:1px solid var(--line)}
.rel a:hover{color:var(--gold)}
footer{border-top:1px solid var(--line);margin-top:50px;padding:26px 0;color:var(--muted);font-size:13px}
</style>
</head>
<body>
<div class="top"><div class="wrap"><nav class="nav"><a class="mark" href="/">VYRRAH<span class="d">.</span></a><a href="/scorecard">Free AI-Visibility Scorecard →</a></nav></div></div>
<div class="wrap">
  <div class="crumbs"><a href="/">Home</a> · <a href="/guides">Guides</a></div>
  <article>
    <h1>${esc(title)}</h1>
    <div class="meta">By Godwin Rayen, Vyrrah Labs · Get found in Google AND AI search</div>
    ${bodyHtml}
  </article>
  <div class="cta">
    <h3>See where you stand in AI search — free</h3>
    <p>Get your 0–100 AI-Visibility Score across ChatGPT, Perplexity, Claude and Google AI. No card, no email gate.</p>
    <a class="btn" href="/scorecard">Run my free Scorecard →</a>
  </div>
  <div class="rel" id="related"></div>
  <footer class="wrap">© Vyrrah Labs · <a href="/">Home</a> · <a href="/guides">All guides</a> · <a href="/scorecard">Free Scorecard</a></footer>
</div>
</body>
</html>`;
}

async function generate(t) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`${BASE}/api/geo?path=generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: t.type, url_or_topic: t.topic }),
      });
      const d = await r.json();
      if (d && d.content) return d;
    } catch (e) { /* retry */ }
    await sleep(4000);
  }
  return null;
}

const results = [];
mkdirSync(OUT, { recursive: true });
for (const t of TOPICS) {
  process.stdout.write(`generating ${t.slug} ... `);
  const d = await generate(t);
  if (!d) { console.log('FAILED'); continue; }
  const title = d.title || t.topic;
  const desc = (String(d.content).replace(/[#*>\-\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 155));
  const articleSchema = {
    '@type': 'Article', headline: title, description: desc,
    author: { '@type': 'Person', name: 'Godwin Rayen' },
    publisher: { '@type': 'Organization', name: 'Vyrrah Labs', url: 'https://vyrrahlabs.com' },
    mainEntityOfPage: `https://vyrrahlabs.com/guides/${t.slug}`,
  };
  const schemaObjects = [articleSchema];
  if (d.schema && typeof d.schema === 'object') schemaObjects.push({ ...d.schema });
  const html = page({ title, bodyHtml: mdToHtml(d.content), schemaObjects, slug: t.slug, desc });
  writeFileSync(join(OUT, `${t.slug}.html`), html);
  results.push({ slug: t.slug, title, desc, mock: !!(d.meta && d.meta.mock) });
  console.log(d.meta && d.meta.mock ? 'ok (mock/heuristic)' : 'ok (LLM)');
  await sleep(3500); // be gentle on the rate limit
}

// Related-links: inject into each page (simple client-side include of the sibling list).
const relHtml = results.map((r) => `<a href="/guides/${r.slug}">${esc(r.title)}</a>`).join('');
for (const r of results) {
  const p = join(OUT, `${r.slug}.html`);
  const cur = (await import('node:fs')).readFileSync(p, 'utf8');
  const sibs = results.filter((x) => x.slug !== r.slug).slice(0, 5)
    .map((x) => `<a href="/guides/${x.slug}">${esc(x.title)}</a>`).join('');
  writeFileSync(p, cur.replace('<div class="rel" id="related"></div>', `<div class="rel"><h3>More guides</h3>${sibs}</div>`));
}

// Hub page.
const hub = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Search & GEO Guides | Vyrrah Labs</title>
<meta name="description" content="Guides on getting found in Google and AI search — GEO, AEO, schema, and AI visibility for local and service businesses.">
<link rel="canonical" href="https://vyrrahlabs.com/guides">
<style>:root{--bg:#0c0c0e;--ink:#f2ede4;--muted:#a39c8e;--gold:#e8b23a;--line:rgba(242,237,228,.12)}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif}a{color:var(--gold)}.wrap{max-width:760px;margin:0 auto;padding:0 22px}.nav{display:flex;justify-content:space-between;align-items:center;height:62px;border-bottom:1px solid var(--line)}.mark{font-weight:800;color:var(--ink);text-decoration:none}.mark .d{color:var(--gold)}h1{font-size:2rem;margin:34px 0 6px}.sub{color:var(--muted);margin:0 0 26px}.g{display:block;padding:18px 0;border-bottom:1px solid var(--line);text-decoration:none;color:var(--ink)}.g:hover{color:var(--gold)}.g small{display:block;color:var(--muted);font-size:13.5px;margin-top:4px;font-weight:400}</style></head>
<body><div class="wrap"><nav class="nav"><a class="mark" href="/">VYRRAH<span class="d">.</span></a><a href="/scorecard">Free Scorecard →</a></nav>
<h1>AI Search &amp; GEO Guides</h1><p class="sub">Getting found in Google and AI search — ChatGPT, Perplexity, Claude, Google AI.</p>
${results.map((r) => `<a class="g" href="/guides/${r.slug}"><b>${esc(r.title)}</b><small>${esc(r.desc)}</small></a>`).join('\n')}
</div></body></html>`;
writeFileSync(join(OUT, 'index.html'), hub);

// Sitemap.
const urls = ['https://vyrrahlabs.com/', 'https://vyrrahlabs.com/scorecard', 'https://vyrrahlabs.com/vrank', 'https://vyrrahlabs.com/guides',
  ...results.map((r) => `https://vyrrahlabs.com/guides/${r.slug}`)];
writeFileSync(join(ROOT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n') + `\n</urlset>\n`);

console.log(`\nDONE: ${results.length} guides + hub + sitemap. LLM: ${results.filter(r=>!r.mock).length}, heuristic: ${results.filter(r=>r.mock).length}`);
