/**
 * Pulse Engine — single entry point for all shows.
 * Usage: npx tsx engine/run.ts --show group-insurance [--dry-run]
 *
 * Pipeline: recall news -> rank stories -> generate script -> audit (HARD
 *   GATE) -> synthesize audio -> master mp3 -> update feed.
 * Script fallback chain: fresh script (3 attempts) -> digest episode built
 *   from recent episodes (2 attempts) -> skip the day (exit non-zero).
 * A broken or truncated script is NEVER published: a missing day costs a
 * day, a 2-minute stub costs listener trust. (Rule set 2026-10-22 after
 * the Oct 21 stub episode and a run of mid-sentence endings.)
 * Exits non-zero on any failure so GitHub Actions reports red, not green.
 */
import process from 'process';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { Buffer } from 'buffer';
import { loadShowConfig } from './config.js';
import { recallCandidates, rankStories, getRecentCorpus, dedupeStories } from './news.js';
import { generateScript, splitSegments, ContinuityContext } from './script.js';
import { synthesizeSegment } from './voices.js';
import { auditScript } from './audit.js';
import { buildDigestMaterial, generateDigestScript } from './digest.js';
import { generateRSSFeed } from './rss.js';
import { AuditResult, EpisodeRecord } from './types.js';

const args = process.argv.slice(2);
const showId = args[args.indexOf('--show') + 1];
const DRY_RUN = args.includes('--dry-run') || process.env.IS_DRY_RUN === 'true';

if (!showId) {
  console.error('Usage: npx tsx engine/run.ts --show <show-id> [--dry-run]');
  process.exit(2);
}

interface ScriptOutcome {
  script: string;
  audit: AuditResult;
  digest: boolean;
}

/**
 * Run the fresh-script attempt loop: generate, audit, regenerate with the
 * audit's own feedback. A generation error (e.g. truncated response) counts
 * as a failed attempt, not a crashed run. Returns null if all attempts fail.
 */
async function tryFreshScript(
  cfg: ReturnType<typeof loadShowConfig>,
  stories: Parameters<typeof generateScript>[1],
  recentScripts: string[],
  continuity: ContinuityContext
): Promise<ScriptOutcome | null> {
  let feedback: string | undefined;
  let lastIssues: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const script = await generateScript(cfg, stories, feedback, continuity);
      const audit = auditScript(cfg, script, recentScripts);
      if (audit.passed) {
        console.log(`Script audit passed on attempt ${attempt} (~${audit.estimatedMinutes?.toFixed(1)} min estimated).`);
        return { script, audit, digest: false };
      }
      lastIssues = audit.issues;
      feedback = audit.feedbackPrompt;
      console.log(`Script audit failed (attempt ${attempt}/3):`, audit.issues.join('; '));
    } catch (err: any) {
      lastIssues = [`generation error: ${err?.message || err}`];
      feedback = `The previous attempt failed during generation (${err?.message || err}). Write a complete script that ends with a proper sign-off.`;
      console.log(`Script generation failed (attempt ${attempt}/3):`, err?.message || err);
    }
  }
  console.log('Fresh script failed all 3 attempts. Last issues:', lastIssues.join('; '));
  return null;
}

