#!/usr/bin/env node
/**
 * Keep only the newest N mp3s per feed directory so the repo stops growing
 * ~20MB/day. Spotify already caches published episodes; the RSS feed keeps
 * its full item history in feed.xml regardless.
 *
 * Usage: node scripts/prune-audio.mjs --keep 30
 */
import fs from 'fs';
import path from 'path';

const keepArg = process.argv.indexOf('--keep');
const KEEP = keepArg !== -1 ? parseInt(process.argv[keepArg + 1], 10) : 30;

function pruneDir(dir) {
  if (!fs.existsSync(dir)) return;
  const mp3s = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.mp3'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const stale = mp3s.slice(KEEP);
  for (const { f } of stale) {
    fs.unlinkSync(path.join(dir, f));
    console.log(`pruned ${path.join(dir, f)}`);
  }
  // never delete temp files here — but warn loudly if any exist
  const temps = fs.readdirSync(dir).filter((f) => f.startsWith('temp-') && f.endsWith('.pcm'));
  for (const t of temps) console.warn(`WARNING: leftover temp file ${path.join(dir, t)} (git-ignored, not committed)`);
}

// group-insurance feed lives at rss/ (legacy path), healthcare at rss/healthcare/
pruneDir(path.join(process.cwd(), 'rss'));
pruneDir(path.join(process.cwd(), 'rss', 'healthcare'));
console.log(`prune complete (keeping ${KEEP} newest mp3s per feed)`);
