import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { ShowConfig, RankedStory } from './types.js';

function ai() {
  return new GoogleGenAI({ apiKey: process.env.API_KEY });
}

async function withRetry<T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (retries <= 0) throw error;
    await new Promise((r) => setTimeout(r, delay));
    return withRetry(fn, retries - 1, delay * 2);
  }
}

/** Last-48h window as M/D strings, safe across month boundaries. */
export function newsWindow(now: Date = new Date()): { day1: string; day2: string } {
  const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  return { day1: fmt(yesterday), day2: fmt(now) };
}

function recentTopics(rssDir: string, count = 15): string {
  try {
    const epPath = path.join(process.cwd(), rssDir, 'episodes.json');
    if (!fs.existsSync(epPath)) return '';
    const eps = JSON.parse(fs.readFileSync(epPath, 'utf8'));
    const r = eps
      .slice(0, count)
      .map((e: any) => e.title + (e.mainStories ? ': ' + e.mainStories.join(', ') : ''))
      .join(' | ');
    return r ? `RECENTLY COVERED TOPICS (DO NOT REPEAT unless a major new development): ${r}` : '';
  } catch {
    return '';
  }
}

const dateString = (now: Date) =>
  now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

/**
 * Stage 1 — broad recall: pull 10-12 candidate stories so ranking has
 * something to choose from (the old prompt asked for 3-5 directly, which
 * is why major stories never bubbled up).
 */
export async function recallCandidates(cfg: ShowConfig): Promise<string> {
  const now = new Date();
  const { day1, day2 } = newsWindow(now);
  const prompt = `Act as a Senior Industry News Researcher.
TODAY'S DATE IS: ${dateString(now)}.
${recentTopics(cfg.rssDir)}

${cfg.newsDoc}

TASK: Research and list 10 to 12 candidate business developments from the LAST 48 HOURS (${day1} or ${day2}).
Cast a wide net across all the verticals and targets above — include M&A, regulatory moves, earnings signals, tech deployments, and distribution news. Prefer stories from major outlets and primary sources (company press releases, regulatory filings).

For each candidate provide:
- HEADLINE: [Title]
- DATE: [M/D published]
- SOURCE: [Outlet or primary source]
- FACTS: [Bullet points of numbers, companies, and "so what"]

RULES:
- Every story MUST be dated ${day1} or ${day2}. IGNORE anything older.
- Every story MUST include hard numbers (dollars, percentages, or dates) and specific company names.
- Do not repeat items from RECENTLY COVERED TOPICS unless there is a genuinely new development in the last 24 hours.`;

  const response = await withRetry(() =>
    ai().models.generateContent({
      model: cfg.textModel,
      contents: prompt,
      config: { tools: [{ googleSearch: {} }] },
    })
  );
  return response.text || '';
}

/**
 * Stage 2 — rank: score candidates on an explicit rubric and return the
 * top stories with an assigned analytical lens for each.
 */
export async function rankStories(cfg: ShowConfig, candidates: string, keep = 5): Promise<RankedStory[]> {
  const prompt = `You are the executive producer of "${cfg.title}", a daily briefing for senior industry leaders.

CANDIDATE STORIES (from the last 48h):
${candidates}

AVAILABLE ANALYTICAL LENSES:
${cfg.lensesDoc}

TASK: Rank the candidates and select the top ${keep} stories that matter MOST to senior leaders. Score each on:
1. P&L / business impact — does this move revenue, margin, or risk?
2. Strategic surprise — is this unexpected or a first-of-its-kind move?
3. Regulatory / policy weight — does it change the rules?
4. Breadth — does it affect many carriers / the whole market, not one niche player?

Drop incremental press-release fluff and vendor announcements with no hard numbers.

OUTPUT FORMAT — for each selected story, in rank order:
[RANK n]
HEADLINE: [Title]
FACTS: [2-4 bullets: numbers, companies, so-what]
CONTEXT: [Why this matters — 2-3 sentences for a senior leader]
LENS: [Exactly one lens name from the list above, the most revealing angle for this story]

Do not add any other text.`;

  const response = await withRetry(() =>
    ai().models.generateContent({
      model: cfg.textModel,
      contents: prompt,
      config: { temperature: 0.4, maxOutputTokens: 6000 },
    })
  );
  return parseRanked(response.text || '');
}

export function parseRanked(text: string): RankedStory[] {
  const stories: RankedStory[] = [];
  const blocks = text.split(/\[RANK\s*\d+\]/i).filter((b) => b.trim());
  blocks.forEach((block, i) => {
    const get = (label: string) => {
      const m = block.match(new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n[A-Z]+:|$)`, ''));
      return m ? m[1].trim() : '';
    };
    const headline = get('HEADLINE');
    if (!headline) return;
    stories.push({
      rank: i + 1,
      headline: headline.replace(/^\[|\]$/g, ''),
      facts: get('FACTS'),
      context: get('CONTEXT'),
      lens: get('LENS'),
      source: get('SOURCE'),
    });
  });
  return stories;
}
