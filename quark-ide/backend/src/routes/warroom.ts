import { Router, Request, Response } from 'express';
import { generateContent, GeminiAuthError } from '../services/gemini.js';
import { saveToMemory } from '../services/rufloMemory.js';

// ── Provider constants ────────────────────────────────────────────────────────

const GROQ_URL      = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL    = 'llama-3.3-70b-versatile';
const DEEPSEEK_URL  = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';
const PROVIDER_TIMEOUT_MS = 25_000;

// ── HTTP helper ───────────────────────────────────────────────────────────────

function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<globalThis.Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// ── Groq — rotates across up to 3 keys ───────────────────────────────────────

function getGroqKeys(): string[] {
  return [
    process.env.GROQ_API_KEY,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
  ].filter((k): k is string => Boolean(k));
}

async function callGroqWithKey(
  key: string,
  prompt: string,
  systemPrompt: string,
  maxTokens = 1024,
): Promise<string> {
  const res = await fetchWithTimeout(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: prompt },
      ],
    }),
  }, PROVIDER_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Groq error: ${res.status} ${res.statusText}`);
  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? '';
}

/** Try Groq keys in order (GROQ_API_KEY → GROQ_API_KEY_2 → GROQ_API_KEY_3). */
async function callGroqRotated(
  prompt: string,
  systemPrompt: string,
  maxTokens = 1024,
): Promise<string> {
  const keys = getGroqKeys();
  if (keys.length === 0) throw new Error('No GROQ_API_KEY configured');

  let lastErr: Error = new Error('No Groq keys available');
  for (const key of keys) {
    try {
      return await callGroqWithKey(key, prompt, systemPrompt, maxTokens);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      console.warn(`[warroom] Groq key …${key.slice(-4)} failed: ${lastErr.message}`);
    }
  }
  throw lastErr;
}

// ── DeepSeek ──────────────────────────────────────────────────────────────────

async function callDeepSeek(
  prompt: string,
  systemPrompt: string,
  maxTokens = 1024,
): Promise<string> {
  const token = process.env.DEEPSEEK_API_KEY;
  if (!token) throw new Error('DEEPSEEK_API_KEY is not set');
  const res = await fetchWithTimeout(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: prompt },
      ],
    }),
  }, PROVIDER_TIMEOUT_MS);
  if (!res.ok) throw new Error(`DeepSeek error: ${res.status} ${res.statusText}`);
  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? '';
}

// ── Fallback chain ────────────────────────────────────────────────────────────

/** Run providers in order, stopping at the first success.
 *  GeminiAuthError on a provider skips it immediately (no retry). */
async function withFallbackChain(
  providers: Array<{ fn: () => Promise<string>; label: string }>,
): Promise<string> {
  let lastErr: Error = new Error('All providers failed');
  for (const { fn, label } of providers) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof GeminiAuthError) {
        console.error(`[warroom] ${label} — Gemini 401 (key invalid), skipping immediately`);
      } else {
        console.warn(`[warroom] ${label} failed: ${(err as Error).message}`);
      }
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr;
}

// ── Signal OS report fetch ────────────────────────────────────────────────────

async function fetchSignalOSReport(): Promise<string | null> {
  try {
    const res = await fetch(
      'https://workspaceapi-server-production-f248.up.railway.app/api/stats/daily-report',
      { signal: AbortSignal.timeout(5000) },
    );
    const data = await res.json() as { status?: string; report?: string };
    if (data.status === 'no_report' || !data.report) return null;
    return data.report;
  } catch {
    return null;
  }
}

// ── Sniper OS report fetch ────────────────────────────────────────────────────

async function fetchSniperOSReport(): Promise<string | null> {
  try {
    const res = await fetch(
      'https://workspacesniper-os-production.up.railway.app/api/oracle-report',
      { signal: AbortSignal.timeout(5000) },
    );
    const data = await res.json() as {
      summary?: string;
      risk_level?: string;
      recomendacion?: string;
      fortalezas?: string[];
      debilidades?: string[];
    };
    if (!data.summary) return null;

    let report = data.summary;
    if (data.risk_level)          report += `\n\nNivel de riesgo actual: ${data.risk_level.toUpperCase()}`;
    if (data.recomendacion)       report += `\nAcción recomendada: ${data.recomendacion}`;
    if (data.fortalezas?.length)  report += `\nFortalezas: ${data.fortalezas.join(', ')}`;
    if (data.debilidades?.length) report += `\nDebilidades: ${data.debilidades.join(', ')}`;

    return report;
  } catch {
    return null;
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

const router = Router();

// ── Context builder ───────────────────────────────────────────────────────────

const BASE_CONTEXT = `Eres parte del War Room de Jefferson, trader especializado en crypto futures con metodología SMC/ICT operando en Bitget USDT-M.
Jefferson construye su ecosistema de apps en Railway con React/TypeScript/Vite frontend + Node.js/Express backend + PostgreSQL.
Su filosofía: un cambio a la vez, calidad sobre cantidad.`;

const APP_CONTEXTS: Record<string, string> = {
  'Signal OS': `
