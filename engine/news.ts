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

function recentStoryCorpus(rssDir: string, episodes = 5): string[] {
  try {
    const epPath = path.join(process.cwd(), rssDir, 'episodes.json');
    if (!fs.existsSync(epPath)) return [];
    const eps = JSON.parse(fs.readFileSync(epPath, 'utf8'));
    return eps
      .slice(0, episodes)
      .map((e: any) => [e.title, ...(e.mainStories || [])].join(' '))
      .filter((s: string) => s.trim());
  } catch {
    return [];
  }
}

/** Exported so run.ts can hard-dedupe ranked stories against the same corpus. */
export function getRecentCorpus(rssDir: string): string[] {
  return recentStoryCorpus(rssDir, 5); // 5 weekday episodes ~= 7-day window
}

function recentTopics(rssDir: string): string {
  const r = recentStoryCorpus(rssDir, 5).join(' | ');
  return r ? `RECENTLY COVERED TOPICS (DO NOT REPEAT unless a major new development): ${r}` : '';
}

/** Generic industry words that must not count as "same story" evidence. */
const STOP = new Set(
  `a an the and or for with from that this will its are was were has have had been being into over under after before between during through about across per via among within without than then also as at by in of on to up
   insurance insurer insurers carrier carriers group health healthcare plan plans benefit benefits policy policies coverage market markets industry business company companies corporate
   announce announced announces announcement launch launched launches expand expands expansion report reported reports quarter quarterly earnings revenue revenues growth deal partnership platform digital technology tech data executive executives leadership appoints appointed named names chief officer officers board merger acquisition acquire acquires acquired sell sells sale stake billion million percent guidance outlook forecast update latest amid`.split(/\s+/)
);

function sigTokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter((t) => t.length >= 4 && !STOP.has(t))
  );
}

/**
 * Hard 7-day dedup: drop a story if it shares a distinctive token (len>=5)
 * AND at least 2 significant tokens with any recent story. This catches
 * "variation of the same story" rewrites (e.g. the Prudential repeat) while
 * letting genuinely different developments from the same company through,
 * and it never confuses two carriers' earnings reports.
 */
function isRepeat(headline: string, facts: string, corpus: string[]): boolean {
  const a = sigTokens(headline + ' ' + facts);
  if (a.size === 0) return false;
  return corpus.some((c) => {
    const b = sigTokens(c);
    const inter = [...a].filter((t) => b.has(t));
    const distinctive = inter.filter((t) => t.length >= 5);
    return inter.length >= 2 && distinctive.length >= 1;
  });
}

export function dedupeStories(stories: RankedStory[], recentCorpus: string[]): RankedStory[] {
  const kept: RankedStory[] = [];
  const seen = [...recentCorpus];
  for (const s of stories) {
    if (isRepeat(s.headline, s.facts, seen)) {
      console.log(`   x Dropped repeat: "${s.headline}"`);
      continue;
    }
    kept.push(s);
    seen.push(s.headline + ' ' + s.facts); // also dedupe within the episode
  }
  return kept;
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
IMPORTANT: return EXACTLY ${keep} ranked stories, no fewer. If fewer than ${keep} are strong, include the next-best candidates anyway (weakest last) — a short list is a failure.

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
  const stories = parseRanked(response.text || '');
  console.log(`   (ranker returned ${stories.length}/${keep} stories)`);
  return stories;
}

export function parseRanked(text: string): RankedStory[] {
  const stories: RankedStory[] = [];
  const blocks = text.split(/\[RANK\s*\d+\]/i).filter((b) => b.trim());
  blocks.forEach((block, i) => {
    const get = (label: string) => {
      const m = block.match(new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n[A-Z]+:|$)`, 'i'));
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
