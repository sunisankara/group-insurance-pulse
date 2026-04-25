import { GoogleGenAI, Modality } from "@google/genai";
import process from 'process';
import fs from 'fs';
import path from 'path';

async function withRetry<T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (retries <= 0) throw error;
    await new Promise(resolve => setTimeout(resolve, delay));
    return withRetry(fn, retries - 1, delay * 2);
  }
}

export const generateEpisodeMetadata = async (summary: string) => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const prompt = `Based on this real-time Group Insurance news summary, generate a catchy, high-impact podcast episode title that is EXACTLY 10 to 12 words long.
  Focus on the most significant technical or market breakthrough from TODAY.
  
  Summary: ${summary}`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: { temperature: 0.8 }
  });

  return response.text?.trim().replace(/^"|"$/g, '') || "Daily Group Insurance Intelligence Briefing: The Latest Technical and Market Evolution observed today";
};

export const fetchAINews = async (categories: string[] = []): Promise<any> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  let historyTitles = "";
  try {
    const epPath = path.join(process.cwd(), 'rss', 'episodes.json');
    if (fs.existsSync(epPath)) {
      const eps = JSON.parse(fs.readFileSync(epPath, 'utf-8'));
      const r = eps.slice(0, 15).map(function(e){ return e.title + (e.mainStories ? ": " + e.mainStories.join(", ") : "") }).join(" | ");
      if (r) historyTitles = "RECENTLY COVERED TOPICS (DO NOT REPEAT): " + r;
    }
  } catch (e) { }

  const now = new Date();
  const dateString = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  
  const prompt = `Act as a Senior Group Insurance Strategy Researcher.
  TODAY'S DATE IS: ${dateString}. 
  ${historyTitles}

  TASK: Research and synthesize 3 to 5 significant Group Insurance business developments from the LAST 24-48 HOURS.
  
  STRICT RELEVANCE RULES: 
  - PRIMARY TARGETS (Competitors): MetLife, Prudential Financial, Lincoln Financial, Unum, The Hartford, Sun Life, Guardian Life, Principal Financial, Mutual of Omaha, Voya Financial, Reliance Matrix, OneAmerica, Securian Financial, Standard Insurance Company (The Standard), Aflac, USAble Life, Dearborn Group.
  - Topics: Group Life, Disability (STD/LTD), Accident, Critical Illness, Accidental Injury, Hospital Indemnity, Employee Benefits.
  - Focus on M&A, tech/AI advancements, market disruptors, broker/consultant news (Mercer, WTW, Aon), TPAs, sales/distribution Stakeholders.
  - Look for regulatory changes (ERISA, PFML, DOL, DOI).
  - Look for new capabilities in claims administration, payment tech, revenue cycle, and commissions.
  - Every story MUST include hard numbers (dollars, percentages, or dates) and specific company names.
  - REPEAT PREVENTION: Do not cover the same core news items mentioned in the RECENTLY COVERED TOPICS list.
  - If a story is not from ${now.getMonth() + 1}/${now.getDate() - 1} or ${now.getMonth() + 1}/${now.getDate()}, IGNORE IT.

  OUTPUT FORMAT:
  For each story, provide:
  - HEADLINE: [Title]
  - FACTS: [Bullet points of numbers, companies, and "so what"]
  - CONTEXT: [Why this matters for carriers, brokers, and employers]

  [METADATA] TOP_STORIES: (List the headlines separated by commas)`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: { 
      tools: [{ googleSearch: {} }]
    },
  });

  const text = response.text || "";
  const parts = text.split('[METADATA]');
  const report = parts[0] || "";
  const metadata = parts[1] || "";
  const topStories = metadata.match(/TOP_STORIES: (.*)/)?.[1]?.split(',') || ["Real-time Group Insurance Intelligence Update"];
  
  return {
    newsText: report.trim(),
    topStories: topStories.map(t => t.trim()).filter(t => t),
    sources: response.candidates?.[0]?.groundingMetadata?.groundingChunks || [],
  };
};

export const generatePodcastScript = async (newsSummary: string, feedbackPrompt?: string) => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  const feedbackSection = feedbackPrompt 
    ? `\n\nFEEDBACK FROM PREVIOUS GENERATION:\n${feedbackPrompt}\n\nIncorporate this feedback into the script generation.`
    : '';

  const prompt = `Write a 15-minute technical conversation script for "Group Insurance Daily Pulse".

  TARGET LENGTH: 15 minutes (~2,200 words).
  FORMAT: Byte-sized news segments. Rapid fire delivery.
  
  HOSTS:
  - Aria: Aria the Actuary. Skeptical, analytical, risk-focused. Concerned with P&L, Regulatory (ERISA, DOI), and solvency.
  - Dorian: Dorian the Distribution Expert. Optimistic, forward-leaning, focused on ROI, market share, and employee retention/experience.

  CONVERSATION STYLE:
  - Extremely dense, technical, and data-driven.
  - Dorian presents the facts/innovations, Aria analyzes the risk and implementation friction.
  - Use [TRANSITION] between major news items.

  STRICT INSTRUCTION: Only use the news data provided below. Do not hallucinate old stories.
  
  DATA TO SYNTHESIZE:
  ${newsSummary}${feedbackSection}`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: { 
      maxOutputTokens: 8000,
      temperature: 0.7
    }
  });

  return response.text || "";
};

export const regenerateScriptWithFeedback = async (newsSummary: string, auditResult: any): Promise<string> => {
  const feedbackPrompt = auditResult.feedbackPrompt;
  if (!feedbackPrompt) {
    throw new Error("Audit result must include feedbackPrompt");
  }
  return generatePodcastScript(newsSummary, feedbackPrompt);
};

export const generateSegmentAudio = async (text: string): Promise<string[]> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const cleanText = text
    .replace(/\[.*?\]/g, '') 
    .trim();

  if (!cleanText) return [];

  const chunks: string[] = [];
  let remaining = cleanText;
  const MAX_CHUNK = 1000;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_CHUNK) {
      chunks.push(remaining);
      break;
    }
    let endIdx = remaining.lastIndexOf('.', MAX_CHUNK);
    if (endIdx === -1) endIdx = MAX_CHUNK;
    chunks.push(remaining.substring(0, endIdx + 1).trim());
    remaining = remaining.substring(endIdx + 1).trim();
  }

  const results: string[] = [];
  for (const chunk of chunks) {
    const data = await withRetry(async () => {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: chunk }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            multiSpeakerVoiceConfig: {
              speakerVoiceConfigs: [
                { speaker: 'Aria', voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
                { speaker: 'Dorian', voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } }
              ]
            }
          }
        }
      });
      return response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    });
    if (data) results.push(data);
    await new Promise(r => setTimeout(r, 500));
  }
  return results;
};
