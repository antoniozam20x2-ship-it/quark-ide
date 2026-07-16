import { GoogleGenAI } from '@google/genai';
import { recordCall } from '../services/costTracker.js';

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
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash-lite',
];

// ── Provider result ───────────────────────────────────────────────────────────

interface ProviderResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  /** Normalized: 'end_turn' | 'max_tokens' | 'stop' | 'length' | 'MAX_TOKENS' | 'STOP' | 'unknown' */
  stopReason: string;
  provider: string;
  model: string;
}

/** Returns true when the model stopped because it hit its token ceiling. */
function wasTruncated(stopReason: string): boolean {
  return stopReason === 'max_tokens' || stopReason === 'length' || stopReason === 'MAX_TOKENS';
}

const CONTINUATION_SYSTEM =
  'Eres un asistente de continuación de código. Recibirás contenido generado que fue cortado ' +
  'abruptamente por el límite de tokens. Tu ÚNICA tarea: continuar EXACTAMENTE desde el punto ' +
  'de corte, sin repetir nada del contenido anterior, sin preámbulos ni comentarios de corte. ' +
  'Empieza directamente con el carácter o token que faltaba.';

// ── Provider dispatch ─────────────────────────────────────────────────────────

async function tryProviders(
  task: string,
  providers: Array<{ name: string; fn: () => Promise<ProviderResult> }>,
): Promise<ProviderResult> {
  const errors: string[] = [];
  for (const { name, fn } of providers) {
    try {
      const result = await fn();
      if (result?.text?.trim()) {
        // Log every successful call with real token counts
        recordCall(`studio/${task}`, result.tokensIn, result.tokensOut, {
          task: task.replace(/:cont\d+$/, ''),
          stopReason: result.stopReason,
          model: result.model,
        });
        if (wasTruncated(result.stopReason)) {
          console.warn(
            `[AI Router] ⚠️  stop_reason=${result.stopReason} on ${name} — ` +
            `output_tokens=${result.tokensOut} (truncation detected, continuation will fire)`,
          );
        } else {
          console.log(
            `[AI Router] ✓ ${name} | task=${task} | ` +
            `in=${result.tokensIn} out=${result.tokensOut} stop=${result.stopReason}`,
          );
        }
        return result;
      }
    } catch (err: any) {
      const is429 = err?.status === 429 || String(err).includes('429');
      const msg = err?.message ?? String(err);
      console.warn(`[AI Router] Provider failed${is429 ? ' (429)' : ''}:`, msg);
      errors.push(`${name}: ${msg}`);
    }
  }
  throw new Error(`Todos los proveedores fallaron:\n${errors.join('\n')}`);
}

/**
 * If the initial result was truncated, fires up to 2 continuation calls,
 * concatenating output each time. Only active for 'html' and 'edit' tasks.
 */
async function withContinuation(
  initial: ProviderResult,
  task: string,
  providerFactory: (contPrompt: string) => Array<{ name: string; fn: () => Promise<ProviderResult> }>,
): Promise<string> {
  if (!wasTruncated(initial.stopReason)) return initial.text;

  let accumulated = initial.text;
  let last = initial;
  let continuations = 0;

  while (wasTruncated(last.stopReason) && continuations < 2) {
    continuations++;
    console.warn(
      `[AI Router] Continuation ${continuations}/2 — task=${task} ` +
      `provider=${last.provider} stop=${last.stopReason} chars_so_far=${accumulated.length}`,
    );
    const contPrompt =
      `El siguiente HTML/código fue generado pero quedó cortado por el límite de tokens. ` +
      `Continúa EXACTAMENTE donde se cortó. NO repitas nada. NO agregues comentarios ni marcadores:\n\n` +
      accumulated;
    try {
      last = await tryProviders(`${task}:cont${continuations}`, providerFactory(contPrompt));
      accumulated += last.text;
    } catch (err) {
      console.error('[AI Router] Continuation failed, returning partial output:', err);
      break;
    }
  }

  console.log(
    `[AI Router] task=${task} complete — ${continuations} continuation(s) fired, ` +
    `total chars: ${accumulated.length}`,
  );
  return accumulated;
}

// ── callAI ────────────────────────────────────────────────────────────────────