/** Digest fallback: recap episode generated from the show's own archive. */
async function tryDigestScript(
  cfg: ReturnType<typeof loadShowConfig>,
  recentEpisodes: EpisodeRecord[],
  recentScripts: string[]
): Promise<ScriptOutcome | null> {
  const material = buildDigestMaterial(recentEpisodes, 4);
  if (!material) {
    console.log('Digest fallback unavailable: fewer than 2 usable recent episodes.');
    return null;
  }
  console.log(`Trying digest fallback from ${material.episodes.length} recent episodes...`);
  let feedback: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const script = await generateDigestScript(cfg, material, feedback);
      const audit = auditScript(cfg, script, recentScripts, { digest: true });
      if (audit.passed) {
        console.log(`Digest script audit passed on attempt ${attempt} (~${audit.estimatedMinutes?.toFixed(1)} min estimated).`);
        return { script, audit, digest: true };
      }
      feedback = audit.feedbackPrompt;
      console.log(`Digest audit failed (attempt ${attempt}/2):`, audit.issues.join('; '));
    } catch (err: any) {
      feedback = `The previous attempt failed during generation (${err?.message || err}). Write a complete script that ends with a proper sign-off.`;
      console.log(`Digest generation failed (attempt ${attempt}/2):`, err?.message || err);
    }
  }
  return null;
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

  // History first: audit cross-checks, host continuity, and digest material
  // all read the archive before today's episode exists.
  const episodes: EpisodeRecord[] = fs.existsSync(dbPath) ? JSON.parse(fs.readFileSync(dbPath, 'utf8')) : [];
  const recentScripts = episodes.slice(0, 3).map((e) => e.script || '');
  const prev = episodes[0];
  const continuity: ContinuityContext = {
    previousStories: prev && !prev.digest ? prev.mainStories || [] : [],
    previousTail: prev ? (prev.script || '').slice(-900) : '',
  };

  console.log('Step 1: Recalling candidate stories...');
  const candidates = await recallCandidates(cfg);
  if (!candidates.trim()) throw new Error('News recall returned empty');

  console.log('Step 2: Ranking stories (8 candidates, hard-deduped to 5)...');
  const ranked = await rankStories(cfg, candidates, 8);
  if (ranked.length === 0) throw new Error('Ranking returned no stories');
  const fresh = dedupeStories(ranked, getRecentCorpus(cfg.rssDir));
  // The show must go on: if dedup leaves fewer than 3, refill from the
  // dropped repeats in rank order (loud warning) rather than failing the day.
  let stories = fresh.slice(0, 5);
  if (stories.length < 3) {
    const dropped = ranked.filter((r) => !fresh.includes(r));
    const need = Math.min(3 - stories.length, dropped.length);
    stories = [...stories, ...dropped.slice(0, need)];
    console.log(`WARNING: only ${fresh.length} fresh stories; using ${need} recent repeat(s) to fill the episode.`);
  }
  if (stories.length === 0) throw new Error('Ranking returned no stories');
  console.log('Ranked:', stories.map((s) => `${s.rank}. ${s.headline} [${s.lens}]`).join('\n'));

  console.log('Step 3: Generating script (audit is a hard gate)...');
  const outcome = await tryFreshScript(cfg, stories, recentScripts, continuity);

  if (DRY_RUN) {
    if (outcome) {
      console.log('--- DRY RUN: SCRIPT ---');
      console.log(outcome.script);
      console.log('--- END DRY RUN ---');
    } else {
      console.log('--- DRY RUN: fresh script failed all attempts; production would try the digest fallback, then skip the day. ---');
      process.exitCode = 1;
    }
    return;
  }

  const finalOutcome = outcome ?? (await tryDigestScript(cfg, episodes, recentScripts));
  if (!finalOutcome) {
    throw new Error('Script generation failed (fresh x3, digest x2). Skipping today\'s episode rather than publishing a broken one.');
  }
  if (finalOutcome.digest) {
    console.log('Publishing DIGEST episode (fresh script could not pass the audit today).');
  }
  const { script, audit } = finalOutcome;

  console.log('Step 4: Synthesizing audio (one call per segment)...');
  const segments = splitSegments(script);
  if (fs.existsSync(pcmFile)) fs.unlinkSync(pcmFile);
  // ~0.45s of silence between segments: concatenated TTS with no gaps is a
  // machine tell; human podcasts breathe between topics.
  const SILENCE = Buffer.alloc(Math.floor(24000 * 2 * 0.45));
  for (let i = 0; i < segments.length; i++) {
    console.log(`   -> Segment ${i + 1}/${segments.length}...`);
    const chunks = await synthesizeSegment(cfg, segments[i]);
    for (const chunk of chunks) {
      fs.appendFileSync(pcmFile, Buffer.from(chunk, 'base64'));
    }
    if (i < segments.length - 1) fs.appendFileSync(pcmFile, SILENCE);
  }
  if (!fs.existsSync(pcmFile)) throw new Error('No audio produced');

  console.log('Step 5: Mastering (loudness-normalized)...');
  execSync(
    `ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${pcmFile}" -af loudnorm=I=-16:TP=-1.5:LRA=11 -acodec libmp3lame -ab 128k "${filePath}"`
  );
  fs.unlinkSync(pcmFile);

  console.log('Step 6: Updating feed...');
  const audioBytes = fs.statSync(filePath).size;
  let durationSec: number | undefined;
  try {
    const out = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`).toString().trim();
    const parsed = parseFloat(out);
    if (Number.isFinite(parsed) && parsed > 0) durationSec = Math.round(parsed);
  } catch {
    console.log('WARNING: ffprobe duration lookup failed; feed will carry the target duration for this episode.');
  }

  const topStories = stories.map((s) => s.headline);
  episodes.unshift({
    id,
    date: new Date().toISOString(),
    title: finalOutcome.digest ? `${cfg.title} Digest — Week in Review` : topStories[0] || `${cfg.title} Briefing`,
    script,
    audioUrl: filename, // feed base already includes the rss dir
    topics: finalOutcome.digest ? [] : topStories,
    mainStories: finalOutcome.digest ? [] : topStories,
    status: finalOutcome.digest ? 'published-digest' : 'published',
    auditIssues: audit.issues,
    audioBytes,
    durationSec,
    digest: finalOutcome.digest || undefined,
  });

  // Backfill real sizes/durations for older episodes whose MP3s sit in this
  // directory, so the feed stops advertising length="0" / a fake duration.
  for (const e of episodes) {
    if (e.audioBytes && e.durationSec) continue;
    if (!e.audioUrl || e.audioUrl.startsWith('http')) continue; // legacy audio hosted elsewhere
    const p = path.join(rssDir, e.audioUrl);
    if (!fs.existsSync(p)) continue;
    try {
      if (!e.audioBytes) e.audioBytes = fs.statSync(p).size;
      if (!e.durationSec) {
        const out = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${p}"`).toString().trim();
        const parsed = parseFloat(out);
        if (Number.isFinite(parsed) && parsed > 0) e.durationSec = Math.round(parsed);
      }
    } catch {
      /* backfill is best-effort; never fail a broadcast over feed metadata */
    }
  }

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
