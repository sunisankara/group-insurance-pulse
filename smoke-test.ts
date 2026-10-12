import { loadShowConfig } from './engine/config.js';
import { parseRanked, newsWindow, dedupeStories } from './engine/news.js';
import { splitSegments, splitOversizedSegment } from './engine/script.js';
import { auditScript } from './engine/audit.js';
import { generateRSSFeed } from './engine/rss.js';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => { cond ? pass++ : (fail++, console.log('FAIL:', name)); };

// 1. configs load, voices distinct per show, and distinct ACROSS shows
const gi = loadShowConfig('group-insurance');
const hc = loadShowConfig('healthcare');
ok('gi title', gi.title === 'Group Insurance Daily Pulse');
ok('gi rssDir legacy', gi.rssDir === 'rss');
ok('hc rssDir', hc.rssDir === 'rss/healthcare');
const allVoices = [...gi.hosts, ...hc.hosts].map(h => h.voice);
ok('4 unique voices across shows', new Set(allVoices).size === 4);
ok('gi keeps Kore+Puck', gi.hosts[0].voice === 'Kore' && gi.hosts[1].voice === 'Puck');
ok('hc gets Charon+Aoede', hc.hosts[0].voice === 'Charon' && hc.hosts[1].voice === 'Aoede');
ok('hosts docs loaded', gi.hostsDoc.includes('Aria') && hc.hostsDoc.includes('Alex'));
ok('lenses docs loaded', gi.lensesDoc.includes('The Regulator') && hc.lensesDoc.includes('The CMS Regulator'));

// 2. newsWindow handles month boundary
const w = newsWindow(new Date(2026, 9, 1)); // Oct 1
ok('month boundary', w.day1 === '9/30' && w.day2 === '10/1');

// 3. parseRanked
const ranked = parseRanked(`[RANK 1]\nHEADLINE: MetLife buys X\nFACTS: $2B deal\nCONTEXT: Big for carriers\nLENS: The CFO\n[RANK 2]\nHEADLINE: DOI acts\nFACTS: fine $5M\nCONTEXT: compliance\nLENS: The Regulator`);
ok('parse 2 stories', ranked.length === 2 && ranked[0].lens === 'The CFO' && ranked[1].headline === 'DOI acts');

// 4. segment splitting keeps speaker labels on oversized pieces
const seg = 'Aria: ' + 'x '.repeat(3000) + '\nDorian: short reply here.';
const pieces = splitOversizedSegment(seg, ['Aria', 'Dorian'], 4500);
ok('oversized split keeps labels', pieces.length === 2 && pieces[1].startsWith('Dorian:'));
const script = `Aria: Headline one is here today.\nDorian: I agree, and here is why it matters for brokers.\n[TRANSITION]\nAria: Second story headline.\nDorian: The numbers back it up.`;
ok('splitSegments', splitSegments(script).length === 2);

// 5. audit catches problems, passes good script
const topics = ['loss ratios in group disability', 'broker consolidation trends', 'PFML mandate expansion', 'claims automation pilots', 'reinsurance treaty renewals', 'enrollment platform upgrades'];
const good = Array.from({length: 60}, (_, i) =>
  `Aria: On ${topics[i % topics.length]}, the development numbered ${i} deserves scrutiny because the underlying economics shift materially for carriers.\nDorian: From the field, item ${i} lands differently — distributors I talk to see a practical opening here worth testing this quarter.`).join('\n');
const aGood = auditScript(gi, good);
ok('audit passes decent script', aGood.passed);
const bad = 'Aria: hi.\n'.repeat(50);
const aBad = auditScript(gi, bad);
ok('audit fails tiny script', !aBad.passed && aBad.issues.some(i => i.includes('duration')));
// duplicated story across two segments must be caught
const dupStory = 'Aria: MetLife announced a two billion dollar acquisition of a dental carrier today, expanding its voluntary benefits footprint significantly across the midwest region.\nDorian: That dental deal reshapes the voluntary market in ways brokers will feel immediately this enrollment season.';
const dup = Array.from({length: 30}, () => `Aria: Fresh analysis point here with completely original wording about market dynamics today.\nDorian: And a genuinely different distribution take with new phrasing nobody has used before.`).join('\n')
  + '\n[TRANSITION]\n' + dupStory
  + '\n[TRANSITION]\n' + dupStory;
const aDup = auditScript(gi, dup);
ok('audit catches duplicated story', !aDup.passed && aDup.issues.some(i => i.includes('duplicated story')));

// 6b. Hard 7-day dedup: variation-of-same-story is dropped, different
// developments from the same company and two carriers' earnings both survive
const recent = ['Prudential launches AI underwriting for group disability'];
const mk = (h: string, f: string) => ({ rank: 1, headline: h, facts: f, context: '', lens: 'The CFO', source: '' });
const prudVar = mk('Prudential expands AI underwriting platform to voluntary benefits', 'Prudential is rolling its underwriting engine into voluntary products');
const prudNew = mk('Prudential acquires a dental carrier for $800M', 'Prudential announced an $800M acquisition of a dental carrier');
const earnA = mk('MetLife Q3 earnings beat expectations', 'MetLife reported Q3 earnings with revenue up 6 percent');
const earnB = mk('Prudential Q3 earnings miss on investment losses', 'Prudential posted Q3 earnings below estimates on investment losses');
ok('dedup drops Prudential variation', dedupeStories([prudVar], recent).length === 0);
ok('dedup keeps genuinely new Prudential development', dedupeStories([prudNew], recent).length === 1);
ok('dedup keeps both carriers earnings', dedupeStories([earnA, earnB], []).length === 2);

// 6. RSS feed builds with per-show metadata
const feed = generateRSSFeed([{ id: '1', date: new Date().toISOString(), title: 'Test & Title', script: 'Aria: hello', audioUrl: 'rss/ep.mp3', topics: [], mainStories: ['a & b'], status: 'published', auditIssues: [] }], gi, 'https://sunisankara.github.io/group-insurance-pulse/rss');
ok('rss escapes + title', feed.includes('Test &amp; Title') && feed.includes('<title>Group Insurance Daily Pulse</title>'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
