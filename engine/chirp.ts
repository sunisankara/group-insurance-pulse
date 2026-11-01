/**
 * Google Cloud Text-to-Speech provider — Chirp 3 HD voices.
 *
 * Why this exists: Gemini TTS (the original provider) costs real money per
 * episode and its voices drift. Chirp 3 HD voices are fixed named neural
 * voices with a 1M-characters/month free tier, which covers both shows.
 *
 * Pipeline contract (shared with the Gemini provider in voices.ts): one
 * call per story segment, returning base64 chunks of RAW PCM — s16le,
 * 24000 Hz, mono — which run.ts concatenates into the mastering input.
 * Cloud TTS LINEAR16 responses arrive wrapped in a WAV container, so the
 * header is stripped here.
 *
 * Chirp is single-speaker per request (no multi-speaker mode like Gemini),
 * so a segment is parsed into per-host turns and each turn is synthesized
 * with that host's Chirp voice, then the PCM is concatenated with a short
 * breath between turns.
 *
 * Reliability rule: if Chirp fails for a segment (HTTP error, empty audio,
 * missing config), the caller-supplied Gemini fallback synthesizes that
 * segment instead and a loud warning is logged. An episode must never die
 * because this provider hiccuped.
 */
import { Buffer } from 'buffer';
import { HostConfig, ShowConfig } from './types.js';
import { splitOversizedSegment } from './script.js';

export const CHIRP_TTS_ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';

/** The only SSML tags Chirp 3 HD honors; anything else is ignored by Google
 *  and must never be emitted by the builder below. */
export const CHIRP_SSML_TAGS = ['speak', 'say-as', 'p', 's', 'phoneme', 'sub', 'break', 'audio', 'prosody'];

/** ~150ms of silence between speaker turns inside a segment (samples are
 *  s16le mono @ 24000 Hz = 2 bytes/sample). run.ts adds 0.45s between
 *  segments; turns inside a conversation sit closer together. */
const TURN_SILENCE = Buffer.alloc(Math.floor(24000 * 2 * 0.15));

/** Keep each request comfortably under Cloud TTS's input limit, SSML
 *  markup included. Turn text is chunked at sentence boundaries to fit. */
const MAX_TURN_CHARS = 3200;

// ---------------------------------------------------------------------------
// Usage accounting — characters actually sent to Chirp (SSML markup counts
// toward Google's quota, so it counts here too), successful calls, and how
// many segments fell back to Gemini. run.ts logs the totals per broadcast
// so monthly usage vs the 1M free tier is visible in the Actions log.
// ---------------------------------------------------------------------------
const usage = { characters: 0, calls: 0, fallbacks: 0 };

export function getChirpUsage(): { characters: number; calls: number; fallbacks: number } {
  return { ...usage };
}

export function resetChirpUsage(): void {
  usage.characters = 0;
  usage.calls = 0;
  usage.fallbacks = 0;
}

// ---------------------------------------------------------------------------
// SSML humanization layer
// ---------------------------------------------------------------------------

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pronunciation map for insurance jargon. Two tools, used sparingly:
 *  - <sub alias> where the industry says a word Google would mangle
 *    (EBITDA is "ee-bit-dah", never spelled out; Aflac is "aff-lack").
 *  - <say-as interpret-as="characters"> for acronyms people spell out
 *    (HMO, PPO) — without it, engines guess and sometimes say them as words.
 * Applied to already-XML-escaped text; none of the terms contain XML chars.
 */
const SUBSTITUTIONS: { pattern: RegExp; replacement: string }[] = [
  { pattern: /\b401\(k\)/g, replacement: '<sub alias="four oh one k">401(k)</sub>' },
  { pattern: /\b403\(b\)/g, replacement: '<sub alias="four oh three b">403(b)</sub>' },
  { pattern: /\bEBITDA\b/g, replacement: '<sub alias="ee-bit-dah">EBITDA</sub>' },
  { pattern: /\bAflac\b/gi, replacement: '<sub alias="aff-lack">Aflac</sub>' },
  { pattern: /\bHIPAA\b/g, replacement: '<sub alias="hip-uh">HIPAA</sub>' },
];

