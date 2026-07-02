// Opener engine — VALUE-LED, not gap-led. Prospects are selfish: lead with the
// cutting observation + what THEY get, then a soft CTA. Rules:
//   1. Only ONE sharp angle per opener (stacking reads clunky).
//   2. Only assert DETECTED facts. Never fabricate a number ("3x too expensive")
//      you can't see — frame the OUTCOME instead ("same leads at a fraction of the spend").
//   3. No generic filler. If no real hook fires, return '' (skip / research by hand)
//      — a blank beats a line that sounds worse than a normal cold call.
//   4. No location fluff, no "costing you booked jobs" twice.
// Merge fields on f: first, company, vertical, score, competitor, runsAds, hasForm,
// hasChat, reviews, loadS, pageSpeed, reviewCount, compReviews, adCount.

function prize(v) {
  if (['restoration', 'roofing', 'home services'].includes(v)) return 'booked jobs';
  if (['dental', 'med-spa'].includes(v)) return 'new patients';
  if (v === 'legal') return 'new cases';
  if (v === 'staffing/recruitment') return 'placements';
  return 'new customers';
}
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

// Ordered by punch. First match wins. Each returns the core value clause.
// House style: no em/en dashes anywhere (kept in sync with buildOpener in api/geo.js).
const ANGLES = [
  { id: 'ads', when: f => f.runsAds,
    line: (f, p) => `you're renting every lead through paid ads, so the day you stop, it stops. I get businesses like yours the same ${p} from Google and AI search at a fraction of that ad spend` },

  { id: 'ai-competitor', when: f => f.score != null && f.score < 58 && f.competitor,
    line: (f, p) => `when your customers ask ChatGPT or Google AI who to use, ${f.competitor} gets named and you don't. That's ${p} handed straight to them, and getting you into that answer is exactly what I do` },

  { id: 'reviews', when: f => f.reviewCount != null && f.compReviews != null && f.reviewCount < f.compReviews * 0.5,
    line: (f, p) => `${f.competitor} shows ${f.compReviews} reviews to your ${f.reviewCount}, and that gap alone is why AI and buyers pick them over you. I close it fast and you win those ${p} back` },

  { id: 'slow', when: f => (f.pageSpeed != null && f.pageSpeed < 40) || (f.loadS != null && f.loadS >= 5),
    line: (f, p) => `your site takes ${f.loadS ? f.loadS + 's' : 'far too long'} to load, so you lose over half your visitors before it opens and you're paying for traffic that never sees you. I win those ${p} back` },

  { id: 'no-capture', when: f => !f.hasForm && !f.hasChat && (f.runsAds || (f.score != null && f.score >= 45)),
    line: (f, p) => `you're sending visitors to a homepage with no way to capture them, so that traffic leaks straight out. I turn the visitors you already get into ${p}` },

  { id: 'ai-only', when: f => f.score != null && f.score < 62 && f.competitor,
    line: (f, p) => `you're near-invisible in AI search while ${f.competitor} isn't, and that's where your buyers are starting to look. I get you found there before they lock it up, and it turns into ${p}` },
];

export function assembleOpener(f, channel = 'call') {
  const p = prize(f.vertical || 'default');
  if (f.blocked) {
    const core = `your site blocks the crawlers ChatGPT, Perplexity and Google AI use to read you, so you're effectively invisible in AI search, and that's ${p} going to whoever they CAN read. I fix that fast`;
    return channel === 'email' ? cap(core) + '.' : `Hi ${f.first}, ${core}. Worth 15 minutes?`;
  }
  const hit = ANGLES.find(a => { try { return a.when(f); } catch { return false; } });
  if (!hit) return ''; // no real hook, skip, don't fake one
  const core = hit.line(f, p);
  return channel === 'email' ? cap(core) + '.' : `Hi ${f.first}, ${core}. Worth 15 minutes to see how?`;
}