export async function callAI(
  task: 'fix' | 'generate' | 'analyze' | 'html' | 'designer' | 'warroom' | 'edit',
  prompt: string,
  systemPrompt?: string,
): Promise<string> {
  const sys = systemPrompt ?? '';

  switch (task) {

    // ── Edición quirúrgica: Claude → GPT-4o ──────────────────────────────────
    case 'edit': {
      const editProviders = (p: string, s: string) => [
        { name: 'anthropic/claude-sonnet-4-5', fn: () => callAnthropic(p, s) },
        { name: 'github/gpt-4o',              fn: () => callGitHubModels(p, s, 'gpt-4o') },
      ];
      const result = await tryProviders(task, editProviders(prompt, sys));
      return withContinuation(result, task, (cp) => editProviders(cp, CONTINUATION_SYSTEM));
    }

    // ── Designer: Claude → GPT-4o → OpenRouter free chain ────────────────────
    case 'html':
    case 'designer': {
      const htmlProviders = (p: string, s: string) => [
        { name: 'anthropic/claude-sonnet-4-5',  fn: () => callAnthropic(p, s) },
        { name: 'github/gpt-4o',                fn: () => callGitHubModels(p, s, 'gpt-4o') },
        { name: 'openrouter/gemma-3-27b',        fn: () => callOpenRouter(p, s, 'google/gemma-3-27b-it:free') },
        // ⚠️  meta-llama/llama-3.3-70b-instruct:free retires 2026-07-19 — replace if unavailable
        { name: 'openrouter/llama-3.3-70b',     fn: () => callOpenRouter(p, s, 'meta-llama/llama-3.3-70b-instruct:free') },
        { name: 'openrouter/mistral-small-3.2', fn: () => callOpenRouter(p, s, 'mistralai/mistral-small-3.2-24b-instruct:free') },
      ];
      const result = await tryProviders(task, htmlProviders(prompt, sys));
      return withContinuation(result, task, (cp) => htmlProviders(cp, CONTINUATION_SYSTEM));
    }

    // ── Fix de código: Gemini → Groq → DeepSeek ──────────────────────────────
    case 'fix': {
      const lines = prompt.split('\n');
      const errorLineMatch = systemPrompt?.match(/línea (\d+)/);
      const errorLine = errorLineMatch ? parseInt(errorLineMatch[1]) : null;
      let optimizedPrompt = prompt;
      if (lines.length > 500 && errorLine) {
        const start = Math.max(0, errorLine - 150);
        const end   = Math.min(lines.length, errorLine + 150);
        const snippet = lines.slice(start, end).map((l, i) => `L${start + i + 1}: ${l}`).join('\n');
        optimizedPrompt = prompt.replace(/Archivo[^:]*:\n[\s\S]*/, `Archivo (líneas ${start}-${end}):\n${snippet}`);
      }
      return (await tryProviders(task, [
        { name: 'gemini',   fn: () => callGemini(optimizedPrompt, sys) },
        { name: 'gemini',   fn: () => callGemini(optimizedPrompt, sys) },
        { name: 'groq',     fn: () => callGroq(optimizedPrompt, sys) },
        { name: 'groq',     fn: () => callGroq(optimizedPrompt, sys) },
        { name: 'groq',     fn: () => callGroq(optimizedPrompt, sys) },
        { name: 'deepseek', fn: () => callDeepSeek(optimizedPrompt, sys) },
      ])).text;
    }

    // ── Generación general ────────────────────────────────────────────────────
    case 'generate':
      return (await tryProviders(task, [
        { name: 'gemini',   fn: () => callGemini(prompt, sys) },
        { name: 'gemini',   fn: () => callGemini(prompt, sys) },
        { name: 'groq',     fn: () => callGroq(prompt, sys) },
        { name: 'groq',     fn: () => callGroq(prompt, sys) },
        { name: 'groq',     fn: () => callGroq(prompt, sys) },
        { name: 'deepseek', fn: () => callDeepSeek(prompt, sys) },
      ])).text;

    // ── Análisis y War Room ───────────────────────────────────────────────────
    case 'analyze':
    case 'warroom':
      return (await tryProviders(task, [
        { name: 'gemini',   fn: () => callGemini(prompt, sys) },
        { name: 'gemini',   fn: () => callGemini(prompt, sys) },
        { name: 'groq',     fn: () => callGroq(prompt, sys) },
        { name: 'groq',     fn: () => callGroq(prompt, sys) },
        { name: 'groq',     fn: () => callGroq(prompt, sys) },
        { name: 'deepseek', fn: () => callDeepSeek(prompt, sys) },
      ])).text;
  }
}

