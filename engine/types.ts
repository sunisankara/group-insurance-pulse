export interface HostConfig {
  name: string;
  voice: string; // Gemini prebuilt voice name, e.g. 'Kore'
  chirpVoice?: string; // Google Cloud TTS Chirp 3 HD voice name, e.g. 'en-US-Chirp3-HD-Aoede'
}

export type TtsProvider = 'gemini' | 'chirp';

export interface ShowConfig {
  id: string; // 'group-insurance' | 'healthcare'
  title: string; // "Group Insurance Daily Pulse"
  feedTitle: string;
  author: string;
  email: string;
  summary: string;
  description: string;
  categories: string[];
  coverFile: string;
  language: string;
  hosts: HostConfig[]; // exactly 2
  /** Per-show TTS provider override; when unset, TTS_PROVIDER env, then 'gemini'. */
  ttsProvider?: TtsProvider;
  ttsModel: string;
  textModel: string;
  targetMinutes: number;
  wordsPerMinute: number;
  rssDir: string; // relative output dir, e.g. 'rss' or 'rss/healthcare'
  scheduleCron: string;
  // loaded markdown docs
  hostsDoc: string;
  lensesDoc: string;
  newsDoc: string;
}

export interface RankedStory {
  rank: number;
  headline: string;
  facts: string;
  context: string;
  lens: string; // lens name from lenses.md
  source?: string;
}

export interface EpisodeRecord {
  id: string;
  date: string;
  title: string;
  script: string;
  audioUrl: string;
  topics: string[];
  mainStories: string[];
  status: string;
  auditIssues: string[];
  /** Real MP3 size in bytes (backfilled at publish; legacy items may lack it). */
  audioBytes?: number;
  /** Real MP3 duration in seconds (backfilled at publish). */
  durationSec?: number;
  /** True for digest/look-back fallback episodes — excluded from the story dedup corpus. */
  digest?: boolean;
}

export interface AuditResult {
  passed: boolean;
  issues: string[];
  feedbackPrompt?: string;
  estimatedMinutes?: number;
}