App bajo análisis: Signal OS (repo: Ahorar)
Bot autónomo de crypto futures en Bitget USDT-M.
Stack: React/TypeScript frontend + Node.js/Express backend + PostgreSQL.
Features clave: scoring SMC/ICT, filtro CoinMarketCap 30 pares, trailing stops nativos Bitget, circuit breakers, streak protection (3 SL losses → 30min pause), bias engine BTC 1H multi-tier, módulo de aprendizaje, análisis institucional (OI, LS ratio, funding).
Parámetros actuales: 0.5% risk/trade, 2% SL, 4.5% TP, 10x leverage, isolated margin, hedge mode, trailing stop nativo Bitget (moving_plan, rangeRate: 2.0).
ENFÓCATE EXCLUSIVAMENTE en Signal OS. No menciones otras apps.`,

  'Sniper OS': `
App bajo análisis: Sniper OS (repo: Trade-SnipeOS)
Bot de entradas precisas en Bitget USDT-M, señales server-side 24/7.
Stack: React/TypeScript frontend + Node.js/Express backend + PostgreSQL.
Features clave: entry logic signal-type-aware (P1-P4: S1 RVOL, S2 SMC, S6 FVG, S3/S5 pullback), TTL 30min en señales, gate precio ≤2%, CRON EXPIRED cada 60s, BaseRadarEngine S1-S6, Lightweight Charts v4.1.3, radar de mercado, heatmap, Intel tab.
Parámetros: 0.5% risk/trade, 2% SL, 4.5% TP, 5x leverage, trailing stop nativo Bitget (rangeRate 2.0).
ENFÓCATE EXCLUSIVAMENTE en Sniper OS. No menciones otras apps.`,

  'Nexus OS': `
App bajo análisis: Nexus OS (repo: NEXUS-OS-app)
Bot spot trading en OKX — actualmente PAUSADO.
Razón: mercado en régimen ranging, no apto para spot.
Stack: React/TypeScript frontend + Node.js/Express backend + PostgreSQL.
Features diseñadas: CoinMarketCap/CoinGecko asset discovery, conviction-based position sizing, DCA support.
Estado: arquitectura lista, pendiente de activación cuando el mercado presente tendencia clara.
ENFÓCATE EXCLUSIVAMENTE en Nexus OS. No menciones otras apps.`,

  'Core AI': `
App bajo análisis: Core AI (repo: Code-Coretest)
Multi-agent boardroom con 7 agentes: ATLAS, HELIX, VEGA, TECHNO, CIPHER, SIGMA, ORACLE. 4 modos de sesión (weekly audit, project analysis, due diligence, Intel briefing).
Proveedores: Groq, Gemini, Mistral, SambaNova, DeepSeek R1, OpenRouter.
ENFÓCATE EXCLUSIVAMENTE en Core AI. No menciones otras apps.`,

  'Quark IDE': `
