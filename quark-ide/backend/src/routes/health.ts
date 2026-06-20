import { Router, Request, Response } from 'express';

const router = Router();

export interface ApiKeyStatus {
  name: string;
  status: 'ok' | 'rate_limited' | 'error' | 'not_configured';
  remaining?: number;
  reset?: string;
  resetAt?: number;
  balance?: string;
  latency?: number;
}

let cachedHealth: ApiKeyStatus[] | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60_000;
const PING_TIMEOUT_MS = 5_000;

function fmtDuration(ms: number): string {
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}

async function timedFetch(url: string, init: RequestInit): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseGroqResetHeader(header: string | null): { reset: string; resetAt: number } | null {
  if (!header) return null;
  const match = header.match(/^(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (!match || (!match[1] && !match[2])) return null;
  const minutes = parseInt(match[1] ?? '0', 10);
  const seconds = parseFloat(match[2] ?? '0');
  const totalMs = (minutes * 60 + seconds) * 1000;
  const reset = [minutes > 0 ? `${minutes}m` : '', `${Math.ceil(seconds)}s`].filter(Boolean).join(' ');
  return { reset, resetAt: Date.now() + totalMs };
}

async function pingGroqKey(key: string, index: number): Promise<ApiKeyStatus> {
  const name = `Groq #${index + 1}`;
  const start = Date.now();
  try {
    const res = await timedFetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const latency = Date.now() - start;
    const remaining = parseInt(res.headers.get('x-ratelimit-remaining-requests') ?? '-1', 10);
    const resetInfo = parseGroqResetHeader(res.headers.get('x-ratelimit-reset-requests'));
    if (res.status === 429) {
      return { name, status: 'rate_limited', remaining: 0, latency, ...(resetInfo ?? {}) };
    }
    if (!res.ok) return { name, status: 'error', latency };
    return {
      name,
      status: 'ok',
      latency,
      remaining: remaining >= 0 ? remaining : undefined,
      ...(resetInfo ?? {}),
    };
  } catch {
    return { name, status: 'error', latency: Date.now() - start };
  }
}

async function pingAnthropic(): Promise<ApiKeyStatus> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { name: 'Anthropic', status: 'not_configured' };
  const start = Date.now();
  try {
    const res = await timedFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const latency = Date.now() - start;
    const tokensRemaining = parseInt(res.headers.get('anthropic-ratelimit-tokens-remaining') ?? '-1', 10);
    const resetHeader = res.headers.get('anthropic-ratelimit-tokens-reset');
    let resetAt: number | undefined;
    if (resetHeader) {
      const ts = Date.parse(resetHeader);
      if (!isNaN(ts)) resetAt = ts;
    }
    if (res.status === 429) return { name: 'Anthropic', status: 'rate_limited', remaining: 0, latency };
    if (!res.ok) return { name: 'Anthropic', status: 'error', latency };
    return {
      name: 'Anthropic',
      status: 'ok',
      latency,
      remaining: tokensRemaining >= 0 ? tokensRemaining : undefined,
      reset: resetAt ? fmtDuration(resetAt - Date.now()) : undefined,
      resetAt,
    };
  } catch {
    return { name: 'Anthropic', status: 'error', latency: Date.now() - start };
  }
}

async function pingDeepSeek(): Promise<ApiKeyStatus> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return { name: 'DeepSeek', status: 'not_configured' };
  const start = Date.now();
  try {
    const res = await timedFetch('https://api.deepseek.com/user/balance', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
    });
    const latency = Date.now() - start;
    if (!res.ok) return { name: 'DeepSeek', status: 'error', latency };
    const data = await res.json() as {
      balance_infos?: Array<{ total_balance?: string; currency?: string }>;
    };
    const info = data.balance_infos?.[0];
    const balance = info?.total_balance != null
      ? `$${parseFloat(info.total_balance).toFixed(2)}`
      : undefined;
    return { name: 'DeepSeek', status: 'ok', latency, balance };
  } catch {
    return { name: 'DeepSeek', status: 'error', latency: Date.now() - start };
  }
}

async function pingOpenRouterKey(key: string, index: number): Promise<ApiKeyStatus> {
  const name = `OpenRouter #${index + 1}`;
  const start = Date.now();
  try {
    const res = await timedFetch('https://openrouter.ai/api/v1/auth/key', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
    });
    const latency = Date.now() - start;
    if (!res.ok) return { name, status: 'error', latency };
    const data = await res.json() as {
      data?: { limit_remaining?: number | null; usage?: number };
    };
    const limitRemaining = data.data?.limit_remaining;
    return {
      name,
      status: 'ok',
      latency,
      balance: limitRemaining != null
        ? `$${Number(limitRemaining).toFixed(2)} restante`
        : undefined,
    };
  } catch {
    return { name, status: 'error', latency: Date.now() - start };
  }
}

