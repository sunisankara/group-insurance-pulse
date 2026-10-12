/**
 * Pulse Engine — single entry point for all shows.
 * Usage: npx tsx engine/run.ts --show group-insurance [--dry-run]
 *
 * Pipeline: recall news -> rank stories -> generate script -> (dry-run? print)
 *   -> synthesize audio -> master mp3 -> text audit -> update feed.
 * Exits non-zero on any failure so GitHub Actions reports red, not green.
 */
import process from 'process';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { Buffer } from 'buffer';
import { loadShowConfig } from './config.js';
import { recallCandidates, rankStories, getRecentCorpus, dedupeStories } from './news.js';
import { generateScript, splitSegments } from './script.js';
import { synthesizeSegment } from './voices.js';
import { auditScript } from './audit.js';
import { generateRSSFeed } from './rss.js';
import { EpisodeRecord } from './types.js';

const args = process.argv.slice(2);
const showId = args[args.indexOf('--show') + 1];
const DRY_RUN = args.includes('--dry-run') || process.env.IS_DRY_RUN === 'true';

if (!showId) {
  console.error('Usage: npx tsx engine/run.ts --show <show-id> [--dry-run]');
  process.exit(2);
}

async function run() {
  const cfg = loadShowConfig(showId);
  console.log(`--- ${cfg.title.toUpperCase()}: PULSE ENGINE ---`);

  const rssDir = path.join(process.cwd(), cfg.rssDir);
  if (!fs.existsSync(rssDir)) fs.mkdirSync(rssDir, { recursive: true });
  const dbPath = path.join(rssDir, 'episodes.json');

  const id = Date.now().toString();
  const filename = `${cfg.id}-${id}.mp3`;
  const filePath = path.join(rssDir, filename);
  const pcmFile = path.join(rssDir, `temp-${id}.pcm`);

  console.log('Step 1: Recalling candidate stories...');
  const candidates = await recallCandidates(cfg);
  if (!candidates.trim()) throw new Error('News recall returned empty');

  console.log('Step 2: Ranking stories (8 candidates, hard-deduped to 5)...');
  const ranked = await rankStories(cfg, candidates, 8);
  if (ranked.length === 0) throw new Error('Ranking returned no stories');
  const stories = dedupeStories(ranked, getRecentCorpus(cfg.rssDir)).slice(0, 5);
  if (stories.length === 0) throw new Error('All ranked stories were repeats of the last 7 days');
  console.log('Ranked:', stories.map((s) => `${s.rank}. ${s.headline} [${s.lens}]`).join('\n'));

  console.log('Step 3: Generating script...');
  let script = await generateScript(cfg, stories);

  // Text audit BEFORE spending on TTS. Regenerate (max 2 attempts) on failure —
  // the old code re-recorded identical audio, which could never fix script issues.
  let audit = auditScript(cfg, script);
  let attempts = 1;
  while (!audit.passed && attempts < 3 && audit.feedbackPrompt) {
    console.log(`Script audit failed (attempt ${attempts}):`, audit.issues.join('; '));
    script = await generateScript(cfg, stories, audit.feedbackPrompt);
    audit = auditScript(cfg, script);
    attempts++;
  }
  if (!audit.passed) {
    console.log('Script audit still failing after retries; continuing with issues:', audit.issues.join('; '));
  } else {
    console.log(`Script audit passed (~${audit.estimatedMinutes?.toFixed(1)} min estimated).`);
  }

  if (DRY_RUN) {
    console.log('--- DRY RUN: SCRIPT ---');
    console.log(script);
    console.log('--- END DRY RUN ---');
    return;
  }

  console.log('Step 4: Synthesizing audio (one call per segment)...');
  const segments = splitSegments(script);
  if (fs.existsSync(pcmFile)) fs.unlinkSync(pcmFile);
  for (let i = 0; i < segments.length; i++) {
    console.log(`   -> Segment ${i + 1}/${segments.length}...`);
    const chunks = await synthesizeSegment(cfg, segments[i]);
    for (const chunk of chunks) {
      fs.appendFileSync(pcmFile, Buffer.from(chunk, 'base64'));
    }
  }
  if (!fs.existsSync(pcmFile)) throw new Error('No audio produced');

  console.log('Step 5: Mastering...');
  execSync(`ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${pcmFile}" -acodec libmp3lame -ab 128k "${filePath}"`);
  fs.unlinkSync(pcmFile);

  console.log('Step 6: Updating feed...');
  const episodes: EpisodeRecord[] = fs.existsSync(dbPath) ? JSON.parse(fs.readFileSync(dbPath, 'utf8')) : [];
  const topStories = stories.map((s) => s.headline);
  episodes.unshift({
    id,
    date: new Date().toISOString(),
    title: topStories[0] || `${cfg.title} Briefing`,
    script,
    audioUrl: filename, // feed base already includes the rss dir
    topics: topStories,
    mainStories: topStories,
    status: 'published',
    auditIssues: audit.issues,
  });
  fs.writeFileSync(dbPath, JSON.stringify(episodes, null, 2));

  const repoPath = process.env.GITHUB_REPOSITORY || 'owner/repo';
  const [owner, repoName] = repoPath.split('/');
  const baseUrl = `https://${owner}.github.io/${repoName}`;
  const feedBase = cfg.rssDir === 'rss' ? `${baseUrl}/rss` : `${baseUrl}/${cfg.rssDir}`;
  fs.writeFileSync(path.join(rssDir, 'feed.xml'), generateRSSFeed(episodes, cfg, feedBase));

  console.log('--- BROADCAST COMPLETE ---');
}

run().catch((err) => {
  console.error('--- ENGINE ERROR ---', err?.message || err);
  process.exit(1);
});
