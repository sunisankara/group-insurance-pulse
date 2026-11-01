import { ShowConfig, AuditResult } from './types.js';
import { splitSegments } from './script.js';

/**
 * Text-based quality audit. The old audit uploaded the entire finished MP3
 * to Gemini twice per episode (voice-consistency + repeat detection) — pure
 * API spend that fixed nothing. All checks here run on the script text.
 *
 * Since Oct 2026 this audit is a HARD GATE: run.ts no longer publishes a
 * script that fails. The completeness checks (6) exist because truncated
 * scripts — ending mid-sentence with no sign-off — repeatedly reached the
 * feed before anyone listened to them.
 */

/** Phrases real hosts don't say on air; their presence marks generated filler. */
const AI_TELLS: Array<[RegExp, string]> = [
  [/\bdelve\b/i, 'delve'],
  [/\bmoreover\b/i, 'moreover'],
  [/\bfurthermore\b/i, 'furthermore'],
  [/it'?s important to note/i, "it's important to note"],
  [/\bin conclusion\b/i, 'in conclusion'],
  [/ever-evolving/i, 'ever-evolving'],
  [/fast-paced/i, 'fast-paced'],
  [/navigate the complexities/i, 'navigate the complexities'],
  [/\bon one hand\b/i, 'on one hand (symmetrical framing)'],
];

/**
 * Signature host devices that become tics when repeated across episodes —
 * e.g. Dorian's "I was in a room..." field anecdote, which his character
 * bible accidentally prescribed as his default opener. A device may appear
 * today OR in a recent episode, not in both.
 */
const SIGNATURE_FRAMES: Array<[RegExp, string]> = [
  [/\bi was (just |sitting )?in (a|the|that) room\b|\bi'?ve been in those rooms\b|\bsat in (a|that) room\b|\bin the room (when|where)\b/i, '"I was in the room" field anecdote'],
  [/\bi was (just )?talking to a (friend|broker|client|colleague)\b/i, '"I was talking to a friend" anecdote'],
  [/\bmed-surg floor\b/i, '"on a med-surg floor" scene-setter'],
  [/\bstood in (an?|the) (ED|emergency)\b/i, '"stood in the ED" scene-setter'],
];

const SIGN_OFF_RES: RegExp[] = [
  /thanks for (joining|listening)/,
  /thank you for (joining|listening)/,
  /we'?ll be back/,
  /we will be back/,
  /we'?ll see you/,
  /see you (tomorrow|next)/,
  /until (tomorrow|next time)/,
  /that'?s all the time we have/,
  /join us tomorrow/,
  /back tomorrow/,
  /catch you tomorrow/,
  /we'?ll catch you/,
  /have a great (weekend|day)/,
  /stay informed/,
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function ngrams(text: string, n: number): Set<string> {
  const w = norm(text).split(' ').filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
}

export function auditScript(
  cfg: ShowConfig,
  script: string,
  recentScripts: string[] = [],
  opts: { digest?: boolean } = {}
): AuditResult {
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
  segments.forEach((seg, si) => {
    for (const gram of ngrams(seg, 8)) {
      if (!phraseSegments.has(gram)) phraseSegments.set(gram, new Set());
      phraseSegments.get(gram)!.add(si);
    }
  });
  const repeats = [...phraseSegments.values()].filter((s) => s.size > 1).length;
  if (repeats > 2) {
    issues.push(`Detected ${repeats} phrases repeated across different segments — possible duplicated story`);
  }

  // 5. Headlines: later segments should open with a headline-ish line, not a
  // wall of detail. Segment 1 is exempt (cold open + banter come first), and
  // the bar is set at genuine rambles — a long first turn that states its
  // headline is fine on air.
  segments.forEach((seg, i) => {
    if (i === 0) return;
    const first = seg.split('\n').find((l) => l.trim().length > 20);
    if (first && first.length > 400) {
      issues.push(`Segment ${i + 1} jumps into detail without a headline opener`);
    }
  });

  // 6. Completeness — the truncated-episode guard. A finished script ends
  // with a real sign-off and terminal punctuation; a generation that was
  // cut off mid-thought ends mid-sentence, and must never reach TTS.
  const nonEmptyLines = script.split('\n').map((l) => l.trim()).filter(Boolean);
  const lastLine = nonEmptyLines[nonEmptyLines.length - 1] || '';
  if (!/[.!?…]["'”’)]?$/.test(lastLine)) {
    issues.push('Script does not end with terminal punctuation — it appears truncated mid-sentence');
  }
  const lastSegment = (segments[segments.length - 1] || '').toLowerCase();
  // Sign-offs take many natural shapes, including the classic radio
  // name-check close ("For Group Insurance Daily Pulse, I'm Aria").
  const nameCheck = new RegExp(`\\bi'?m (${hostNames.map((n) => n.toLowerCase()).join('|')})\\b`);
  const hasSignOff = (text: string) => SIGN_OFF_RES.some((re) => re.test(text)) || nameCheck.test(text);
  // Check the final segment; if the model adds one short closing line after
  // the sign-off (splitting it into its own segment), also accept a sign-off
  // inside the script's last ~400 characters — it is still effectively the
  // end of the episode. Truncation stays guarded by the terminal-punctuation
  // check above and the finishReason check in generateText.
  if (!hasSignOff(lastSegment) && !hasSignOff(script.slice(-400).toLowerCase())) {
    issues.push('Final segment has no sign-off (thanks/closing line) — the episode would end abruptly');
  }
  // Inline **bold** around a spoken headline is cosmetic (stripped before
  // TTS in voices.ts); what breaks the format is markdown STRUCTURE — a
  // bare headline/header line with no speaker (also caught by check 2).
  const structuralMd = script
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^#{1,3}\s/.test(l) || /^\*\*[^a-z]+:/.test(l));
  if (structuralMd.length > 0) {
    issues.push('Script contains markdown structure lines (## headers or bare **HEADLINE:** lines) — headlines are spoken dialogue lines');
  }

  // 7. AI-tell phrases
  const tells = AI_TELLS.filter(([re]) => re.test(script)).map(([, label]) => label);
  if (tells.length > 0) {
    issues.push(`AI-tell phrase(s) present: ${tells.join(', ')} — rewrite in plain spoken language`);
  }

  // 8. Cross-episode repetition: signature host devices and phrasing carried
  // over from recent episodes (the "same anecdote every day" problem).
  // DIGEST episodes are exempt: a digest recaps recent episodes by design,
  // so overlap with them is its substance, not a defect. (This exemption is
  // the Oct 31 fix: without it the digest fallback could never pass — it
  // shared 126-485 phrases with the episodes it recapped, and a week of
  // Group Insurance episodes was lost when fresh scripts also failed.)
  // Every other check (duration, labels, completeness, AI-tells) still
  // applies to digests.
  if (!opts.digest && recentScripts.length > 0) {
    for (const [re, label] of SIGNATURE_FRAMES) {
      if (re.test(script) && recentScripts.some((s) => re.test(s))) {
        issues.push(`Host device ${label} also appeared in a recent episode — vary the grounding device today`);
      }
    }
    const yesterday = ngrams(recentScripts[0], 8);
    const shared = [...ngrams(script, 8)].filter((g) => yesterday.has(g)).length;
    // Threshold 20 (was 8): when a story is legitimately refilled from the
    // ranked list, its headline/facts phrasing alone shares ~9-18 8-grams
    // with the episode that first covered it (Oct 26-30 logs). Wholesale
    // copying runs 100+, so 20 still catches lazy rewrites.
    if (shared > 20) {
      issues.push(`Detected ${shared} phrases recycled from the previous episode — fresh wording required`);
    }
  }

  const feedbackPrompt =
    issues.length > 0
      ? `AUDIT FEEDBACK — fix every issue below in the regenerated script:\n- ${issues.join('\n- ')}`
      : undefined;

  return { passed: issues.length === 0, issues, feedbackPrompt, estimatedMinutes: estMinutes };
}