// ── Provider implementations ──────────────────────────────────────────────────

async function callAnthropic(prompt: string, system: string): Promise<ProviderResult> {
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
      max_tokens: 8192,           // Claude sonnet-4-5 hard ceiling
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json() as any;
  if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? `Anthropic ${res.status}`), { status: res.status });
  return {
    text:       data.content?.[0]?.text ?? '',
    tokensIn:   data.usage?.input_tokens  ?? 0,
    tokensOut:  data.usage?.output_tokens ?? 0,
    stopReason: data.stop_reason ?? 'unknown',
    provider:   'anthropic',
    model:      data.model ?? 'claude-sonnet-4-5',
  };
}

async function callOpenRouter(
  prompt: string,
  system: string,
  model = 'google/gemma-3-27b-it:free',
): Promise<ProviderResult> {
  if (!OPENROUTER_KEYS.length) throw new Error('No OPENROUTER keys configured');
  const key = OPENROUTER_KEYS[openRouterIndex % OPENROUTER_KEYS.length];
  openRouterIndex++;
  // Free-tier real output ceiling (confirmed via OpenRouter API + free-tier behavior):
  //   gemma-3-27b-it:free          → 8192
  //   llama-3.3-70b-instruct:free  → 8192  ⚠️ retires 2026-07-19
  //   mistral-small-3.2-24b:free   → 8192
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
      max_tokens: 8192,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
    }),
  });
  const data = await res.json() as any;
  if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? `OpenRouter ${res.status}`), { status: res.status });
  return {
    text:       data.choices?.[0]?.message?.content ?? '',
    tokensIn:   data.usage?.prompt_tokens     ?? 0,
    tokensOut:  data.usage?.completion_tokens ?? 0,
    stopReason: data.choices?.[0]?.finish_reason ?? 'unknown',
    provider:   'openrouter',
    model,
  };
}

async function callGroq(prompt: string, system: string): Promise<ProviderResult> {
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
  return {
    text:       data.choices?.[0]?.message?.content ?? '',
    tokensIn:   data.usage?.prompt_tokens     ?? 0,
    tokensOut:  data.usage?.completion_tokens ?? 0,
    stopReason: data.choices?.[0]?.finish_reason ?? 'unknown',
    provider:   'groq',
    model:      'llama-3.3-70b-versatile',
  };
}

async function callGemini(prompt: string, system: string): Promise<ProviderResult> {
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
  const raw = response as any;
  return {
    text:       response.text ?? '',
    tokensIn:   raw.usageMetadata?.promptTokenCount     ?? 0,
    tokensOut:  raw.usageMetadata?.candidatesTokenCount ?? 0,
    stopReason: raw.candidates?.[0]?.finishReason       ?? 'unknown',
    provider:   'gemini',
    model,
  };
}

async function callDeepSeek(prompt: string, system: string): Promise<ProviderResult> {
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
  return {
    text:       data.choices?.[0]?.message?.content ?? '',
    tokensIn:   data.usage?.prompt_tokens     ?? 0,
    tokensOut:  data.usage?.completion_tokens ?? 0,
    stopReason: data.choices?.[0]?.finish_reason ?? 'unknown',
    provider:   'deepseek',
    model:      'deepseek-chat',
  };
}

async function callGitHubModels(
  prompt: string,
  system: string,
  model = 'gpt-4o',
): Promise<ProviderResult> {
  const key = process.env.GITHUB_TOKEN;
  if (!key) throw new Error('GITHUB_TOKEN not set');
  // gpt-4o on GitHub Models (Azure inference) supports 16384 output tokens (vs 4096 before)
  const res = await fetch('https://models.inference.ai.azure.com/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 16384,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
    }),
  });
  const data = await res.json() as any;
  if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? `GitHub Models ${res.status}`), { status: res.status });
  return {
    text:       data.choices?.[0]?.message?.content ?? '',
    tokensIn:   data.usage?.prompt_tokens     ?? 0,
    tokensOut:  data.usage?.completion_tokens ?? 0,
    stopReason: data.choices?.[0]?.finish_reason ?? 'unknown',
    provider:   'github',
    model,
  };
}
