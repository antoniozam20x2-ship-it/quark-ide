import { GoogleGenAI } from '@google/genai';
import { recordCall, recordEstimated } from './costTracker.js';

const GEMINI_MODEL = 'gemini-3.1-flash-lite';
const TIMEOUT_MS = 30_000;

// ── Auth-error detection ──────────────────────────────────────────────────────

/** Thrown when Gemini rejects the request due to an invalid / missing API key.
 *  The caller should NOT retry with Gemini — switch to a different provider. */
export class GeminiAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiAuthError';
  }
}

function isAuthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('401') ||
    msg.includes('api_key_invalid') ||
    msg.includes('api key not valid') ||
    msg.includes('unauthenticated') ||
    msg.includes('permission_denied') ||
    msg.includes('invalid api key')
  );
}

function rethrowIfAuth(err: unknown): never {
  if (isAuthError(err)) {
    throw new GeminiAuthError(
      `Gemini 401 — key invalid or missing (${(err as Error).message})`
    );
  }
  throw err;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Key-rotating generate (for DEEP mode — large context, rate-limit safe) ───

/**
 * Like generateContent but tries GEMINI_API_KEY first, then GEMINI_API_KEY_2
 * on a 429 / RESOURCE_EXHAUSTED rate-limit response. Falls through to throw
 * on auth errors or when both keys are exhausted.
 */
export async function generateContentWithRotation(
  prompt: string,
  systemPrompt: string,
  maxTokens = 8192,
  endpoint: string = '/api/agent/deep',
): Promise<string> {
  const keys = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
  ].filter(Boolean) as string[];

  let lastErr: Error = new Error('No Gemini keys configured');

  for (let i = 0; i < keys.length; i++) {
    const ai = new GoogleGenAI({ apiKey: keys[i] });
    try {
      const responsePromise = ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { systemInstruction: systemPrompt, maxOutputTokens: maxTokens },
      });
      const response = await withTimeout(responsePromise, TIMEOUT_MS, `generateContentWithRotation:${endpoint}`);
      const text = response.text ?? '';
      const tokensIn = (response as any).usageMetadata?.promptTokenCount ?? Math.ceil((systemPrompt + prompt).length / 4);
      const tokensOut = (response as any).usageMetadata?.candidatesTokenCount ?? Math.ceil(text.length / 4);
      recordCall(endpoint, tokensIn, tokensOut);
      return text;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const msg = lastErr.message.toLowerCase();
      const isRateLimit =
        msg.includes('429') ||
        msg.includes('resource_exhausted') ||
        msg.includes('quota') ||
        msg.includes('rate');
      if (isRateLimit && i < keys.length - 1) {
        console.warn(`[Gemini] Rate limit on key ${i + 1} — rotating to key ${i + 2}`);
        continue; // try next key
      }
      rethrowIfAuth(err);
    }
  }
  throw lastErr;
}

// ── Public API ────────────────────────────────────────────────────────────────

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
    try {
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
    } catch (err) {
      rethrowIfAuth(err);
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

  let response;
  try {
    const responsePromise = ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: maxTokens,
      },
    });
    response = await withTimeout(responsePromise, TIMEOUT_MS, `generateContent:${endpoint}`);
  } catch (err) {
    rethrowIfAuth(err);
  }

  const text = response!.text ?? '';
  const tokensIn = (response as any).usageMetadata?.promptTokenCount ?? Math.ceil((systemPrompt + prompt).length / 4);
  const tokensOut = (response as any).usageMetadata?.candidatesTokenCount ?? Math.ceil(text.length / 4);
  recordCall(endpoint, tokensIn, tokensOut);

  return text;
}
