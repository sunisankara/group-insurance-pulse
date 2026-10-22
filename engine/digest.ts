import { ShowConfig, EpisodeRecord } from './types.js';
import { conversationRules, generateText } from './script.js';

/**
 * Digest fallback. If the day's fresh script fails the audit three times,
 * run.ts tries a digest episode — the hosts look back at the last few
 * episodes, recap the stories that mattered, and flag what to watch next —
 * before skipping the day entirely (a missing day is the last resort, a
 * broken stub episode is never acceptable).
 *
 * The digest is built ONLY from previous episodes' own material (their
 * stored scripts), so it needs no news pipeline and cannot invent facts:
 * the prompt forbids claiming any development beyond what was covered.
 */

export interface DigestMaterial {
  episodes: EpisodeRecord[];
  block: string;
}

export function buildDigestMaterial(recent: EpisodeRecord[], maxEpisodes = 4): DigestMaterial | null {
  const sources = recent.filter((e) => !e.digest && e.script && e.script.trim().length > 200).slice(0, maxEpisodes);
  if (sources.length < 2) return null; // not enough history to recap honestly

  const block = sources
    .map((e) => {
      const day = new Date(e.date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
      // Head + tail of the original script: the stories covered and the
      // positions the hosts landed on, without blowing the prompt budget.
      const script = e.script;
      const excerpt = script.length > 4200 ? `${script.slice(0, 2600)}\n[...]\n${script.slice(-1400)}` : script;
      return `=== EPISODE FROM ${day} — lead: ${e.title} ===
Stories covered: ${(e.mainStories || []).join('; ') || e.title}
Script excerpt:
${excerpt}`;
    })
    .join('\n\n');

  return { episodes: sources, block };
}

export async function generateDigestScript(
  cfg: ShowConfig,
  material: DigestMaterial,
  feedbackPrompt?: string
): Promise<string> {
  const targetWords = cfg.targetMinutes * cfg.wordsPerMinute;
  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const feedbackSection = feedbackPrompt
    ? `\n\nFEEDBACK FROM A FAILED ATTEMPT — apply it strictly:\n${feedbackPrompt}\n`
    : '';

  const prompt = `Write a ${cfg.targetMinutes}-minute conversational podcast script for "${cfg.title}" (${dateStr} edition).

This is a DIGEST episode — a look back over the last few episodes. Open by framing it plainly as a catch-up edition ("a look back at the stories that have been driving the week") — do NOT explain production reasons, and do NOT pretend these stories are today's news.

TARGET LENGTH: ~${targetWords} words of dialogue. Hit the target; a script that stops early is a failed script.

HOSTS — fully-realized characters, voiced distinctly:
${cfg.hostsDoc}

${conversationRules(cfg)}
- Structure: a short framing intro, then one segment per source episode below (put [TRANSITION] on its own line between segments). In each segment, the hosts recap the 1-2 stories from that episode that mattered most, argue about what they mean with a few days' distance, and land on what to watch next.
- STRICT: only use facts, companies, and numbers from the source material below. Do not invent ANY new development, outcome, or number — you do not know what happened after those episodes aired. Forward-looking lines must be framed as "what to watch", never as reported fact.
- The hosts may reference their own earlier takes ("you called this a reserving problem on Tuesday") — that's the point of a look back.

SOURCE MATERIAL (the show's own recent episodes):
${material.block}
${feedbackSection}`;

  return generateText(cfg, prompt);
}
