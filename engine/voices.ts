import { GoogleGenAI, Modality } from '@google/genai';
import { ShowConfig } from './types.js';
import { splitOversizedSegment } from './script.js';

function ai() {
  return new GoogleGenAI({ apiKey: process.env.API_KEY });
}

async function withRetry<T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (retries <= 0) throw error;
    await new Promise((r) => setTimeout(r, delay));
    return withRetry(fn, retries - 1, delay * 2);
  }
}

/**
 * Voice production — ONE TTS call per story segment (not per 1000-char
 * chunk). The old code made a separate API call for every 1000 characters,
 * and each call re-instantiated the voices, which is why voices drifted
 * mid-episode. A single call per segment keeps each voice's prosody and
 * energy consistent; speaker labels in the text route lines to voices.
 */
export async function synthesizeSegment(cfg: ShowConfig, segmentText: string): Promise<string[]> {
  // Strip bracketed stage tags like [TRANSITION] and markdown emphasis
  // (**bold** around spoken headlines) — neither should ever reach the TTS
  // model as literal text. Keep "Name:" speaker labels.
  const cleanText = segmentText.replace(/\[[^\]]*\]/g, '').replace(/\*\*/g, '').trim();
  if (!cleanText) return [];

  const hostNames = cfg.hosts.map((h) => h.name);
  const pieces = splitOversizedSegment(cleanText, hostNames);

  const results: string[] = [];
  for (const piece of pieces) {
    const data = await withRetry(async () => {
      const response = await ai().models.generateContent({
        model: cfg.ttsModel,
        contents: [{ parts: [{ text: piece }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            multiSpeakerVoiceConfig: {
              speakerVoiceConfigs: cfg.hosts.map((h) => ({
                speaker: h.name,
                voiceConfig: { prebuiltVoiceConfig: { voiceName: h.voice } },
              })),
            },
          },
        },
      });
      return response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    });
    if (data) results.push(data);
  }
  return results;
}
