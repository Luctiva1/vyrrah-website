#!/usr/bin/env node
/** Keep only substantive (>=300 word) guides; delete thin heuristic ones; rebuild
 *  cross-links, hub and sitemap. Re-run build-guides.mjs (with a paid LLM key) to
 *  regenerate the pruned topics at full quality. */
import { readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'guides');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const MIN_WORDS = 300;

const kept = [];
for (const f of readdirSync(OUT)) {
  if (!f.endsWith('.html') || f === 'index.html') continue;
  const p = join(OUT, f);
  const html = readFileSync(p, 'utf8');
  const body = (html.split('</h1>')[1] || '').split('<div class="cta"')[0] || '';
  const words = body.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  if (words < MIN_WORDS) { unlinkSync(p); console.log(`pruned ${f} (${words}w)`); continue; }
  const slug = f.replace(/\.html$/, '');
  const title = (html.match(/<title>([^<]*?)\s*\|\s*Vyrrah Labs<\/title>/) || [, slug])[1];
  const desc = (html.match(/<meta name="description" content="([^"]*)"/) || [, ''])[1];
  kept.push({ slug, title, desc, html, path: p });
  console.log(`kept ${f} (${words}w)`);
}

// Rebuild each kept page's "More guides" block to reference only kept siblings.
for (const g of kept) {
  const sibs = kept.filter((x) => x.slug !== g.slug).map((x) => `<a href="/guides/${x.slug}">${esc(x.title)}</a>`).join('');
  const rel = sibs ? `<div class="rel"><h3>More guides</h3>${sibs}</div>` : '';
  const fixed = g.html.replace(/<div class="rel"[^>]*>[\s\S]*?<\/div>/, rel);
  writeFileSync(g.path, fixed);
}

// Hub.
const hub = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Search & GEO Guides | Vyrrah Labs</title>
<meta name="description" content="Guides on getting found in Google and AI search — GEO, AEO, schema, and AI visibility for local and service businesses.">
<link rel="canonical" href="https://vyrrahlabs.com/guides">
<style>:root{--bg:#0c0c0e;--ink:#f2ede4;--muted:#a39c8e;--gold:#e8b23a;--line:rgba(242,237,228,.12)}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif}a{color:var(--gold)}.wrap{max-width:760px;margin:0 auto;padding:0 22px}.nav{display:flex;justify-content:space-between;align-items:center;height:62px;border-bottom:1px solid var(--line)}.mark{font-weight:800;color:var(--ink);text-decoration:none}.mark .d{color:var(--gold)}h1{font-size:2rem;margin:34px 0 6px}.sub{color:var(--muted);margin:0 0 26px}.g{display:block;padding:18px 0;border-bottom:1px solid var(--line);text-decoration:none;color:var(--ink)}.g:hover{color:var(--gold)}.g small{display:block;color:var(--muted);font-size:13.5px;margin-top:4px;font-weight:400}</style></head>
<body><div class="wrap"><nav class="nav"><a class="mark" href="/">VYRRAH<span class="d">.</span></a><a href="/scorecard">Free Scorecard →</a></nav>
<h1>AI Search &amp; GEO Guides</h1><p class="sub">Getting found in Google and AI search — ChatGPT, Perplexity, Claude, Google AI.</p>
${kept.map((r) => `<a class="g" href="/guides/${r.slug}"><b>${esc(r.title)}</b><small>${esc(r.desc)}</small></a>`).join('\n')}
</div></body></html>`;
writeFileSync(join(OUT, 'index.html'), hub);

// Sitemap.
const urls = ['https://vyrrahlabs.com/', 'https://vyrrahlabs.com/scorecard', 'https://vyrrahlabs.com/vrank', 'https://vyrrahlabs.com/guides',
  ...kept.map((r) => `https://vyrrahlabs.com/guides/${r.slug}`)];
writeFileSync(join(ROOT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n') + `\n</urlset>\n`);

console.log(`\nKept ${kept.length} substantive guides.`);
