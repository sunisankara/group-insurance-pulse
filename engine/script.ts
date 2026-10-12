import { GoogleGenAI } from '@google/genai';
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

const COLD_OPENS = [
  'a striking number from the day’s biggest story, then react to it',
  'a one-sentence provocation about what the industry got wrong this week',
  'a quick contrast between two of today’s stories that point in opposite directions',
  'a question a CEO would ask about this morning’s headlines',
  'a brief anecdote from the field that connects to the top story',
];

function storiesBlock(stories: RankedStory[]): string {
  return stories
    .map(
      (s) => `STORY ${s.rank} (lens: ${s.lens || 'general'}):
HEADLINE: ${s.headline}
FACTS: ${s.facts}
CONTEXT: ${s.context}`
    )
    .join('\n\n');
}

/**
 * Generate the episode script. Hosts are defined by their character bibles
 * (shows/<id>/hosts.md); each story carries an assigned lens and the hosts
 * argue that story from the lens perspective — this is what breaks the
 * "same two lenses every day" pattern while keeping the duo format.
 */
export async function generateScript(
  cfg: ShowConfig,
  stories: RankedStory[],
  feedbackPrompt?: string
): Promise<string> {
  const [h1, h2] = cfg.hosts;
  const targetWords = cfg.targetMinutes * cfg.wordsPerMinute;
  const open = COLD_OPENS[Math.floor(Math.random() * COLD_OPENS.length)];
  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const feedbackSection = feedbackPrompt
    ? `\n\nFEEDBACK FROM A FAILED ATTEMPT — apply it strictly:\n${feedbackPrompt}\n`
    : '';

  const prompt = `Write a ${cfg.targetMinutes}-minute conversational podcast script for "${cfg.title}" (${dateStr} edition).

TARGET LENGTH: ~${targetWords} words of dialogue.

HOSTS — these are fully-realized characters. Voice them distinctly; they must NOT sound interchangeable:
${cfg.hostsDoc}

CONVERSATION RULES:
- Every line starts with the speaker's name and a colon, e.g. "${h1.name}: ..." — never deviate, never drop the label.
- The two hosts genuinely disagree sometimes. Let them interrupt, push back, concede points, and land somewhere interesting. No both-sides mush.
- Vary the rhythm: short punchy exchanges for fast news, longer analytical stretches for the big story.
- Cold open: ${open}. Then a one-line show greeting naming the date.
- Between stories, put [TRANSITION] on its own line.
- Close with a 2-3 line sign-off that ties the day together — vary it, never the same sign-off twice.
- STRICT: only use the stories below. Do not invent stories, companies, or numbers.

STORIES (each has an assigned analytical lens — argue that story primarily through that lens):
${storiesBlock(stories)}
${feedbackSection}`;

  const response = await withRetry(() =>
    ai().models.generateContent({
      model: cfg.textModel,
      contents: prompt,
      config: { maxOutputTokens: 9000, temperature: 0.75 },
    })
  );
  return response.text || '';
}

/** Split a full script into per-story segments on [TRANSITION]. */
export function splitSegments(script: string): string[] {
  return script
    .split('[TRANSITION]')
    .map((s) => s.trim())
    .filter((s) => s.length > 5);
}

/**
 * Further split an oversized segment only at speaker-turn boundaries so a
 * voice never changes mid-thought. Keeps speaker labels on every piece.
 */
export function splitOversizedSegment(segment: string, hostNames: string[], maxChars = 4500): string[] {
  if (segment.length <= maxChars) return [segment];
  const labelRe = new RegExp(`\\n(?=${hostNames.map(escapeRe).join('|')}:)`, 'g');
  const turns = segment.split(labelRe);
  const pieces: string[] = [];
  let current = '';
  for (const turn of turns) {
    if ((current + '\n' + turn).length > maxChars && current) {
      pieces.push(current.trim());
      current = turn;
    } else {
      current = current ? current + '\n' + turn : turn;
    }
  }
  if (current.trim()) pieces.push(current.trim());
  return pieces.length ? pieces : [segment];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
