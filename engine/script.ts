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
  'one host mid-thought, reacting to a headline they just read — no preamble',
  'a listener’s likely objection to the top story, voiced out loud',
  'the second host challenging the first host’s take from yesterday',
];

/** Episode shapes rotate daily so no two days have the same skeleton. */
const EPISODE_SHAPES = [
  'CLASSIC RUNDOWN: cold open, then work through the stories in rank order, roughly equal time each.',
  'DEEP DIVE: spend about half the episode on story 1 — history, stakes, disagreement — then cover the remaining stories as tight briefs.',
  'DEBATE-LED: open with the hosts openly disagreeing about the biggest story and stay in that argument a while before moving on; the other stories get brisk treatment.',
  'COUNTDOWN: run the stories in REVERSE rank order, saving the biggest story for the final segment.',
  'LIGHTNING + ONE BIG: rapid-fire quick hits on every story but the biggest (a few exchanges each), then one long, slow segment on the biggest story.',
];

function pickByDay<T>(arr: T[]): T {
  const now = new Date();
  const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000);
  return arr[dayOfYear % arr.length];
}

/**
 * The conversation rules shared by fresh episodes and digest episodes.
 * This is the humanization layer: real conversation has uneven turn
 * lengths, interruptions, callbacks, and committed opinions — essays
 * read aloud do not sound like a podcast.
 */
export function conversationRules(cfg: ShowConfig): string {
  const [h1] = cfg.hosts;
  return `CONVERSATION RULES — this must sound like two people talking, not an essay read aloud:
- Every line starts with the speaker's name and a colon, e.g. "${h1.name}: ..." — never deviate, never drop the label. No markdown anywhere (no **, no ##, no bullet lists). The only bracketed tag allowed is [TRANSITION] on its own line between story segments.
- Headlines are SPOKEN as dialogue lines ("${h1.name}: Headline — ..."), never bare "HEADLINE:" lines.
- VARY TURN LENGTH HARD. Mix long analytical turns with very short ones — one-line reactions ("Wait — seriously?", "Hmm.", "That can't hold."), quick agreements, genuine questions. At least a quarter of the turns should be under 15 words. Real conversation is lumpy; if every turn is a polished paragraph, it sounds generated.
- Interruptions happen. Occasionally a turn ends mid-thought with "—" and the other host jumps in; the interrupted point may never get finished. Use sparingly — two or three per episode.
- Contractions always. Spoken connectors are fine ("look,", "I mean,", "here's the thing") — sparingly, not as a tic.
- Each host commits to at least one falsifiable take per episode ("this closes by Q2", "that growth number is borrowing from next year"). No both-sides mush, no hedging every claim into fog.
- NEVER use these phrases: "delve", "moreover", "furthermore", "it's important to note", "in conclusion", "ever-evolving", "in today's fast-paced", "navigate the complexities". Do not frame with "on one hand ... on the other hand".
- Numbers get said the way people say them, with units, and hosts react to them before analysing them.
- Close with a 2-3 line sign-off that ties the day together, spoken by both hosts. The sign-off is the literal end of the script — nothing after it, and the final line ends with a period. The closing MUST include the words "thanks for listening" (work them in naturally, e.g. "That's the pulse for today — thanks for listening."). Vary the rest of the sign-off wording; never reuse yesterday's.`;
}

export interface ContinuityContext {
  /** Story headlines covered on the previous episode. */
  previousStories: string[];
  /** Tail of the previous episode's script (closing exchanges). */
  previousTail: string;
}

function continuityBlock(ctx?: ContinuityContext): string {
  if (!ctx || (ctx.previousStories.length === 0 && !ctx.previousTail)) return '';
  return `\n\nCONTINUITY — yesterday's episode covered: ${ctx.previousStories.join('; ') || '(none)'}.
Here is how yesterday's episode ended (for tone and positions — do NOT read this aloud or recap it):
"""${ctx.previousTail}"""
The hosts remember yesterday. At most ONE brief callback today — a host noting they were right or wrong, or following up a position — and only if it fits naturally. Never force it, never recap yesterday's show at length.`;
}

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
 * One text-generation call with thinking disabled. Gemini 2.5 Flash spends
 * part of maxOutputTokens on hidden "thinking" tokens by default, which is
 * what silently truncated scripts mid-sentence in October 2026 (episodes
 * ending mid-thought at unpredictable lengths). thinkingBudget: 0 turns it
 * off for this structured writing task, and the finishReason is checked so
 * a truncated response is a hard error, never a publishable script.
 */
export async function generateText(cfg: ShowConfig, prompt: string): Promise<string> {
  const response = await withRetry(() =>
    ai().models.generateContent({
      model: cfg.textModel,
      contents: prompt,
      config: {
        maxOutputTokens: 12000,
        temperature: 0.8,
        thinkingConfig: { thinkingBudget: 0 },
      },
    })
  );
  const finish = String(response.candidates?.[0]?.finishReason || '');
  if (finish && finish !== 'STOP') {
    throw new Error(`Text generation ended abnormally (finishReason=${finish}) — treating as failed attempt`);
  }
  const text = response.text || '';
  if (!text.trim()) throw new Error('Text generation returned empty output');
  return text;
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
  feedbackPrompt?: string,
  continuity?: ContinuityContext
): Promise<string> {
  const targetWords = cfg.targetMinutes * cfg.wordsPerMinute;
  const open = pickByDay(COLD_OPENS);
  const shape = pickByDay(EPISODE_SHAPES);
  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const feedbackSection = feedbackPrompt
    ? `\n\nFEEDBACK FROM A FAILED ATTEMPT — apply it strictly:\n${feedbackPrompt}\n`
    : '';

  // On thin-news days the dedup may leave only 2-3 stories; without an
  // explicit depth push the model wraps up at ~1,500 words and fails the
  // duration band (a root cause of the Oct 26-30 Group Insurance outage).
  const depthNote =
    stories.length <= 3
      ? `\n\nNOTE: only ${stories.length} stories today — go DEEPER on each one (history, stakes, the strongest disagreement between you, what to watch next) to reach the full target length. Depth, not padding: never invent facts, companies, or numbers beyond the stories below.`
      : '';

  const prompt = `Write a ${cfg.targetMinutes}-minute conversational podcast script for "${cfg.title}" (${dateStr} edition).

TARGET LENGTH: ~${targetWords} words of dialogue. Hit the target — a script that runs short or stops early is a failed script. Pace yourself across all the stories so the last story gets as much room as the first.

EPISODE SHAPE TODAY: ${shape}

HOSTS — these are fully-realized characters. Voice them distinctly; they must NOT sound interchangeable:
${cfg.hostsDoc}

${conversationRules(cfg)}
- Cold open: ${open}. Then a one-line show greeting naming the date.
- Each story segment MUST open with its headline stated plainly in a spoken dialogue line (so a listener knows what the story is) before any analysis or banter.
- Between stories, put [TRANSITION] on its own line.
- STRICT: only use the stories below. Do not invent stories, companies, or numbers.
${continuityBlock(continuity)}
STORIES (each has an assigned analytical lens — argue that story primarily through that lens):
${storiesBlock(stories)}${depthNote}
${feedbackSection}`;

  return generateText(cfg, prompt);
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