async function pingGeminiKey(key: string, index: number): Promise<ApiKeyStatus> {
  const name = `Gemini #${index + 1}`;
  const start = Date.now();
  try {
    const res = await timedFetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'hi' }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
      },
    );
    const latency = Date.now() - start;
    if (res.status === 429) return { name, status: 'rate_limited', latency };
    if (!res.ok) return { name, status: 'error', latency };
    return { name, status: 'ok', latency };
  } catch {
    return { name, status: 'error', latency: Date.now() - start };
  }
}

async function pingGitHub(): Promise<ApiKeyStatus> {
  const key = process.env.GITHUB_TOKEN;
  if (!key) return { name: 'GitHub', status: 'not_configured' };
  const start = Date.now();
  try {
    const res = await timedFetch('https://api.github.com/user', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'quark-ide' },
    });
    const latency = Date.now() - start;
    if (!res.ok) return { name: 'GitHub', status: 'error', latency };
    const remaining = parseInt(res.headers.get('x-ratelimit-remaining') ?? '-1', 10);
    const resetEpoch = parseInt(res.headers.get('x-ratelimit-reset') ?? '0', 10);
    const resetMs = resetEpoch * 1000;
    const diffMs = resetMs - Date.now();
    return {
      name: 'GitHub',
      status: 'ok',
      latency,
      remaining: remaining >= 0 ? remaining : undefined,
      reset: diffMs > 0 ? fmtDuration(diffMs) : undefined,
      resetAt: resetMs > 0 ? resetMs : undefined,
    };
  } catch {
    return { name: 'GitHub', status: 'error', latency: Date.now() - start };
  }
}

function checkRailway(): ApiKeyStatus {
  const key = process.env.RAILWAY_API_TOKEN;
  return { name: 'Railway', status: key ? 'ok' : 'not_configured' };
}

async function pingUnsplash(): Promise<ApiKeyStatus> {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) return { name: 'Unsplash', status: 'not_configured' };
  const start = Date.now();
  try {
    const res = await timedFetch('https://api.unsplash.com/me', {
      method: 'GET',
      headers: { Authorization: `Client-ID ${key}` },
    });
    const latency = Date.now() - start;
    if (!res.ok) return { name: 'Unsplash', status: 'error', latency };
    return { name: 'Unsplash', status: 'ok', latency };
  } catch {
    return { name: 'Unsplash', status: 'error', latency: Date.now() - start };
  }
}

async function runHealthCheck(): Promise<ApiKeyStatus[]> {
  const groqKeys = [
    process.env.GROQ_API_KEY,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
  ];
  const orKeys = [
    process.env.OPENROUTER_API_KEY,
    process.env.OPENROUTER_API_KEY_2,
    process.env.OPENROUTER_API_KEY_3,
  ];
  const geminiKeys = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
  ];

  const namedTasks: { name: string; promise: Promise<ApiKeyStatus> }[] = [
    ...groqKeys.map((k, i) => ({
      name: `Groq #${i + 1}`,
      promise: k
        ? pingGroqKey(k, i)
        : Promise.resolve<ApiKeyStatus>({ name: `Groq #${i + 1}`, status: 'not_configured' }),
    })),
    { name: 'Anthropic', promise: pingAnthropic() },
    { name: 'DeepSeek',  promise: pingDeepSeek() },
    ...orKeys.map((k, i) => ({
      name: `OpenRouter #${i + 1}`,
      promise: k
        ? pingOpenRouterKey(k, i)
        : Promise.resolve<ApiKeyStatus>({ name: `OpenRouter #${i + 1}`, status: 'not_configured' }),
    })),
    ...geminiKeys.map((k, i) => ({
      name: `Gemini #${i + 1}`,
      promise: k
        ? pingGeminiKey(k, i)
        : Promise.resolve<ApiKeyStatus>({ name: `Gemini #${i + 1}`, status: 'not_configured' }),
    })),
    { name: 'GitHub',   promise: pingGitHub() },
    { name: 'Unsplash', promise: pingUnsplash() },
  ];

  const settled = await Promise.allSettled(namedTasks.map((t) => t.promise));
  const results = settled.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : ({ name: namedTasks[i].name, status: 'error' } as ApiKeyStatus),
  );

  results.push(checkRailway());
  return results;
}

router.get('/', async (req: Request, res: Response) => {
  const forceRefresh = req.query.refresh === 'true';
  const now = Date.now();

  if (!forceRefresh && cachedHealth && now - cachedAt < CACHE_TTL_MS) {
    res.json({ results: cachedHealth, cachedAt, fromCache: true });
    return;
  }

  try {
    const results = await runHealthCheck();
    cachedHealth = results;
    cachedAt = Date.now();
    res.json({ results, cachedAt, fromCache: false });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Health check failed' });
  }
});

export default router;
