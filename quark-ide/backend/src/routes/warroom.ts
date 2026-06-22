import { Router, Request, Response } from 'express';
import { generateContent, GeminiAuthError } from '../services/gemini.js';
import { saveToMemory } from '../services/rufloMemory.js';
import { loadSharedAgentContext } from './chat.js';
import { saveAgentContext } from './agent.js';
import { getFileTree, getFileContent, searchCodeInRepo } from '../services/github.js';

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

// ── appName display → GitHub repo name ───────────────────────────────────────

const APP_NAME_TO_REPO: Record<string, string> = {
  'Signal OS': 'Ahorar',
  'Sniper OS': 'Trade-SnipeOS',
  'Nexus OS':  'NEXUS-OS-app',
  'Core AI':   'Code-Coretest',
  'Quark IDE': 'quark-ide',
};

async function extractSearchTermsWithAI(challenge: string): Promise<string[]> {
  const keys = getGroqKeys();
  if (keys.length === 0) return [];

  try {
    const res = await fetchWithTimeout(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${keys[0]}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        max_tokens: 60,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: `Eres un extractor de términos técnicos para búsqueda en GitHub Code Search.
Dado un challenge sobre un bot de crypto trading en TypeScript, responde 
ÚNICAMENTE con un JSON array de máximo 4 strings.

Reglas de mapeo:
- Cualquier pregunta sobre señales S1/S2/S3/S4/S5/S6, scoring, 
  FVG, indicadores → ["fEval", "tradingLogic", "checkS6Bull", "smartScore"]
- ADX, RSI, EMA, Supertrend, indicadores técnicos → ["tradingLogic", "calcADX", "fEval"]
- screener, scanner, filtro → ["tradingLogic", "fEval", "screener"]
- bias, mercado, BTC → ["biasEngine", "bias"]
- trailing, stop → ["trailingStop", "moving_plan"]
- circuit breaker, streak → ["circuitBreaker", "streak"]
- Prioriza SIEMPRE archivos en lib/ o services/ del api-server, 
  NUNCA archivos .tsx, context/, components/
Responde SOLO el array JSON, sin explicación, sin backticks`,
          },
          {
            role: 'user',
            content: challenge,
          },
        ],
      }),
    }, 8_000);

    if (!res.ok) return [];
    const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const raw = json.choices?.[0]?.message?.content ?? '[]';
    const parsed = JSON.parse(raw.trim()) as unknown;
    if (Array.isArray(parsed) && parsed.every((t) => typeof t === 'string')) {
      console.log(`[warroom] AI extracted search terms: [${parsed.join(', ')}]`);
      return parsed as string[];
    }
    return [];
  } catch (err) {
    console.warn('[warroom] extractSearchTermsWithAI failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

async function searchWithAITerms(
  challenge: string,
  repoName: string,
): Promise<{ path: string }[]> {
  const terms = await extractSearchTermsWithAI(challenge);

  if (terms.length === 0) {
    const fallbackWords = challenge.split(/\s+/).filter(w => w.length > 4).slice(0, 2);
    console.log(`[warroom] No AI terms, fallback words: [${fallbackWords.join(', ')}]`);
    if (fallbackWords.length === 0) return [];
    return searchCodeInRepo(fallbackWords.join(' '), repoName);
  }

  const EXCLUDED_PATHS = [
    'attached_assets/',
    'replit.md',
    '.txt',
    'README',
    'node_modules/',
    '.md',
    'context/',
    'components/',
    'mobile/',
  ];

  function isCodeFile(path: string): boolean {
    return !EXCLUDED_PATHS.some((exclude) => path.includes(exclude));
  }

  for (const term of terms) {
    const results = await searchCodeInRepo(term, repoName);
    const codeOnly = results.filter((r) => isCodeFile(r.path));

    if (codeOnly.length > 0) {
      console.log(`[warroom] Term "${term}" → ${codeOnly.length} code files: ${codeOnly.map(r => r.path).join(', ')}`);
      return codeOnly;
    }

    if (results.length > 0) {
      console.log(`[warroom] Term "${term}" → ${results.length} results but all non-code, trying next term...`);
    } else {
      console.log(`[warroom] Term "${term}" → 0 results, trying next term...`);
    }
  }

  return [];
}

async function isCacheRelevant(
  files: { path: string; content: string }[],
  challenge: string,
): Promise<boolean> {
  const terms = await extractSearchTermsWithAI(challenge);
  if (terms.length === 0) return true;

  const combined = files
    .map((f) => f.path + ' ' + f.content)
    .join(' ')
    .toLowerCase();

  const hasMatch = terms.some((term) => combined.toLowerCase().includes(term.toLowerCase()));

  if (!hasMatch) {
    console.log(
      `[warroom] Caché irrelevante para challenge — términos [${terms.join(', ')}] no encontrados en archivos cacheados`,
    );
  }
  return hasMatch;
}

async function resolveRepoContext(
  appName: string | null | undefined,
  challenge: string,
  repoContext?: RepoContextPayload,
): Promise<RepoContextPayload | undefined> {
  // Step 1: frontend sent real content → use it as-is
  if (repoContext && (repoContext.tree.length > 0 || repoContext.keyFiles.length > 0)) {
    return repoContext;
  }

  const repoName = appName ? APP_NAME_TO_REPO[appName] : undefined;
  if (!repoName) return undefined;

  // Step 2: try the shared cache written by Agent
  try {
    const cached = await loadSharedAgentContext(repoName);
    if (cached && cached.preloadedFiles.length > 0) {
      const keyFiles = cached.preloadedFiles.map((f) => ({
        path: f.path,
        content: f.content,
      }));

      const relevant = await isCacheRelevant(keyFiles, challenge);
      if (relevant) {
        console.log(`[warroom] Caché relevante — usando ${keyFiles.length} archivo(s) cacheados`);
        return {
          tree: keyFiles.map((f) => f.path),
          keyFiles,
        };
      }
      console.log(`[warroom] Caché ignorado — yendo a GitHub Search`);
    }
  } catch { /* non-blocking */ }

  // Step 3: nothing cached — smart GitHub search based on the challenge
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_OWNER) return undefined;
  try {
    console.log(`[warroom] Fetching fresh GitHub context for ${repoName} with query: "${challenge}"`);

    const searchResults = await searchWithAITerms(challenge, repoName);

    if (searchResults.length === 0) {
      console.warn(`[warroom] No search results for any AI-extracted term from "${challenge}" in ${repoName}`);
      return undefined;
    }

    const topPaths = searchResults.slice(0, 5).map((r) => r.path);

    const results = await Promise.allSettled(
      topPaths.map(async (p) => ({ path: p, content: await getFileContent(p, repoName, 'main') })),
    );

    const keyFiles = results
      .filter((r): r is PromiseFulfilledResult<{ path: string; content: string }> => r.status === 'fulfilled')
      .map((r) => r.value)
      .filter((f) => f.content.length <= 15_000);

    if (keyFiles.length === 0) {
      console.warn(`[warroom] All found files exceeded 15k char limit, skipping`);
    }

    if (keyFiles.length > 0) {
      console.log(`[warroom] Found ${keyFiles.length} relevant files: ${keyFiles.map((f) => f.path).join(', ')}`);

      await saveAgentContext({
        preloadedFiles: keyFiles,
        functionName:   null,
        prompt:         `[warroom auto-load for ${appName}: ${challenge}]`,
        repo:           repoName,
      }).catch(() => { /* non-blocking */ });

      console.log(`[warroom] Cached ${keyFiles.length} files for ${repoName}`);
      return { tree: keyFiles.map((f) => f.path), keyFiles };
    }
  } catch (err) {
    console.warn(`[warroom] GitHub search failed for ${repoName}:`, err instanceof Error ? err.message : err);
  }

  return undefined;
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
        const truncated = lines.length > 120
          ? lines.slice(0, 120).join('\n') + `\n// ... (${lines.length - 120} líneas más)`
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
      label: 'Gemini(first)',
      fn: () => generateContent(prompt, systemPrompt, maxTokens, geminiEndpoint),
    },
    {
      label: 'Groq(fallback)',
      fn: () => callGroqRotated(prompt, systemPrompt, maxTokens),
    },
    {
      label: 'DeepSeek(fallback)',
      fn: () => callDeepSeek(prompt, systemPrompt, maxTokens),
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
    const resolvedCtx = await resolveRepoContext(appName, challenge, repoContext);
    const response = await callBoardMember(member, challenge, appName ?? null, resolvedCtx);
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
    const resolvedCtx = await resolveRepoContext(appName, challenge, repoContext);

    let signalReport: string | null = null;
    let sniperReport: string | null = null;
    if (resolvedApp === 'Signal OS') {
      signalReport = await fetchSignalOSReport();
    }
    if (resolvedApp === 'Sniper OS') {
      sniperReport = await fetchSniperOSReport();
    }

    const [ceo, cto, designer, qa] = await Promise.all([
      callBoardMember('CEO',      challenge, resolvedApp, resolvedCtx, signalReport, sniperReport, useClaudeThinking),
      callBoardMember('CTO',      challenge, resolvedApp, resolvedCtx, signalReport, sniperReport, useClaudeThinking),
      callBoardMember('Designer', challenge, resolvedApp, resolvedCtx, signalReport, sniperReport, useClaudeThinking),
      callBoardMember('QA',       challenge, resolvedApp, resolvedCtx, signalReport, sniperReport, useClaudeThinking),
    ]);

    // ── Cambio 3: retry si CTO o QA dieron respuesta pobre ───────────────────

    const POOR_RESPONSE_SIGNALS = [
      'no tengo acceso', 'no puedo ver', 'necesitaría acceso', 'documentación técnica',
      'consultar con el equipo', 'no está disponible', 'no encuentro',
      'i don\'t have access', 'would need access',
    ];

    function isPoorResponse(response: string): boolean {
      const lower = response.toLowerCase();
      return POOR_RESPONSE_SIGNALS.some((signal) => lower.includes(signal));
    }

    const poorResponders = [
      { key: 'CTO' as const, response: cto },
      { key: 'QA'  as const, response: qa  },
    ].filter((r) => isPoorResponse(r.response));

    let finalCto = cto;
    let finalQa  = qa;

    if (poorResponders.length > 0 && resolvedApp) {
      console.log(`[warroom] Poor responses from: ${poorResponders.map((r) => r.key).join(', ')} — retrying with deeper search`);
      try {
        const repoName = APP_NAME_TO_REPO[resolvedApp];
        if (repoName) {
          const deepResults = await searchWithAITerms(
            challenge + ' threshold score config',
            repoName,
          );
          if (deepResults.length > 0) {
            const deepFiles = await Promise.allSettled(
              deepResults.slice(0, 3).map(async (r) => ({
                path: r.path,
                content: await getFileContent(r.path, repoName, 'main'),
              })),
            );
            const validDeepFiles = deepFiles
              .filter((r): r is PromiseFulfilledResult<{ path: string; content: string }> => r.status === 'fulfilled')
              .map((r) => r.value);

            if (validDeepFiles.length > 0) {
              const deepCtx: RepoContextPayload = {
                tree: validDeepFiles.map((f) => f.path),
                keyFiles: validDeepFiles,
              };
              console.log(`[warroom] Retry with ${validDeepFiles.length} deeper files: ${validDeepFiles.map((f) => f.path).join(', ')}`);

              const retryResults = await Promise.all(
                poorResponders.map((r) =>
                  callBoardMember(r.key, challenge, resolvedApp, deepCtx, signalReport, sniperReport, useClaudeThinking),
                ),
              );
              poorResponders.forEach((r, i) => {
                if (r.key === 'CTO') finalCto = retryResults[i];
                if (r.key === 'QA')  finalQa  = retryResults[i];
              });
            }
          }
        }
      } catch (err) {
        console.warn('[warroom] Retry search failed:', err instanceof Error ? err.message : err);
      }
    }

    const consensus = await generateConsensus(challenge, { CEO: ceo, CTO: finalCto, Designer: designer, QA: finalQa }, useClaudeThinking);

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
