import { EpisodeRecord } from './types.js';

/**
 * Encore fallback — the terminal guarantee that a weekday is never skipped.
 *
 * Fresh scripts need the text API; digest scripts need it too. So when the
 * whole text pipeline is down (the Nov 3-4, 2026 outage: the Gemini
 * project's prepayment credits hit zero and both shows died in Step 1),
 * neither fallback can save the day. The encore can: it republishes the
 * audio of an older episode under an honest "Encore" title, using zero API
 * calls — just a file copy and a feed update.
 *
 * Rules: the source must be a real episode (not a digest, not a previous
 * encore), at least MIN_AGE_DAYS old so listeners are not re-hearing last
 * week, and a given source can only be encored once.
 */

export const ENCORE_MIN_AGE_DAYS = 10;

export function pickEncoreSource(episodes: EpisodeRecord[], now: Date = new Date()): EpisodeRecord | null {
  const encoredIds = new Set(
    episodes.map((e) => e.encoreOf).filter((x): x is string => Boolean(x))
  );
  const minAgeMs = ENCORE_MIN_AGE_DAYS * 24 * 60 * 60 * 1000;
  // Episodes are stored newest-first: scan from the back (oldest) forward
  // so the deepest suitable archive episode is used first.
  for (let i = episodes.length - 1; i >= 0; i--) {
    const e = episodes[i];
    if (e.digest) continue;
    if (e.encoreOf) continue;
    if (!e.audioUrl || e.audioUrl.startsWith('http')) continue; // legacy audio hosted elsewhere
    if (encoredIds.has(e.id)) continue;
    const t = new Date(e.date).getTime();
    if (Number.isNaN(t) || now.getTime() - t < minAgeMs) continue;
    return e;
  }
  return null;
}
