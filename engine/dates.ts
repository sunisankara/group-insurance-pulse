import { EpisodeRecord } from './types.js';

/** Calendar date (YYYY-MM-DD) of an instant in the show's home timezone. */
export function phoenixDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix' }).format(d);
}

/**
 * Idempotency guard: has this show already published an episode whose date
 * falls on today (Phoenix)? The watchdog and the external trigger re-dispatch
 * shows whose episodes look missing, and GitHub's own cron still fires hours
 * late — without this check, whichever run lands second would publish a
 * duplicate episode for the same day.
 */
export function publishedToday(episodes: EpisodeRecord[], now: Date = new Date()): boolean {
  const today = phoenixDate(now);
  return episodes.slice(0, 3).some((e) => {
    const t = new Date(e.date);
    return !Number.isNaN(t.getTime()) && phoenixDate(t) === today;
  });
}