App bajo análisis: Quark IDE (repo: quark-ide)
IDE propio con IA. React/TypeScript/Vite + Node.js/Express + PostgreSQL.
Features clave: Chat inteligente con contexto de repos, Studio 4 agentes, War Room SWARM paralelo, Quark Agent con diff visual GitHub, Debugger Railway logs, Preview automático, router 6 APIs.
ENFÓCATE EXCLUSIVAMENTE en Quark IDE. No menciones otras apps.`,
};

interface RepoContextPayload {
  tree: string[];
  keyFiles: { path: string; content: string }[];
}

function buildContext(
  appName: string | null,
  repoContext?: RepoContextPayload,
  signalReport?: string | null,
  sniperReport?: string | null,
): string {
  const appCtx = appName ? (APP_CONTEXTS[appName] ?? '') : '';
  let repoCtx = '';
  if (repoContext && (repoContext.tree.length > 0 || repoContext.keyFiles.length > 0)) {
    const treeStr = repoContext.tree.slice(0, 80).join('\n');
    const filesStr = repoContext.keyFiles
      .map((f) => {
        const lines = f.content.split('\n')
        const truncated = lines.length > 200
          ? lines.slice(0, 200).join('\n') + `\n// ... (${lines.length - 200} líneas más)`
          : f.content
        return `--- ${f.path} ---\n${truncated}`
      })
      .join('\n\n');
    repoCtx = `\n\nCódigo real del repositorio:\n\nEstructura de archivos:\n${treeStr}\n\nArchivos clave:\n${filesStr}`;
  }
  let reportCtx = '';
  if (appName === 'Signal OS' && signalReport) {
    reportCtx = `\n\nREPORTE DE TRADING HOY (datos reales):\n${signalReport}\n\nUsa estos datos reales para dar un diagnóstico preciso. No inventes métricas — usa exactamente los números del reporte.`;
  }
  if (appName === 'Sniper OS' && sniperReport) {
    reportCtx = `\n\nREPORTE DEL ORÁCULO HOY (datos reales):\n${sniperReport}\n\nUsa estos datos reales para dar un diagnóstico preciso. No inventes métricas.`;
  }
  return BASE_CONTEXT + appCtx + repoCtx + reportCtx;
}

// ── Board roles ───────────────────────────────────────────────────────────────

const BOARD_ROLES: Record<string, string> = {
  CEO: `You are a decisive business strategist and the CEO advisor on Jefferson's personal board of directors.
Your lens is business strategy and ROI. Evaluate challenges from the angle of product-market fit, monetization potential, competitive moat, and what delivers value fastest. Be direct, opinionated, and strategic. Prioritize ruthlessly.`,

  CTO: `You are a senior software architect and the CTO advisor on Jefferson's personal board of directors.
Your lens is technical excellence. Evaluate challenges from the angle of technical feasibility, system design, scalability, latency, and implementation risk. Recommend specific libraries, patterns, and architecture decisions. Always favor production-ready, battle-tested solutions.`,

  Designer: `You are a UI/UX designer and the Design advisor on Jefferson's personal board of directors.
Your lens is user experience and visual design. Jefferson's signature aesthetic: neon green (#00ff88) on near-black backgrounds, JetBrains Mono font, glowing borders, dense data-rich layouts for a single power user. Evaluate challenges from the angle of UX flows, component design, and visual hierarchy.`,

  QA: `You are a QA engineer, risk analyst, and the Quality advisor on Jefferson's personal board of directors.
Your lens is risk, reliability, and edge cases. Evaluate challenges from the angle of what could go wrong, failure modes, testing strategies, and safety mechanisms. Always recommend circuit breakers, logging, and graceful degradation.`,

  DEBUGGER: `You are a senior debugging specialist and the Debugger advisor on Jefferson's personal board of directors.
Your lens is root cause analysis and rapid error resolution. You specialize in reading Railway deployment logs, TypeScript/Node.js stack traces, PostgreSQL query errors, and React runtime exceptions. Always suggest the minimal targeted fix rather than broad refactors.`,
};

const THINK_SYSTEM = `You are QUARK, Jefferson's personal AI development co-founder and senior architect.

${BASE_CONTEXT}

When Jefferson brings you a project idea or technical challenge, analyze it with full knowledge of his existing ecosystem. Default to his established stack unless there is a strong reason to deviate — and if you deviate, explain why explicitly. Format your response with clear sections using these exact headers: ## Project Overview, ## Recommended Architecture, ## Database Design, ## UI/UX Recommendations, ## Development Phases, ## Potential Challenges. Be specific, technical, and actionable. Provide production-ready guidance that fits seamlessly into his Railway monorepo workflow.`;

// ── Provider chain: Groq (rotated) → DeepSeek → Gemini ───────────────────────

