import { loadShowConfig, resolveTtsProvider } from './engine/config.js';
import { parseRanked, newsWindow, dedupeStories, extractLensNames } from './engine/news.js';
import { splitSegments, splitOversizedSegment } from './engine/script.js';
import { auditScript } from './engine/audit.js';
import { generateRSSFeed } from './engine/rss.js';
import {
  CHIRP_TTS_ENDPOINT,
  CHIRP_SSML_TAGS,
  applyPronunciations,
  buildTurnSsml,
  prosodyForHost,
  parseTurns,
  splitTurnText,
  chirpSynthesizeSsml,
  synthesizeSegmentChirp,
  getChirpUsage,
  resetChirpUsage,
} from './engine/chirp.js';

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
  `Aria: On ${topics[i % topics.length]}, the development numbered ${i} deserves scrutiny because the underlying economics shift materially for carriers.\nDorian: From the field, item ${i} lands differently — distributors I talk to see a practical opening here worth testing this quarter.`).join('\n')
  + '\nAria: Thanks for joining us on Group Insurance Daily Pulse.\nDorian: We\'ll be back tomorrow — see you then.';
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

// 5b. Oct 2026 regressions: truncated script (mid-sentence, no sign-off) must
// fail; AI-tell phrases must fail; Dorian's room anecdote repeated from a
// recent episode must fail.
const truncated = good.slice(0, good.length - 400) + ' and that is why brokers are so';
ok('audit fails truncated script', !auditScript(gi, truncated).passed);
const withTell = good.replace('deserves scrutiny', 'deserves scrutiny — moreover, it is a landscape worth mapping');
ok('audit fails AI-tell phrasing', !auditScript(gi, withTell).passed);
const roomToday = good + '\nAria: One more thing before we go.\nDorian: I was in a room in Dallas where a broker said the same thing.';
const roomRecent = ['Aria: Earlier.\nDorian: I was in a room last week where this exact fight played out.'];
ok('audit fails repeated room anecdote', !auditScript(gi, roomToday, roomRecent).passed);
const roomFresh = good + '\nAria: One more thing before we go.\nDorian: I was in a room in Dallas where a broker said the same thing.';
ok('audit allows room anecdote when not recent', auditScript(gi, roomFresh, []).passed || auditScript(gi, roomFresh, ['Aria: A quiet day.\nDorian: Agreed, nothing to add.']).passed);

// 5c. Oct 31 regressions (the five-day GI outage): a digest script recycles
// recent episodes BY DESIGN — it must fail the recycled-phrase check as a
// fresh script and pass it in digest mode. And a sign-off followed by one
// short closing segment must still count as signed off.
const aRecycledFresh = auditScript(gi, good, [good]);
ok('fresh audit fails wholesale recycling', !aRecycledFresh.passed && aRecycledFresh.issues.some(i => i.includes('recycled')));
ok('digest audit exempt from recycling check', auditScript(gi, good, [good], { digest: true }).passed);
const trailedOff = good + '\n[TRANSITION]\nAria: Quick final note — the enrollment window opens Monday.\nDorian: Brokers, set your reminders tonight.';
ok('sign-off counts within last 400 chars', auditScript(gi, trailedOff).passed);

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

// 6c. Lens names extract from lenses.md for the rank prompt
const giLenses = extractLensNames(gi.lensesDoc);
ok('lens names extracted', giLenses.includes('The CFO') && giLenses.includes('The Actuary') && giLenses.length >= 8);
// LENS parses even when the model writes it lowercase
const lower = parseRanked(`[RANK 1]\nHEADLINE: X\nlens: The Regulator\nFACTS: y\nCONTEXT: z`);
ok('lens label case-insensitive', lower.length === 1 && lower[0].lens === 'The Regulator');

// 6. RSS feed builds with per-show metadata
const feed = generateRSSFeed([{ id: '1', date: new Date().toISOString(), title: 'Test & Title', script: 'Aria: hello', audioUrl: 'rss/ep.mp3', topics: [], mainStories: ['a & b'], status: 'published', auditIssues: [] }], gi, 'https://sunisankara.github.io/group-insurance-pulse/rss');
ok('rss escapes + title', feed.includes('Test &amp; Title') && feed.includes('<title>Group Insurance Daily Pulse</title>'));

// 7. Chirp 3 HD provider: voice config + provider resolution
ok('gi chirp voices', gi.hosts[0].chirpVoice === 'en-US-Chirp3-HD-Aoede' && gi.hosts[1].chirpVoice === 'en-US-Chirp3-HD-Fenrir');
ok('hc chirp voices', hc.hosts[0].chirpVoice === 'en-US-Chirp3-HD-Puck' && hc.hosts[1].chirpVoice === 'en-US-Chirp3-HD-Zephyr');
delete process.env.TTS_PROVIDER;
ok('provider defaults to gemini', resolveTtsProvider(gi) === 'gemini');
process.env.TTS_PROVIDER = 'chirp';
ok('TTS_PROVIDER env enables chirp', resolveTtsProvider(gi) === 'chirp');
ok('show config beats env default', resolveTtsProvider({ ...gi, ttsProvider: 'gemini' }) === 'gemini');
delete process.env.TTS_PROVIDER;

