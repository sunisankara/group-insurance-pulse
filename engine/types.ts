export interface HostConfig {
  name: string;
  voice: string; // Gemini prebuilt voice name, e.g. 'Kore'
}

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
}

export interface AuditResult {
  passed: boolean;
  issues: string[];
  feedbackPrompt?: string;
  estimatedMinutes?: number;
}
