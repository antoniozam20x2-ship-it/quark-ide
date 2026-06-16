import { GoogleGenAI } from '@google/genai';
import { recordCall, recordEstimated } from './costTracker.js';

const GEMINI_MODEL = 'gemini-2.0-flash-lite';
const TIMEOUT_MS = 30_000;

function getClient(): GoogleGenAI {
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms — ${label}`)), ms)
    ),
  ]);
}

export async function streamChat(
  messages: { role: string; content: string }[],
  systemPrompt: string,
  onChunk: (text: string) => void,
  endpoint: string = '/api/chat'
): Promise<void> {
  const ai = getClient();
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const promptText = systemPrompt + messages.map((m) => m.content).join(' ');
  let responseText = '';

  const streamPromise = (async () => {
    const response = await ai.models.generateContentStream({
      model: GEMINI_MODEL,
      contents,
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: 4096,
      },
    });

    for await (const chunk of response) {
      const text = chunk.text ?? '';
      if (text) {
        responseText += text;
        onChunk(text);
      }
    }
  })();

  await withTimeout(streamPromise, TIMEOUT_MS, 'streamChat');
  recordEstimated(endpoint, promptText, responseText);
}

export async function generateContent(
  prompt: string,
  systemPrompt: string,
  maxTokens = 2048,
  endpoint: string = '/api/warroom'
): Promise<string> {
  const ai = getClient();

  const responsePromise = ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      systemInstruction: systemPrompt,
      maxOutputTokens: maxTokens,
    },
  });

  const response = await withTimeout(responsePromise, TIMEOUT_MS, `generateContent:${endpoint}`);

  const text = response.text ?? '';
  const tokensIn = (response as any).usageMetadata?.promptTokenCount ?? Math.ceil((systemPrompt + prompt).length / 4);
  const tokensOut = (response as any).usageMetadata?.candidatesTokenCount ?? Math.ceil(text.length / 4);
  recordCall(endpoint, tokensIn, tokensOut);

  return text;
}