const SPELL_OUT_TERMS = ['HMO', 'PPO', 'EPO', 'HDHP', 'HSA', 'FSA', 'ACA', 'CMS', 'LTC', 'PHI'];

export function applyPronunciations(escapedText: string): string {
  let out = escapedText;
  for (const { pattern, replacement } of SUBSTITUTIONS) {
    out = out.replace(pattern, replacement);
  }
  for (const term of SPELL_OUT_TERMS) {
    out = out.replace(
      new RegExp(`\\b${term}\\b`, 'g'),
      `<say-as interpret-as="characters">${term}</say-as>`
    );
  }
  return out;
}

export interface ProsodyProfile {
  rate: string;
  pitch: string;
}

/**
 * Light per-host prosody variation so the two hosts don't just differ in
 * voice but in delivery: host 1 at reference pace, a hair brighter; host 2
 * a touch slower and lower. Deliberately subtle — big SSML swings are what
 * make synthesized speech sound like a cartoon announcer.
 */
export function prosodyForHost(hostIndex: number): ProsodyProfile {
  return hostIndex === 0 ? { rate: '100%', pitch: '+0.5st' } : { rate: '97%', pitch: '-1st' };
}

/**
 * Build the SSML for one speaker turn: <speak> wrapper, the host's prosody
 * profile, pronunciation substitutions, and a <break> wherever the script
 * puts a paragraph gap (a topic transition inside the turn). Single
 * newlines collapse to spaces. Only CHIRP_SSML_TAGS are ever emitted.
 */
export function buildTurnSsml(rawText: string, prosody: ProsodyProfile): string {
  const paragraphs = rawText
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const rendered = paragraphs.map((p) =>
    applyPronunciations(escapeXml(p.replace(/\s*\n\s*/g, ' ')))
  );
  const body = rendered.join('<break time="650ms"/>');
  return `<speak><prosody rate="${prosody.rate}" pitch="${prosody.pitch}">${body}</prosody></speak>`;
}

// ---------------------------------------------------------------------------
// Segment shaping: turns and chunking
// ---------------------------------------------------------------------------

export interface Turn {
  hostIndex: number;
  text: string;
}

/** Parse a (possibly multi-speaker) segment piece into per-host turns.
 *  Lines that don't start with a host label continue the current turn;
 *  text before any label belongs to host 0 (should not happen in practice —
 *  the script format mandates labels). */
export function parseTurns(piece: string, hosts: HostConfig[]): Turn[] {
  const labelRe = new RegExp(`^(${hosts.map((h) => escapeRe(h.name)).join('|')}):\\s*(.*)$`);
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const line of piece.split('\n')) {
    const m = line.match(labelRe);
    if (m) {
      current = { hostIndex: hosts.findIndex((h) => h.name === m[1]), text: m[2] };
      turns.push(current);
    } else if (current) {
      current.text += '\n' + line;
    } else {
      current = { hostIndex: 0, text: line };
      turns.push(current);
    }
  }
  return turns
    .map((t) => ({ hostIndex: t.hostIndex, text: t.text.trim() }))
    .filter((t) => t.text.length > 0);
}

/** Split one turn's text at sentence boundaries so every request stays
 *  under MAX_TURN_CHARS (SSML overhead included is small headroom). A
 *  single sentence longer than the limit is hard-split at a word edge. */
