
/**
 * GROUP INSURANCE BROADCAST ENGINE (v1.0.0)
 */
import process from 'process';
import { fetchAINews, generatePodcastScript, generateSegmentAudio } from './services/gemini.ts';
import { generateRSSFeed } from './utils/rss.ts';
import { PodcastEpisode } from './types.ts';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { Buffer } from 'buffer';

const IS_DRY_RUN = process.env.IS_DRY_RUN === 'true';
const RSS_DIR = 'rss';
const DB_PATH = path.join(RSS_DIR, 'episodes.json');

async function run() {
  console.log('--- GROUP INSURANCE DAILY PULSE: CLOUD BROADCAST ENGINE ---');
  
  if (!fs.existsSync(RSS_DIR)) {
    fs.mkdirSync(RSS_DIR, { recursive: true });
  }

  const id = Date.now().toString();
  const filename = `Group-Pulse-${id}.mp3`;
  const filePath = path.join(RSS_DIR, filename);
  const pcmFile = `temp-${id}.pcm`;

  try {
    console.log('Step 1: Intelligence Gathering (Group Insurance Verticals)...');
    const report = await fetchAINews();
    
    console.log('Step 2: Scripting (Aria vs Dorian)...');
    const script = await generatePodcastScript(report.newsText);
    
    if (IS_DRY_RUN) {
      console.log('--- DRY RUN: SCRIPT GENERATED ---');
      console.log(script);
      console.log('---------------------------------');
      return;
    }

    console.log('Step 3: Voice Production (Aria: Kore, Dorian: Puck)...');
    const segments = script.split('[TRANSITION]').filter(s => s.trim().length > 5);
    if (fs.existsSync(pcmFile)) fs.unlinkSync(pcmFile);

    for (let i = 0; i < segments.length; i++) {
      console.log(`   -> Segment ${i+1}/${segments.length}...`);
      const chunks = await generateSegmentAudio(segments[i]);
      for (const chunk of chunks) {
        fs.appendFileSync(pcmFile, Buffer.from(chunk, 'base64'));
      }
    }
    
    console.log('Step 4: Mastering Audio...');
    if (fs.existsSync(pcmFile)) {
      execSync(`ffmpeg -y -f s16le -ar 24000 -ac 1 -i ${pcmFile} -acodec libmp3lame -ab 128k ${filePath}`);
      fs.unlinkSync(pcmFile);
    }

    // Update DB
    let episodes: PodcastEpisode[] = fs.existsSync(DB_PATH) ? JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) : [];
    const newEpisode: PodcastEpisode = {
      id: id,
      date: new Date().toISOString(),
      title: report.topStories[0] || "Group Insurance Daily Briefing",
      script: script,
      audioUrl: filename,
      topics: report.topStories,
      mainStories: report.topStories,
      status: 'published'
    };
    episodes.unshift(newEpisode);
    fs.writeFileSync(DB_PATH, JSON.stringify(episodes, null, 2));

    const repoPath = process.env.GITHUB_REPOSITORY || 'owner/repo';
    const [owner, repoName] = repoPath.split('/');
    const baseUrl = `https://${owner}.github.io/${repoName}`;

    console.log(`Step 5: Rebuilding RSS Feed...`);
    const rssContent = generateRSSFeed(episodes, `${baseUrl}/rss`); 
    fs.writeFileSync(path.join(RSS_DIR, 'feed.xml'), rssContent);
    
    console.log('--- BROADCAST COMPLETE ---');
  } catch (error: any) {
    console.error('--- ENGINE ERROR ---', error.message);
  }
}

run();
