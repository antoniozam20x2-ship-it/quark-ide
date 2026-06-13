import { GoogleGenAI } from '@google/genai';
import { recordCall, recordEstimated } from './costTracker.js';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const MODEL = 'gemini-3.1-flash-lite';

export async function streamChat(
  messages: { role: string; content: string }[],
  systemPrompt: string,
  onChunk: (text: string) => void,
  endpoint: string = '/api/chat'
): Promise<void> {
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const promptText = systemPrompt + messages.map((m) => m.content).join(' ');
  let responseText = '';

  const response = await ai.models.generateContentStream({
    model: MODEL,
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

  recordEstimated(endpoint, promptText, responseText);
}

export async function generateContent(
  prompt: string,
  systemPrompt: string,
  maxTokens = 2048,
  endpoint: string = '/api/warroom'
): Promise<string> {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      systemInstruction: systemPrompt,
      maxOutputTokens: maxTokens,
    },
  });

  const text = response.text ?? '';
  const tokensIn = (response as any).usageMetadata?.promptTokenCount ?? Math.ceil((systemPrompt + prompt).length / 4);
  const tokensOut = (response as any).usageMetadata?.candidatesTokenCount ?? Math.ceil(text.length / 4);
  recordCall(endpoint, tokensIn, tokensOut);

  return text;
}
