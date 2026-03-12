import { GoogleGenAI, Modality } from "@google/genai";
import process from 'process';

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
  const prompt = `Based on this real-time Healthcare news summary, generate a catchy, high-impact podcast episode title that is EXACTLY 10 to 12 words long.
  Focus on the most significant technical or market breakthrough from TODAY.
  
  Summary: ${summary}`;

  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: prompt,
    config: { temperature: 0.8 }
  });

  return response.text?.trim().replace(/^"|"$/g, '') || "Daily Healthcare Intelligence Briefing: The Latest Technical and Market Evolution in Healthcare Observed Today";
};

export const fetchAINews = async (categories: string[] = []): Promise<any> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  let h = " \;
 try {
 const fs = require(\fs\);
 const path = require(\path\);
 const epPath = path.join(process.cwd(), \rss\, \episodes.json\);
 if (fs.existsSync(epPath)) {
 const eps = JSON.parse(fs.readFileSync(epPath, \utf-8\));
 const r = eps.slice(0, 3).map(function(e){return e.title}).join(" \);
      if (r) h = \Avoid_repeating: \ + r;
    }
  } catch (e) { }
  const now = new Date();
  const dateString = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  
  const prompt = `Act as a Senior Healthcare Strategy Consultant specializing turnaround management, corporate restructuring, and performance improvement. The consultant who works on the principle of providing practical solutions rather than just theoretical advice, and helps organizations navigate complex financial and operational crises, often taking interim management roles (such as Chief Restructuring Officer). The core expertise for this consultant spans restructuring, transaction advisory, private equity services, and crisis management. 
  TODAY'S DATE IS: ${dateString}. ${h}                                                                                                                                        

  CONTEXT: I am a Senior Healthcare Strategy Consultant and my background is in Healthcare Payor space. 
  My goal is to use this daily briefing to get re-usable, fact based, specific sound bytes and broaden my knowledge into hospital operations, clinical mechanics, and the "so what" of latest industry shifts.
  
  TASK: Write a high-density conversational NEWSCAST script for "Healthcare Daily Pulse by Sundaram Labs" based on events from the LAST 24-48 HOURS. Research and synthesize around 3 to 5 breaking Healthcare developments from the last 24 to 48 hours. 
  
  STRICT RELEVANCE RULES: Before writing, search for the latest news (within 48 hours) regarding:
  - Major Healthcare M&A or Restructuring (e.g., spinoffs, bankruptcies, PE acquisitions).
  - New CMS Mandates, Federal Laws, or Regulatory Rulings.
  - Large-scale operational projects undertaken by Top 20 Health Systems.
  - Breakthroughs in 'Agentic AI' or health-tech implementation.
  - DO NOT include any news from more than 7 days ago.
  - If the story isn't from ${now.getMonth() + 1}/${now.getDate() - 1} or ${now.getMonth() + 1}/${now.getDate()}, IGNORE IT.

  DATA REQUIREMENT: Every story MUST include at least one hard number (dollars, time period, percentage, market share, market cap, or date) and mention news of a current business event for a major company associated with the news
  
  REPORTING STYLE:
  - Financial: Focus on Revenue, P&L, market share, EBITDA
  - Sentiment: Aggregate consensus from Hacker News / X / GitHub from the LAST 12 HOURS.

  [METADATA] TOP_STORIES: (List 3-5 short headlines separated by commas)`;

  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: prompt,
    config: { 
      tools: [{ googleSearch: {} }],
      thinkingConfig: { thinkingBudget: 0 }
    },
  });

  const text = response.text || "";
  const parts = text.split('[METADATA]');
  const report = parts[0] || "";
  const metadata = parts[1] || "";
  const topStories = metadata.match(/TOP_STORIES: (.*)/)?.[1]?.split(',') || ["Real-time Healthcare Intelligence Update"];
  
  return {
    newsText: report.trim(),
    topStories: topStories.map(t => t.trim()).filter(t => t),
    sources: response.candidates?.[0]?.groundingMetadata?.groundingChunks || [],
  };
};

export const generatePodcastScript = async (newsSummary: string) => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const prompt = `Write a 15-minute technical conversation script for "Healthcare Daily Pulse".

  TARGET LENGTH: 15 minutes (~2,200 words).
  FORMAT: Byte-sized news segments. Rapid fire delivery.
  
  HOSTS:
  - Alex (Female): Skeptical Financial Analyst focusing on implementing healthcare solutions. Critical, technical, implementation-focused, skeptical of hype. (Reflecting a Payor expertise).
  - Sam (Male): Optimistic, ROI-focused, market-visionary, and pragmatic. Focuses on "How does this change the competitive landscape?"

  CONVERSATION FLOW:
  - Sam leads with a breakdown of a new story, Alex pushes back with implementation constraints.
  - Use natural segues like "That actually maps to the infra news we saw earlier..." or "Wait, before we move on, the market share are wild..."
  - MANDATORY: Use [TRANSITION] between major news items to help the production engine.

  DATA TO SYNTHESIZE:
  ${newsSummary}`;

  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: prompt,
    config: { 
      maxOutputTokens: 6000,
      temperature: 0.7
    }
  });

  return response.text || "";
};

export const generateSegmentAudio = async (text: string): Promise<string[]> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const cleanText = text
    .replace(/Sundaram/gi, 'Suun-duh-ruhm')
    .replace(/Labs/gi, 'Labbz')
    .replace(/\[.*?\]/g, '') 
    .trim();

  if (!cleanText) return [];

  const chunks: string[] = [];
  let remaining = cleanText;
  const MAX_CHUNK = 800;

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
                { speaker: 'Alex', voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
                { speaker: 'Sam', voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } }
              ]
            }
          }
        }
      });
      return response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    });
    if (data) results.push(data);
    await new Promise(r => setTimeout(r, 800));
  }
  return results;
};

































































































































































































































































