
/**
 * HEADLESS BROADCASTER (v0.9.8)
 * Subfolder Delivery + Real-time Grounding + Auto-indexing
 */
import process from 'process';
import { fetchAINews, generatePodcastScript, generateSegmentAudio, generateEpisodeMetadata } from './services/gemini.ts';
import { generateRSSFeed } from './utils/rss.ts';
import { PodcastEpisode } from './types.ts';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { Buffer } from 'buffer';

const IS_TEST = process.env.IS_TEST === 'true';
const RSS_DIR = 'rss';
const DB_PATH = path.join(RSS_DIR, 'episodes.json');

async function run() {
  console.log('--- AI DAILY PULSE: CLOUD BROADCAST ENGINE v0.9.8 ---');
  console.log(`Current Working Dir: ${process.cwd()}`);
  
  if (!fs.existsSync(RSS_DIR)) {
    console.log(`[INFO] Creating station directory: ${RSS_DIR}`);
    fs.mkdirSync(RSS_DIR, { recursive: true });
  }

  const id = Date.now().toString();
  const filename = `AI-Pulse-${id}.mp3`;
  const filePath = path.join(RSS_DIR, filename);
  const pcmFile = `temp-${id}.pcm`;

  try {
    let script = "";
    let report: any = null;
    let title = "";

    if (IS_TEST) {
      console.log('[DIAGNOSTIC] Producing 1-second sine test...');
      execSync(`ffmpeg -f lavfi -i "sine=frequency=440:duration=1" -acodec libmp3lame -ab 128k ${filePath}`);
      script = "Diagnostic Heartbeat Successful.";
      report = { topStories: ["System Check"] };
      title = "System Diagnostic: Automated Verification of Cloud Infrastructure";
    } else {
      console.log('Step 1: Intelligence Gathering...');
      report = await fetchAINews();
      console.log('Step 2: Scripting...');
      script = await generatePodcastScript(report.newsText);
      console.log('Step 3: Metadata Synthesis...');
      //title = await generateEpisodeMetadata(report.newsText);
      title = report.topStories[0] || "Healthcare Daily Pulse: Breaking News and Analysis";

      console.log('Step 4: Voice Production...');
      const segments = script.split('[TRANSITION]').filter(s => s.trim().length > 5);
      if (fs.existsSync(pcmFile)) fs.unlinkSync(pcmFile);

      for (let i = 0; i < segments.length; i++) {
        console.log(`   -> Segment ${i+1}/${segments.length}...`);
        const chunks = await generateSegmentAudio(segments[i]);
        for (const chunk of chunks) {
          fs.appendFileSync(pcmFile, Buffer.from(chunk, 'base64'));
        }
      }
      
      console.log('Step 5: Mastering Audio...');
      if (fs.existsSync(pcmFile)) {
        execSync(`ffmpeg -y -f s16le -ar 24000 -ac 1 -i ${pcmFile} -acodec libmp3lame -ab 128k ${filePath}`);
        fs.unlinkSync(pcmFile);
      } else {
        throw new Error("Audio production failed: PCM buffer empty.");
      }
    }

    // Step 6: Load History
    let episodes: PodcastEpisode[] = [];
    if (fs.existsSync(DB_PATH)) {
      console.log(`[DB] Loading existing history from ${DB_PATH}`);
      try {
        episodes = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
        console.log(`[DB] Loaded ${episodes.length} existing episodes.`);
      } catch (e) {
        console.log(`[WARN] Database corrupted or empty. Starting fresh.`);
      }
    } else {
      console.log(`[DB] No existing database found. Initializing history.`);
    }

    // Add current run to the START of the array
    const newEpisode: PodcastEpisode = {
      id: id,
      date: new Date().toISOString(),
      title: title,
      script: script,
      audioUrl: filename,
      topics: report.topStories,
      mainStories: report.topStories,
      status: 'published'
    };
    episodes.unshift(newEpisode);

    // Auto-Discovery for orphaned files
    const files = fs.readdirSync(RSS_DIR);
    for (const file of files.filter(f => f.endsWith('.mp3'))) {
      if (!episodes.find(e => e.audioUrl === file)) {
        console.log(`[SYNC] Discovering archived file: ${file}`);
        const stats = fs.statSync(path.join(RSS_DIR, file));
        episodes.push({
          id: `archive-${file}`,
          date: stats.birthtime.toISOString(),
          title: `Archived Broadcast: ${file}`,
          script: "Summary unavailable for archived content.",
          audioUrl: file,
          topics: ["Archive"],
          mainStories: ["Restored from station backups"],
          status: 'published'
        });
      }
    }

    // Save persistent DB
    fs.writeFileSync(DB_PATH, JSON.stringify(episodes, null, 2));
    console.log(`[DB] Database updated with ${episodes.length} total entries.`);

    const repoPath = process.env.GITHUB_REPOSITORY || 'owner/repo';
    const [owner, repoName] = repoPath.split('/');
    const baseUrl = `https://${owner}.github.io/${repoName}`;

    console.log(`Step 7: Rebuilding RSS Feed...`);
    // Pass the ENTIRE episodes array so the feed has history
    const rssContent = generateRSSFeed(episodes, `${baseUrl}/rss`); 
    fs.writeFileSync(path.join(RSS_DIR, 'feed.xml'), rssContent);
    
    console.log('--- BROADCAST COMPLETE: REPOSITORY READY FOR COMMIT ---');
  } catch (error: any) {
    console.error('--- ENGINE ERROR ---');
    console.error(error.message);
    if (typeof process !== 'undefined' && process.exit) {
      process.exit(1);
    }
  }
}

run();
