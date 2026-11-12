/**
 * Pronunciation dictionary — the single place to fix how the voices SAY
 * names and jargon. Shared by both shows and both TTS providers (Chirp
 * SSML path and the Gemini fallback), because it works as a plain-text
 * respell applied to the spoken text only: the published script, RSS
 * titles, and transcripts always keep the correct written form.
 *
 * HOW TO REFINE: when a word sounds wrong in an episode, add one line —
 * the written term on the left, the way a person actually says it on the
 * right ("Unum" is "You-num"). Keep respells simple phonetics with
 * hyphens; ALL-CAPS in a respell is read as emphasis, so use normal case.
 * Matching is case-insensitive and word-boundary aware, so an entry for
 * "Aflac" also catches "AFLAC" in a headline-style line.
 *
 * History: this replaced the old SSML approach (2026-11-12). The Chirp
 * path used to wrap acronyms in <say-as interpret-as="characters">, which
 * stretched them out letter by letter with pauses — the artificial
 * slow-down Shankar flagged. Chirp 3 HD renders standard industry
 * acronyms (HMO, PPO, HSA, STD, LTD...) natively at a natural pace, so
 * they are deliberately NOT in this dictionary; only terms the engines
 * genuinely get wrong belong here.
 */
export const PRONUNCIATIONS: Record<string, string> = {
  // Company names the engines mispronounce
  'Unum': 'You-num',
  'Aflac': 'aff-lack',
  'Cigna': 'SIG-nuh',
  // Jargon said as a word, not spelled out
  'EBITDA': 'ee-bit-dah',
  'HIPAA': 'hip-uh',
  'ERISA': 'er-ISS-uh',
  'LIMRA': 'LIM-ruh',
  // Numbers with spoken forms
  '401(k)': 'four oh one k',
  '403(b)': 'four oh three b',
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Precompiled once: longest terms first so a longer term wins over any
 * shorter term it contains. The lookarounds treat a term as matched only
 * when it is not glued to other word characters — "Unum" matches in
 * "Unum Group" but a respell never fires inside a longer word.
 */
const RESPELL_RULES: { pattern: RegExp; spoken: string }[] = Object.entries(PRONUNCIATIONS)
  .sort((a, b) => b[0].length - a[0].length)
  .map(([term, spoken]) => ({
    pattern: new RegExp(`(?<![A-Za-z0-9])${escapeRe(term)}(?![A-Za-z0-9])`, 'gi'),
    spoken,
  }));

/** Apply every dictionary respell to a block of spoken text. */
export function applyPronunciationRespells(text: string): string {
  let out = text;
  for (const { pattern, spoken } of RESPELL_RULES) {
    out = out.replace(pattern, spoken);
  }
  return out;
}