// 7b. SSML builder: pronunciations, breaks, escaping, tag-subset compliance
const pron = applyPronunciations('fund your 401(k) and check the HMO before EBITDA at Aflac');
ok('ssml sub for 401(k)', pron.includes('<sub alias="four oh one k">401(k)</sub>'));
ok('ssml say-as for HMO', pron.includes('<say-as interpret-as="characters">HMO</say-as>'));
ok('ssml sub for EBITDA', pron.includes('<sub alias="ee-bit-dah">EBITDA</sub>'));
ok('ssml sub for Aflac', pron.includes('<sub alias="aff-lack">Aflac</sub>'));
ok('ssml leaves lowercase prose alone', applyPronunciations('the hmo down the road') === 'the hmo down the road');
const ssml = buildTurnSsml('First topic point.\n\nSecond topic point & more.', prosodyForHost(0));
ok('ssml wraps in speak', ssml.startsWith('<speak>') && ssml.endsWith('</speak>'));
ok('ssml break at paragraph transition', ssml.includes('<break time="650ms"/>'));
ok('ssml escapes ampersand', ssml.includes('&amp;') && !ssml.includes(' & '));
ok('ssml prosody per host', ssml.includes('<prosody rate="100%" pitch="+0.5st">') && buildTurnSsml('x', prosodyForHost(1)).includes('rate="97%"'));
const tagsUsed = [...ssml.matchAll(/<\/?([a-z][a-z-]*)/g)].map((m) => m[1]);
ok('ssml emits only chirp-supported tags', tagsUsed.length > 0 && tagsUsed.every((t) => CHIRP_SSML_TAGS.includes(t)));
const turns = parseTurns('Aria: Hello there.\nDorian: Hi back.\nAria: Next point.', gi.hosts);
ok('parseTurns routes lines to hosts', turns.length === 3 && turns[0].hostIndex === 0 && turns[1].hostIndex === 1 && turns[2].text === 'Next point.');
const longChunks = splitTurnText('Word. '.repeat(900));
ok('splitTurnText keeps requests under limit', longChunks.length >= 2 && longChunks.every((c) => c.length <= 3200));

// 7c. Request shaping with mocked HTTP, WAV stripping, char accounting,
// and the per-segment Gemini fallback on provider failure.
function fakeWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
const testPcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
let captured: { url: string; init: any } | null = null;
const mockOk = async (url: any, init: any) => {
  captured = { url: String(url), init };
  return {
    ok: true,
    status: 200,
    json: async () => ({ audioContent: fakeWav(testPcm).toString('base64') }),
    text: async () => '',
  };
};
resetChirpUsage();
const pcmOut = await chirpSynthesizeSsml('<speak>hello</speak>', 'en-US-Chirp3-HD-Aoede', {
  fetchFn: mockOk as any,
  apiKey: 'test-key',
  sleep: async () => {},
});
ok('chirp returns raw pcm (wav header stripped)', pcmOut.equals(testPcm));
ok('chirp posts to the cloud tts endpoint', captured !== null && captured.url === CHIRP_TTS_ENDPOINT);
const sentBody = JSON.parse(captured!.init.body);
ok(
  'chirp request shaping (voice, language, LINEAR16 24kHz)',
  sentBody.voice.name === 'en-US-Chirp3-HD-Aoede' &&
    sentBody.voice.languageCode === 'en-US' &&
    sentBody.audioConfig.audioEncoding === 'LINEAR16' &&
    sentBody.audioConfig.sampleRateHertz === 24000
);
ok(
  'chirp request carries ssml + api key header',
  sentBody.input.ssml === '<speak>hello</speak>' && captured!.init.headers['X-Goog-Api-Key'] === 'test-key'
);
ok(
  'chirp usage counts ssml characters',
  getChirpUsage().characters === '<speak>hello</speak>'.length && getChirpUsage().calls === 1
);
const mockFail = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'boom' });
const fbOut = await synthesizeSegmentChirp(gi, 'Aria: An HMO update for brokers today.', async () => ['gemini-audio'], {
  fetchFn: mockFail as any,
  apiKey: 'test-key',
  sleep: async () => {},
});
ok('chirp failure falls back to gemini for the segment', fbOut.length === 1 && fbOut[0] === 'gemini-audio');
ok('chirp fallback is counted', getChirpUsage().fallbacks === 1);
const noneOut = await synthesizeSegmentChirp(gi, '[TRANSITION]', async () => ['should-not-happen'], {
  fetchFn: mockFail as any,
  apiKey: 'test-key',
  sleep: async () => {},
});
ok('empty segment reaches neither provider', noneOut.length === 0 && getChirpUsage().fallbacks === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
