
export interface PodcastEpisode {
  id: string;
  date: string;
  title: string;
  script: string;
  audioUrl?: string;
  driveId?: string;
  topics: string[];
  mainStories: string[];
  status: 'draft' | 'generated' | 'published';
  auditResult?: {
    passed: boolean;
    issues: string[];
    feedbackPrompt?: string;
    duration?: number;
    voiceConsistency?: boolean;
    hasRepeats?: boolean;
    hasHeadlines?: boolean;
  };
}

export enum GenerationStep {
  IDLE = 'IDLE',
  SEARCHING = 'SEARCHING',
  REFINING = 'REFINING',
  SCRIPTING = 'SCRIPTING',
  SPEAKING = 'SPEAKING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR'
}

export interface IntelligenceReport {
  newsText: string;
  sources: any[];
  topStories: string[];
  autoInjectedTopics: string[];
  suggestedTopics: string[];
}

export interface ScheduleConfig {
  time: string; // HH:mm format
  timezone: string;
  days: number[]; // 0-6 (Sun-Sat)
}

export interface FocusConfig {
  categories: string[];
  autoRefinement: boolean;
}
