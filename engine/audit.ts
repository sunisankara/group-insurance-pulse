import { ShowConfig, AuditResult } from './types.js';
import { splitSegments } from './script.js';

/**
 * Text-based quality audit. The old audit uploaded the entire finished MP3
 * to Gemini twice per episode (voice-consistency + repeat detection) — pure
 * API spend that fixed nothing. All checks here run on the script text.
 */
export function auditScript(cfg: ShowConfig, script: string): AuditResult {
  const issues: string[] = [];
  const segments = splitSegments(script);
  const hostNames = cfg.hosts.map((h) => h.name);

  // 1. Duration estimate from word count (±20% tolerance on the estimate)
  const words = script.split(/\s+/).filter(Boolean).length;
  const estMinutes = words / cfg.wordsPerMinute;
  const [lo, hi] = [cfg.targetMinutes - 3, cfg.targetMinutes + 3];
  if (estMinutes < lo || estMinutes > hi) {
    issues.push(
      `Estimated duration ${estMinutes.toFixed(1)} min (from ~${words} words) is outside the ${lo}-${hi} min band`
    );
  }

  // 2. Speaker labels: every dialogue line must start with a known host
  const badLines = script
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 10 && !l.startsWith('['))
    .filter((l) => !hostNames.some((n) => l.startsWith(`${n}:`)));
  if (badLines.length > 0) {
    issues.push(`${badLines.length} dialogue lines missing a valid speaker label (e.g. "${hostNames[0]}:")`);
  }

  // 3. Both hosts actually speak in every segment
  segments.forEach((seg, i) => {
    const missing = hostNames.filter((n) => !seg.includes(`${n}:`));
    if (missing.length > 0) {
      issues.push(`Segment ${i + 1} has no lines from ${missing.join(', ')}`);
    }
  });

  // 4. Repeat detection: identical 8-word phrases recurring across DIFFERENT
  // segments (a story or riff accidentally generated twice). Within-segment
  // repetition of a turn of phrase is stylistic, not a defect.
  const phraseSegments = new Map<string, Set<number>>();
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  segments.forEach((seg, si) => {
    const w = norm(seg).split(' ');
    for (let i = 0; i + 8 <= w.length; i++) {
      const gram = w.slice(i, i + 8).join(' ');
      if (!phraseSegments.has(gram)) phraseSegments.set(gram, new Set());
      phraseSegments.get(gram)!.add(si);
    }
  });
  const repeats = [...phraseSegments.values()].filter((s) => s.size > 1).length;
  if (repeats > 2) {
    issues.push(`Detected ${repeats} phrases repeated across different segments — possible duplicated story`);
  }

  // 5. Headlines: each segment should open with a headline-ish line
  segments.forEach((seg, i) => {
    const first = seg.split('\n').find((l) => l.trim().length > 20);
    if (first && first.length > 220) {
      issues.push(`Segment ${i + 1} jumps into detail without a headline opener`);
    }
  });

  const feedbackPrompt =
    issues.length > 0
      ? `AUDIT FEEDBACK — fix every issue below in the regenerated script:\n- ${issues.join('\n- ')}`
      : undefined;

  return { passed: issues.length === 0, issues, feedbackPrompt, estimatedMinutes: estMinutes };
}
