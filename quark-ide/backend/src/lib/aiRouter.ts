import { GoogleGenAI } from '@google/genai';

const GROQ_KEYS = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
].filter(Boolean) as string[];

const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
].filter(Boolean) as string[];

let groqIndex   = 0;
let geminiIndex = 0;

export async function callAI(
  task: 'fix' | 'generate' | 'analyze' | 'html' | 'warroom',
  prompt: string,
  systemPrompt?: string,
): Promise<string> {
  switch (task) {
    case 'fix':
      return tryProviders([
        () => callDeepSeek(prompt, systemPrompt),
        () => callGroq(prompt, systemPrompt),
        () => callGemini(prompt, systemPrompt),
      ]);

    case 'generate':
      return tryProviders([
        () => callGemini(prompt, systemPrompt),
        () => callGroq(prompt, systemPrompt),
        () => callDeepSeek(prompt, systemPrompt),
      ]);

    case 'analyze':
      return tryProviders([
        () => callGroq(prompt, systemPrompt),
        () => callGemini(prompt, systemPrompt),
      ]);

    case 'html':
      return tryProviders([
        () => callGitHubModels(prompt, systemPrompt, 'gpt-4o'),
        () => callGemini(prompt, systemPrompt),
        () => callGroq(prompt, systemPrompt),
      ]);

    case 'warroom':
      return tryProviders([
        () => callGroq(prompt, systemPrompt),
        () => callGemini(prompt, systemPrompt),
      ]);
  }
}

async function tryProviders(providers: (() => Promise<string>)[]): Promise<string> {
  const errors: string[] = [];
  for (const provider of providers) {
    try {
      const result = await provider();
      if (result?.trim()) return result;
    } catch (err: any) {
      const is429 = err?.status === 429 || String(err).includes('429');
      const msg = err?.message ?? String(err);
      console.warn(`[AI Router] Provider failed${is429 ? ' (429)' : ''}:`, msg);
      errors.push(msg);
    }
  }
  throw new Error(`Todos los proveedores fallaron:\n${errors.join('\n')}`);
}

async function callGroq(prompt: string, system?: string): Promise<string> {
  if (!GROQ_KEYS.length) throw new Error('No GROQ keys configured');
  const key = GROQ_KEYS[groqIndex % GROQ_KEYS.length];
  groqIndex++;
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 8192,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
    }),
  });
  const data = await res.json() as any;
  if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? `Groq ${res.status}`), { status: res.status });
  return data.choices?.[0]?.message?.content ?? '';
}

async function callGemini(prompt: string, system?: string): Promise<string> {
  if (!GEMINI_KEYS.length) throw new Error('No GEMINI keys configured');
  const key = GEMINI_KEYS[geminiIndex % GEMINI_KEYS.length];
  geminiIndex++;
  const ai = new GoogleGenAI({ apiKey: key });
  const response = await ai.models.generateContent({
    model: 'gemini-2.0-flash-lite',
    contents: [{ role: 'user', parts: [{ text: (system ? system + '\n\n' : '') + prompt }] }],
    config: { maxOutputTokens: 8192 },
  });
  return response.text ?? '';
}

async function callDeepSeek(prompt: string, system?: string): Promise<string> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('DEEPSEEK_API_KEY not set');
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 8192,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
    }),
  });
  const data = await res.json() as any;
  if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? `DeepSeek ${res.status}`), { status: res.status });
  return data.choices?.[0]?.message?.content ?? '';
}

async function callGitHubModels(prompt: string, system?: string, model = 'gpt-4o'): Promise<string> {
  const key = process.env.GITHUB_TOKEN;
  if (!key) throw new Error('GITHUB_TOKEN not set');
  const res = await fetch('https://models.inference.ai.azure.com/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
    }),
  });
  const data = await res.json() as any;
  if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? `GitHub Models ${res.status}`), { status: res.status });
  return data.choices?.[0]?.message?.content ?? '';
}
