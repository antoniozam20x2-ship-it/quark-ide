import { Router, Request, Response } from 'express';
import { generateContent } from '../services/gemini.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';
const MISTRAL_MODEL = 'mistral-small-latest';
const PROVIDER_TIMEOUT_MS = 25_000;

function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

async function callGroq(prompt: string, systemPrompt: string, maxTokens = 1024): Promise<string> {
  const token = process.env.GROQ_API_KEY;
  if (!token) throw new Error('GROQ_API_KEY is not set');
  const res = await fetchWithTimeout(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
    }),
  }, PROVIDER_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Groq API error: ${res.status} ${res.statusText}`);
  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? '';
}

async function callMistral(prompt: string, systemPrompt: string, maxTokens = 1024): Promise<string> {
  const token = process.env.MISTRAL_API_KEY;
  if (!token) throw new Error('MISTRAL_API_KEY is not set');
  const res = await fetchWithTimeout(MISTRAL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({
      model: MISTRAL_MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
    }),
  }, PROVIDER_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Mistral API error: ${res.status} ${res.statusText}`);
  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? '';
}

async function withFallback(
  primary: () => Promise<string>,
  fallback: () => Promise<string>,
  label: string
): Promise<string> {
  try {
    return await primary();
  } catch (primaryErr) {
    console.warn(`[warroom] ${label} primary failed (${(primaryErr as Error).message}), trying fallback…`);
    return fallback();
  }
}

const router = Router();

// ── Dynamic context builder ──────────────────────────────────────────────────

const BASE_CONTEXT = `Eres parte del War Room de Jefferson, trader especializado en crypto futures con metodología SMC/ICT operando en Bitget USDT-M.
Jefferson construye su ecosistema de apps en Railway con React/TypeScript/Vite frontend + Node.js/Express backend + PostgreSQL.
Su filosofía: un cambio a la vez, calidad sobre cantidad.`;

const APP_CONTEXTS: Record<string, string> = {
  'Signal OS': `
App bajo análisis: Signal OS (repo: Ahorar)
Bot autónomo de crypto futures en Bitget USDT-M.
Stack: React/TypeScript frontend + Node.js/Express backend + PostgreSQL.
Features clave: scoring SMC/ICT, filtro CoinMarketCap 30 pares, trailing stops nativos Bitget, circuit breakers, streak protection (3 SL losses → 30min pause), bias engine BTC 1H multi-tier, módulo de aprendizaje, análisis institucional (OI, LS ratio, funding).
Parámetros actuales: 0.5% risk/trade, 2% SL, 4.5% TP, 5x leverage, isolated margin, hedge mode.
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
Bot spot trading en OKX.
Stack: React/TypeScript frontend + Node.js/Express backend + PostgreSQL.
Features clave: CoinMarketCap/CoinGecko asset discovery, conviction-based position sizing, DCA support.
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

function buildContext(appName: string | null, repoContext?: RepoContextPayload): string {
  const appCtx = appName ? (APP_CONTEXTS[appName] ?? '') : '';
  let repoCtx = '';
  if (repoContext && (repoContext.tree.length > 0 || repoContext.keyFiles.length > 0)) {
    const treeStr = repoContext.tree.slice(0, 80).join('\n');
    const filesStr = repoContext.keyFiles
      .map((f) => `--- ${f.path} ---\n${f.content}`)
      .join('\n\n');
    repoCtx = `\n\nCódigo real del repositorio:\n\nEstructura de archivos:\n${treeStr}\n\nArchivos clave:\n${filesStr}`;
  }
  return BASE_CONTEXT + appCtx + repoCtx;
}

// ── Board role descriptions (no context embedded) ────────────────────────────

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

async function callBoardMember(
  member: string,
  challenge: string,
  appName: string | null,
  repoContext?: RepoContextPayload,
): Promise<string> {
  const roleDesc = BOARD_ROLES[member];
  if (!roleDesc) throw new Error(`Invalid member: ${member}`);
  const systemPrompt = `${roleDesc}\n\n${buildContext(appName, repoContext)}`;

  switch (member) {
    case 'CEO':
      return withFallback(
        () => generateContent(challenge, systemPrompt, 1024, `/api/warroom/board/CEO`),
        () => callGroq(challenge, systemPrompt, 1024),
        'CEO(Gemini→Groq)',
      );
    case 'CTO':
      return withFallback(
        () => callGroq(challenge, systemPrompt, 1024),
        () => generateContent(challenge, systemPrompt, 1024, `/api/warroom/board/CTO`),
        'CTO(Groq→Gemini)',
      );
    case 'Designer':
      return withFallback(
        () => callGroq(challenge, systemPrompt, 1024),
        () => callMistral(challenge, systemPrompt, 1024),
        'Designer(Groq→Mistral)',
      );
    case 'QA':
      return withFallback(
        () => callMistral(challenge, systemPrompt, 1024),
        () => callGroq(challenge, systemPrompt, 1024),
        'QA(Mistral→Groq)',
      );
    case 'DEBUGGER':
      return withFallback(
        () => callGroq(challenge, systemPrompt, 1024),
        () => generateContent(challenge, systemPrompt, 1024, `/api/warroom/board/DEBUGGER`),
        'DEBUGGER(Groq→Gemini)',
      );
    default:
      return withFallback(
        () => generateContent(challenge, systemPrompt, 1024, `/api/warroom/board/${member}`),
        () => callGroq(challenge, systemPrompt, 1024),
        `${member}(Gemini→Groq)`,
      );
  }
}

async function generateConsensus(
  challenge: string,
  responses: Record<string, string>
): Promise<string> {
  const synthesis = `Original challenge: ${challenge}

Board responses:
CEO: ${responses.CEO}

CTO: ${responses.CTO}

Designer: ${responses.Designer}

QA: ${responses.QA}

Synthesize all four perspectives into 3-5 clear, actionable consensus items. Be decisive and specific. Reference the actual content from each board member's input. Jefferson needs a clear action plan.`;

  return generateContent(synthesis, `${BOARD_ROLES.CEO}\n\n${BASE_CONTEXT}`, 1024, '/api/warroom/consensus');
}

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
    options?.includeDatabase && 'Include detailed PostgreSQL schema design consistent with his existing database patterns.',
    options?.includeUX && 'Include detailed UI/UX recommendations that match his cyberpunk neon green/black aesthetic.',
  ]
    .filter(Boolean)
    .join(' ');

  const prompt = `${idea}${modeNote}${extras ? '\n\n' + extras : ''}`;

  try {
    const result = await generateContent(prompt, THINK_SYSTEM, 4096, '/api/warroom/think');
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
  const { challenge, appName, repoContext } = req.body as {
    challenge: string;
    appName?: string;
    repoContext?: RepoContextPayload;
  };
  if (!challenge?.trim()) {
    res.status(400).json({ error: 'challenge is required' });
    return;
  }

  const resolvedApp = appName ?? null;
  const start = Date.now();
  try {
    const [ceo, cto, designer, qa] = await Promise.all([
      callBoardMember('CEO', challenge, resolvedApp, repoContext),
      callBoardMember('CTO', challenge, resolvedApp, repoContext),
      callBoardMember('Designer', challenge, resolvedApp, repoContext),
      callBoardMember('QA', challenge, resolvedApp, repoContext),
    ]);

    const consensus = await generateConsensus(challenge, { CEO: ceo, CTO: cto, Designer: designer, QA: qa });

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
    const result = await generateContent(query, searchSystem, 2048, '/api/warroom/search');
    res.json({ result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: msg });
  }
});

export default router;
