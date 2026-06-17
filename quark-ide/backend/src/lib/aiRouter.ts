import { GoogleGenAI } from '@google/genai';

const OPENROUTER_KEYS = [
  process.env.OPENROUTER_API_KEY,
  process.env.OPENROUTER_API_KEY_2,
  process.env.OPENROUTER_API_KEY_3,
].filter(Boolean) as string[];

const GROQ_KEYS = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
].filter(Boolean) as string[];

const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
].filter(Boolean) as string[];

let openRouterIndex  = 0;
let groqIndex        = 0;
let geminiIndex      = 0;
let geminiModelIndex = 0;

const GEMINI_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
];

export async function callAI(
  task: 'fix' | 'generate' | 'analyze' | 'html' | 'designer' | 'warroom',
  prompt: string,
  systemPrompt?: string,
): Promise<string> {
  switch (task) {

    // ── Designer exclusivo: OpenRouter (Gemma free) → GitHub fallback ──
    case 'html':
    case 'designer':
      return tryProviders([
        () => callAnthropic(prompt, systemPrompt),
        () => callGitHubModels(prompt, systemPrompt, 'gpt-4o'),
        () => callOpenRouter(prompt, systemPrompt, 'google/gemma-3-27b-it:free'),
        () => callOpenRouter(prompt, systemPrompt, 'meta-llama/llama-3.3-70b-instruct:free'),
        () => callOpenRouter(prompt, systemPrompt, 'mistralai/mistral-small-3.2-24b-instruct:free'),
      ]);

    // ── Fix de código: Gemini → Groq → DeepSeek ──
    case 'fix': {
      const lines = prompt.split('\n');
      const errorLineMatch = systemPrompt?.match(/línea (\d+)/);
      const errorLine = errorLineMatch ? parseInt(errorLineMatch[1]) : null;

      let optimizedPrompt = prompt;
      if (lines.length > 500 && errorLine) {
        const start = Math.max(0, errorLine - 150);
        const end = Math.min(lines.length, errorLine + 150);
        const snippet = lines.slice(start, end)
          .map((l, i) => `L${start + i + 1}: ${l}`)
          .join('\n');
        optimizedPrompt = prompt.replace(
          /Archivo[^:]*:\n[\s\S]*/,
          `Archivo (líneas ${start}-${end}):\n${snippet}`,
        );
      }

      return tryProviders([
        () => callGemini(optimizedPrompt, systemPrompt),
        () => callGemini(optimizedPrompt, systemPrompt),
        () => callGroq(optimizedPrompt, systemPrompt),
        () => callGroq(optimizedPrompt, systemPrompt),
        () => callGroq(optimizedPrompt, systemPrompt),
        () => callDeepSeek(optimizedPrompt, systemPrompt),
      ]);
    }

    // ── Generación general: Gemini → Groq → DeepSeek ──
    case 'generate':
      return tryProviders([
        () => callGemini(prompt, systemPrompt),
        () => callGemini(prompt, systemPrompt),
        () => callGroq(prompt, systemPrompt),
        () => callGroq(prompt, systemPrompt),
        () => callGroq(prompt, systemPrompt),
        () => callDeepSeek(prompt, systemPrompt),
      ]);

    // ── Análisis y War Room: Gemini → Groq → DeepSeek ──
    case 'analyze':
    case 'warroom':
      return tryProviders([
        () => callGemini(prompt, systemPrompt),
        () => callGemini(prompt, systemPrompt),
        () => callGroq(prompt, systemPrompt),
        () => callGroq(prompt, systemPrompt),
        () => callGroq(prompt, systemPrompt),
        () => callDeepSeek(prompt, systemPrompt),
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

async function callAnthropic(prompt: string, system?: string): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 8192,
      system: system ?? '',
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json() as any;
  if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? `Anthropic ${res.status}`), { status: res.status });
  return data.content?.[0]?.text ?? '';
}

async function callOpenRouter(prompt: string, system?: string, model = 'google/gemma-3-27b-it:free'): Promise<string> {
  if (!OPENROUTER_KEYS.length) throw new Error('No OPENROUTER keys configured');
  const key = OPENROUTER_KEYS[openRouterIndex % OPENROUTER_KEYS.length];
  openRouterIndex++;
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://quark-ide.railway.app',
      'X-Title': 'QUARK IDE',
    },
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
  if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? `OpenRouter ${res.status}`), { status: res.status });
  return data.choices?.[0]?.message?.content ?? '';
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
  const model = GEMINI_MODELS[geminiModelIndex % GEMINI_MODELS.length];
  geminiModelIndex++;
  const ai = new GoogleGenAI({ apiKey: key });
  const response = await ai.models.generateContent({
    model,
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