function buildProviderChain(
  prompt: string,
  systemPrompt: string,
  maxTokens: number,
  geminiEndpoint: string,
): Array<{ fn: () => Promise<string>; label: string }> {
  return [
    {
      label: 'Groq(rotated)',
      fn: () => callGroqRotated(prompt, systemPrompt, maxTokens),
    },
    {
      label: 'DeepSeek',
      fn: () => callDeepSeek(prompt, systemPrompt, maxTokens),
    },
    {
      label: 'Gemini(last-resort)',
      fn: () => generateContent(prompt, systemPrompt, maxTokens, geminiEndpoint),
    },
  ];
}

// ── Claude Extended Thinking ──────────────────────────────────────────────────

async function callClaudeWithThinking(
  prompt: string,
  systemPrompt: string,
  budgetTokens: number,
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'interleaved-thinking-2025-05-14',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      thinking: {
        type: 'enabled',
        budget_tokens: budgetTokens,
      },
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    }),
  }, PROVIDER_TIMEOUT_MS);

  if (!res.ok) throw new Error(`Claude error: ${res.status} ${res.statusText}`);
  const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
  return (data.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}

const THINKING_BUDGETS: Record<string, number> = {
  CEO: 3000, CTO: 4000, Designer: 1500, QA: 2000, DEBUGGER: 2000,
};

// ── Board member dispatch ─────────────────────────────────────────────────────

const DESIGNER_TRADING_ROLE = `Eres el especialista en visualización de datos y experiencia de monitoreo del War Room.
Tu enfoque: ¿Los dashboards muestran la información crítica de forma clara? ¿El trader puede tomar decisiones rápidas con lo que ve? ¿Hay métricas importantes que no están visibles? ¿La UI comunica riesgo de forma efectiva?
Analiza cómo mejorar la visibilidad operacional del sistema de trading.`;

const TRADING_APPS = new Set(['Signal OS', 'Sniper OS']);

async function callBoardMember(
  member: string,
  challenge: string,
  appName: string | null,
  repoContext?: RepoContextPayload,
  signalReport?: string | null,
  sniperReport?: string | null,
  useClaudeThinking?: boolean,
): Promise<string> {
  let roleDesc = BOARD_ROLES[member];
  if (!roleDesc) throw new Error(`Invalid member: ${member}`);
  if (member === 'Designer' && appName && TRADING_APPS.has(appName)) {
    roleDesc = DESIGNER_TRADING_ROLE;
  }

  // CEO y Designer trabajan con contexto de negocio, no con código
  const codeAgents = new Set(['CTO', 'QA', 'DEBUGGER']);
  const isVisualBug = /bug|error|broken|roto|falla|no muestra|no carga/i.test(challenge);
  const needsCode = codeAgents.has(member) || (member === 'Designer' && isVisualBug);
  const contextForMember = needsCode ? repoContext : undefined;

  const systemPrompt = `${roleDesc}\n\n${buildContext(appName, contextForMember, signalReport, sniperReport)}`;

  if (useClaudeThinking && process.env.ANTHROPIC_API_KEY) {
    try {
      return await callClaudeWithThinking(challenge, systemPrompt, THINKING_BUDGETS[member] ?? 2000);
    } catch (err) {
      console.warn(`[warroom] Claude thinking failed for ${member}: ${(err as Error).message} — falling back`);
    }
  }

  return withFallbackChain(
    buildProviderChain(challenge, systemPrompt, 1024, `/api/warroom/board/${member}`)
  );
}

// ── Consensus synthesis ───────────────────────────────────────────────────────

