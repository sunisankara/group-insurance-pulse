import { GoogleGenAI } from "@google/genai";
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export interface AuditResult {
  passed: boolean;
  issues: string[];
  feedbackPrompt?: string;
  duration?: number;
  voiceConsistency?: boolean;
  hasRepeats?: boolean;
  hasHeadlines?: boolean;
}

export async function auditPodcast(audioPath: string, script: string): Promise<AuditResult> {
  const issues: string[] = [];

  // Check duration
  const duration = await getAudioDuration(audioPath);
  if (duration < 600 || duration > 1000) { // 10-15 minutes in seconds
    issues.push(`Duration ${Math.round(duration/60)} minutes is outside 10-15 minute range`);
  }

  // Check voice consistency
  const voiceConsistent = await checkVoiceConsistency(script, audioPath);
  if (!voiceConsistent) {
    issues.push('Voice inconsistency detected - Aria should always be female, Dorian male');
  }

  // Check for repeats
  const hasRepeats = await detectRepeats(audioPath, script);
  if (hasRepeats) {
    issues.push('Podcast contains repeated content');
  }

  // Check for headlines
  const hasHeadlines = checkHeadlines(script);
  if (!hasHeadlines) {
    issues.push('Stories missing headlines - content jumps directly into details');
  }

  const feedbackPrompt = generateAuditFeedbackPrompt({
    issues,
    duration,
    voiceConsistent,
    hasRepeats,
    hasHeadlines
  });

  return {
    passed: issues.length === 0,
    issues,
    feedbackPrompt,
    duration,
    voiceConsistency: voiceConsistent,
    hasRepeats,
    hasHeadlines
  };
}

async function getAudioDuration(audioPath: string): Promise<number> {
  try {
    const output = execSync(`ffprobe -v quiet -print_format json -show_format "${audioPath}"`, { encoding: 'utf8' });
    const data = JSON.parse(output);
    return parseFloat(data.format.duration);
  } catch (error) {
    console.error('Error getting audio duration:', error);
    return 0;
  }
}

async function checkVoiceConsistency(script: string, audioPath: string): Promise<boolean> {
  // Use Gemini to analyze voice characteristics
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

  // Read audio file as base64 for analysis
  const audioBuffer = fs.readFileSync(audioPath);
  const audioBase64 = audioBuffer.toString('base64');

  const prompt = `Analyze this podcast audio for voice consistency.

Script context:
${script}

Task: Listen to the audio and determine if:
1. Aria (the actuary) always has a consistent female voice
2. Dorian (distribution expert) always has a consistent male voice
3. No unexpected voice switches occur

Return only "CONSISTENT" if voices are consistent, or "INCONSISTENT" with brief explanation if not.`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        { parts: [{ text: prompt }] },
        {
          parts: [{
            inlineData: {
              mimeType: 'audio/mp3',
              data: audioBase64
            }
          }]
        }
      ]
    });

    const result = response.text?.trim().toUpperCase();
    return result?.startsWith('CONSISTENT') || false;
  } catch (error) {
    console.error('Voice consistency check failed:', error);
    return false;
  }
}

async function detectRepeats(audioPath: string, script: string): Promise<boolean> {
  // Use Gemini to detect if content repeats
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

  const audioBuffer = fs.readFileSync(audioPath);
  const audioBase64 = audioBuffer.toString('base64');

  const prompt = `Analyze this podcast audio and script for repeated content.

Script:
${script}

Task: Determine if the podcast repeats any segments, stories, or phrases. Look for:
1. Exact repetition of news items
2. Repeated phrases or transitions
3. Audio that loops or repeats

Return only "NO_REPEATS" if no repetition detected, or "REPEATS_DETECTED" with brief explanation if repeats found.`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        { parts: [{ text: prompt }] },
        {
          parts: [{
            inlineData: {
              mimeType: 'audio/mp3',
              data: audioBase64
            }
          }]
        }
      ]
    });

    const result = response.text?.trim().toUpperCase();
    return result?.includes('REPEATS_DETECTED') || false;
  } catch (error) {
    console.error('Repeat detection failed:', error);
    return false;
  }
}

function checkHeadlines(script: string): boolean {
  // Parse script for headlines
  const lines = script.split('\n');
  let currentStory = '';
  let hasHeadline = false;

  for (const line of lines) {
    if (line.includes('HEADLINE:') || line.includes('**') || line.match(/^[A-Z][^a-z]*:/)) {
      hasHeadline = true;
      currentStory = '';
    } else if (line.trim().length > 50 && !line.includes('[TRANSITION]')) {
      currentStory += line;
      if (currentStory.length > 200 && !hasHeadline) {
        return false; // Found substantial content without headline
      }
    }
  }

  return true;
}

export function generateAuditFeedbackPrompt(audit: {
  issues: string[];
  duration?: number;
  voiceConsistent?: boolean;
  hasRepeats?: boolean;
  hasHeadlines?: boolean;
}): string {
  const feedbackItems: string[] = [];

  // Duration feedback
  if (audit.duration !== undefined) {
    if (audit.duration < 600) {
      feedbackItems.push(`DURATION FEEDBACK: Episode too short (${Math.round(audit.duration / 60)} min). Expand content, add more analysis, deeper story context. Target 10-15 minutes (~2200 words).`);
    } else if (audit.duration > 1000) {
      feedbackItems.push(`DURATION FEEDBACK: Episode too long (${Math.round(audit.duration / 60)} min). Reduce verbosity, tighten pacing, eliminate tangents, focus on essential points only. Target 10-15 minutes (~2200 words).`);
    }
  }

  // Voice consistency feedback
  if (audit.voiceConsistent === false) {
    feedbackItems.push(`VOICE CONSISTENCY FEEDBACK: Enforce distinct speaker voices throughout. Aria MUST ALWAYS be female voice (Kore), Dorian MUST ALWAYS be male voice (Puck). Never switch, blend, or use alternate voices for either character. Maintain consistent speaker identity across all dialogue.`);
  }

  // Repeat detection feedback
  if (audit.hasRepeats === false) {
    feedbackItems.push(`CONTENT REPETITION FEEDBACK: Detected repeated segments, phrases, or stories. Ensure every news item, transition, and point is unique and distinct. Do not echo previous episodes' content. Vary sentence structure and narrative flow.`);
  }

  // Headlines feedback
  if (audit.hasHeadlines === false) {
    feedbackItems.push(`STRUCTURE FEEDBACK: Each story must open with a clear, compelling headline that captures the news item. Do not jump directly into details. Format: [HEADLINE: Story Title] followed by context. Aria and Dorian should reference the headline in their analysis.`);
  }

  if (feedbackItems.length === 0) {
    return "AUDIT FEEDBACK: Episode passed all quality checks. Maintain current standards for consistency, pacing, and structure.";
  }

  return `AUDIT FEEDBACK FOR NEXT GENERATION CYCLE:\n\n${feedbackItems.join('\n\n')}`;
}

export async function reRecordSegment(script: string, segmentIndex: number): Promise<string[]> {
  // Import here to avoid circular dependency
  const { generateSegmentAudio } = await import('./gemini.js');

  const segments = script.split('[TRANSITION]').filter(s => s.trim().length > 5);
  const segment = segments[segmentIndex];

  if (!segment) {
    throw new Error(`Segment ${segmentIndex} not found`);
  }

  console.log(`Re-recording segment ${segmentIndex + 1}...`);
  return await generateSegmentAudio(segment);
}