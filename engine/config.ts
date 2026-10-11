import fs from 'fs';
import path from 'path';
import { parse } from 'yaml';
import { ShowConfig } from './types.js';

export function loadShowConfig(showId: string, repoRoot: string = process.cwd()): ShowConfig {
  const showDir = path.join(repoRoot, 'shows', showId);
  const yamlPath = path.join(showDir, 'show.yaml');
  if (!fs.existsSync(yamlPath)) {
    throw new Error(`Unknown show '${showId}': ${yamlPath} not found`);
  }
  const raw = parse(fs.readFileSync(yamlPath, 'utf8'));

  const readDoc = (name: string) => {
    const p = path.join(showDir, name);
    if (!fs.existsSync(p)) throw new Error(`Missing ${name} for show '${showId}'`);
    return fs.readFileSync(p, 'utf8');
  };

  if (!raw.hosts || raw.hosts.length !== 2) {
    throw new Error(`show.yaml for '${showId}' must define exactly 2 hosts`);
  }
  const voices = raw.hosts.map((h: any) => h.voice);
  if (new Set(voices).size !== 2) {
    throw new Error(`show.yaml for '${showId}': the two hosts must use different voices`);
  }

  return {
    id: showId,
    title: raw.title,
    feedTitle: raw.feedTitle || raw.title,
    author: raw.author,
    email: raw.email,
    summary: raw.summary,
    description: raw.description,
    categories: raw.categories || [],
    coverFile: raw.coverFile || 'cover.jpg',
    language: raw.language || 'en-us',
    hosts: raw.hosts,
    ttsModel: raw.ttsModel || 'gemini-2.5-flash-preview-tts',
    textModel: raw.textModel || 'gemini-2.5-flash',
    targetMinutes: raw.targetMinutes || 15,
    wordsPerMinute: raw.wordsPerMinute || 150,
    rssDir: raw.rssDir,
    scheduleCron: raw.scheduleCron || '',
    hostsDoc: readDoc('hosts.md'),
    lensesDoc: readDoc('lenses.md'),
    newsDoc: readDoc('news.md'),
  };
}

export function listShows(repoRoot: string = process.cwd()): string[] {
  const dir = path.join(repoRoot, 'shows');
  return fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory());
}