async function generateConsensus(
  challenge: string,
  responses: Record<string, string>,
  useClaudeThinking?: boolean,
): Promise<string> {
  const synthesis = `Original challenge: ${challenge}

Board responses:
CEO: ${responses.CEO}

CTO: ${responses.CTO}

Designer: ${responses.Designer}

QA: ${responses.QA}

Synthesize all four perspectives into 3-5 clear, actionable consensus items. Be decisive and specific. Reference the actual content from each board member's input. Jefferson needs a clear action plan.`;

  const systemPrompt = `${BOARD_ROLES.CEO}\n\n${BASE_CONTEXT}`;

  if (useClaudeThinking && process.env.ANTHROPIC_API_KEY) {
    try {
      return await callClaudeWithThinking(synthesis, systemPrompt, 3000);
    } catch (err) {
      console.warn(`[warroom] Claude thinking failed for consensus: ${(err as Error).message} — falling back`);
    }
  }

  return withFallbackChain(
    buildProviderChain(synthesis, systemPrompt, 1024, '/api/warroom/consensus')
  );
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.post('/think', async (req: Request, res: Response) => {
  const { idea, options } = req.body as {
    idea: string;
    options?: {
      includeTechStack?: boolean;
      includeDatabase?: boolean;
      includeUX?: boolean;
      mode?: string;
    };
  };

  const modeNote = options?.mode ? `\n\nAnalysis mode: ${options.mode}.` : '';
  const extras = [
    options?.includeTechStack && 'Include detailed tech stack recommendations that align with his existing Railway/TypeScript/React ecosystem.',
    options?.includeDatabase  && 'Include detailed PostgreSQL schema design consistent with his existing database patterns.',
    options?.includeUX        && 'Include detailed UI/UX recommendations that match his cyberpunk neon green/black aesthetic.',
  ]
    .filter(Boolean)
    .join(' ');

  const prompt = `${idea}${modeNote}${extras ? '\n\n' + extras : ''}`;

  try {
    const result = await withFallbackChain(
      buildProviderChain(prompt, THINK_SYSTEM, 4096, '/api/warroom/think')
    );
    res.json({ result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: msg });
  }
});

router.post('/board', async (req: Request, res: Response) => {
  const { challenge, member, appName, repoContext } = req.body as {
    challenge: string;
    member: 'CEO' | 'CTO' | 'Designer' | 'QA' | 'DEBUGGER';
    appName?: string;
    repoContext?: RepoContextPayload;
  };

  if (!BOARD_ROLES[member]) {
    res.status(400).json({ error: 'Invalid board member' });
    return;
  }

  try {
    const response = await callBoardMember(member, challenge, appName ?? null, repoContext);
    res.json({ role: member, response });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: msg });
  }
});

router.post('/swarm', async (req: Request, res: Response) => {
  const { challenge, appName, repoContext, useClaudeThinking } = req.body as {
    challenge: string;
    appName?: string;
    repoContext?: RepoContextPayload;
    useClaudeThinking?: boolean;
  };
  if (!challenge?.trim()) {
    res.status(400).json({ error: 'challenge is required' });
    return;
  }

  const resolvedApp = appName ?? null;
  const start = Date.now();
  try {
    let signalReport: string | null = null;
    let sniperReport: string | null = null;
    if (resolvedApp === 'Signal OS') {
      signalReport = await fetchSignalOSReport();
    }
    if (resolvedApp === 'Sniper OS') {
      sniperReport = await fetchSniperOSReport();
    }

    const [ceo, cto, designer, qa] = await Promise.all([
      callBoardMember('CEO',      challenge, resolvedApp, repoContext, signalReport, sniperReport, useClaudeThinking),
      callBoardMember('CTO',      challenge, resolvedApp, repoContext, signalReport, sniperReport, useClaudeThinking),
      callBoardMember('Designer', challenge, resolvedApp, repoContext, signalReport, sniperReport, useClaudeThinking),
      callBoardMember('QA',       challenge, resolvedApp, repoContext, signalReport, sniperReport, useClaudeThinking),
    ]);

    const consensus = await generateConsensus(challenge, { CEO: ceo, CTO: cto, Designer: designer, QA: qa }, useClaudeThinking);

    // Guardar consensus en memoria persistente
    try {
      const memoryKey = `warroom-${(resolvedApp ?? 'general').toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`;
      await saveToMemory(
        memoryKey,
        `[War Room - ${resolvedApp ?? 'General'} - ${new Date().toISOString()}]\n${consensus}`,
        'war-room'
      );
    } catch { /* no bloquear la respuesta si falla */ }

    res.json({
      ceo,
      cto,
      designer,
      qa,
      consensus,
      processingTime: Date.now() - start,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: msg });
  }
});

router.post('/search', async (req: Request, res: Response) => {
  const { query } = req.body as { query: string };

  const searchSystem = `You are QUARK, Jefferson's personal AI development co-founder with deep search and research capabilities.

${BASE_CONTEXT}

When Jefferson searches for something, answer with full context of his ecosystem. If the query relates to his projects, reference specific implementation details. If it's a general technical question, frame the answer in terms of how it applies to his Railway/TypeScript/React/PostgreSQL stack. Be thorough, specific, and immediately actionable.`;

  try {
    const result = await withFallbackChain(
      buildProviderChain(query, searchSystem, 2048, '/api/warroom/search')
    );
    res.json({ result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: msg });
  }
});

export default router;