export function splitTurnText(text: string, maxChars: number = MAX_TURN_CHARS): string[] {
  if (text.length <= maxChars) return [text];
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [text];
  const chunks: string[] = [];
  let current = '';
  const push = (s: string) => {
    if (s.trim()) chunks.push(s.trim());
  };
  for (let sentence of sentences) {
    while (sentence.length > maxChars) {
      push(current);
      current = '';
      const cut = sentence.lastIndexOf(' ', maxChars);
      push(sentence.slice(0, cut > 0 ? cut : maxChars));
      sentence = sentence.slice(cut > 0 ? cut + 1 : maxChars);
    }
    if ((current + sentence).length > maxChars && current) {
      push(current);
      current = sentence;
    } else {
      current += sentence;
    }
  }
  push(current);
  return chunks.length ? chunks : [text];
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

export interface ChirpDeps {
  /** Injectable for tests; defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** Injectable for tests; defaults to process.env.GOOGLE_TTS_API_KEY. */
  apiKey?: string;
  /** Injectable so tests don't actually wait between retries. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Strip the WAV container from a LINEAR16 response, returning raw PCM.
 *  Scans RIFF chunks for 'data' rather than assuming a fixed 44-byte
 *  header — Google may include extra chunks (e.g. 'fact'). Non-RIFF input
 *  is assumed to already be raw PCM and passed through. */
export function pcmFromWav(buf: Buffer): Buffer {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF') return buf;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  throw new Error('Chirp TTS WAV response had no data chunk');
}

/**
 * One Cloud TTS synthesize call for one SSML string in one voice.
 * Returns raw PCM (s16le, 24000 Hz, mono). Retries once on failure, then
 * throws — the segment-level wrapper turns a throw into a Gemini fallback.
 * Successful calls are counted in the usage totals (SSML length included,
 * as Google counts it).
 */
export async function chirpSynthesizeSsml(ssml: string, voiceName: string, deps: ChirpDeps = {}): Promise<Buffer> {
  const apiKey = deps.apiKey ?? process.env.GOOGLE_TTS_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_TTS_API_KEY is not set');
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const languageCode = voiceName.split('-').slice(0, 2).join('-');
  const body = {
    input: { ssml },
    voice: { languageCode, name: voiceName },
    audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000 },
  };

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetchFn(CHIRP_TTS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`Chirp TTS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const json: any = await res.json();
      if (!json.audioContent) throw new Error('Chirp TTS response had no audioContent');
      const pcm = pcmFromWav(Buffer.from(json.audioContent, 'base64'));
      if (pcm.length === 0) throw new Error('Chirp TTS returned empty audio');
      usage.characters += ssml.length;
      usage.calls += 1;
      return pcm;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await sleep(1000);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Segment synthesis with Gemini fallback
// ---------------------------------------------------------------------------

/**
 * Synthesize one story segment with Chirp, honouring the voices.ts
 * contract: returns base64 raw-PCM chunks, one per oversized-split piece.
 * `fallback` is the Gemini segment synthesizer, invoked with the ORIGINAL
 * segment text (it does its own cleaning) whenever anything in the Chirp
 * path fails — the segment is re-done wholesale by Gemini rather than
 * mixing providers mid-segment, so a fallback never splices two voice
 * families inside one story.
 */
export async function synthesizeSegmentChirp(
  cfg: ShowConfig,
  segmentText: string,
  fallback: (segmentText: string) => Promise<string[]>,
  deps: ChirpDeps = {}
): Promise<string[]> {
  // Same cleaning as the Gemini path: bracketed stage tags and markdown
  // emphasis must never reach the synthesizer as literal text.
  const cleanText = segmentText.replace(/\[[^\]]*\]/g, '').replace(/\*\*/g, '').trim();
  if (!cleanText) return [];

  try {
    const hostNames = cfg.hosts.map((h) => h.name);
    const pieces = splitOversizedSegment(cleanText, hostNames);
    const results: string[] = [];
    for (const piece of pieces) {
      const turns = parseTurns(piece, cfg.hosts);
      if (turns.length === 0) throw new Error('Chirp TTS: segment had no speaker turns');
      const pcmParts: Buffer[] = [];
      for (let t = 0; t < turns.length; t++) {
        const turn = turns[t];
        const voice = cfg.hosts[turn.hostIndex].chirpVoice;
        if (!voice) {
          throw new Error(`Host '${cfg.hosts[turn.hostIndex].name}' has no chirpVoice in show.yaml`);
        }
        for (const chunk of splitTurnText(turn.text)) {
          const ssml = buildTurnSsml(chunk, prosodyForHost(turn.hostIndex));
          pcmParts.push(await chirpSynthesizeSsml(ssml, voice, deps));
        }
        if (t < turns.length - 1) pcmParts.push(TURN_SILENCE);
      }
      results.push(Buffer.concat(pcmParts).toString('base64'));
    }
    return results;
  } catch (err: any) {
    usage.fallbacks += 1;
    console.log(
      `WARNING: Chirp TTS failed for a segment (${err?.message || err}); ` +
        'falling back to Gemini TTS for this segment.'
    );
    return fallback(segmentText);
  }
}
