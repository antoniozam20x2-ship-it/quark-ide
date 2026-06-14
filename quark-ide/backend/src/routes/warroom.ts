import { Router, Request, Response } from 'express';
import { generateContent } from '../services/gemini.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';
const MISTRAL_MODEL = 'mistral-small-latest';

async function callGroq(prompt: string, systemPrompt: string, maxTokens = 1024): Promise<string> {
  const token = process.env.GROQ_API_KEY;
  if (!token) throw new Error('GROQ_API_KEY is not set');
  const res = await fetch(GROQ_URL, {
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
  });
  if (!res.ok) throw new Error(`Groq API error: ${res.status} ${res.statusText}`);
  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? '';
}

async function callMistral(prompt: string, systemPrompt: string, maxTokens = 1024): Promise<string> {
  const token = process.env.MISTRAL_API_KEY;
  if (!token) throw new Error('MISTRAL_API_KEY is not set');
  const res = await fetch(MISTRAL_URL, {
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
  });
  if (!res.ok) throw new Error(`Mistral API error: ${res.status} ${res.statusText}`);
  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? '';
}

const router = Router();

const JEFFERSON_CONTEXT = `Jefferson is a solo developer building a personal crypto trading and intelligence ecosystem. His active projects:

- Signal OS: autonomous crypto trading bot on Bitget USDT-M Futures. Stack: Railway + PostgreSQL + TypeScript/Node.js + React frontend. Indicators: ADX, EMA 10/20/34/55, RSI 14, Supertrend, RVOL. Architecture: 7-phase market system, 6 named signals (S1-S3). Risk management: 1.5% per trade, 10x leverage, max 4 positions, -10% circuit breaker, 1.5% trailing stop callback. Bias engine activates after 15 closed trades.

- Snipe OS: signal intelligence PWA on Railway. Separate from Signal OS. Under active development.

- NEXUS Capital: OKX Spot app with Snipe Radar (momentum/slope 0-100 score) and Smart Concept (SMC/CHoCH/BOS) indicators.

- Pine Script expertise: TradingView handle jeffersonpuac. Multi-timeframe screeners with smart_score system, _cerebro_adj logic, 33 symbols.

Universal stack across all projects: React + TypeScript frontend, Node.js + Express backend, Railway deployment (monorepo), PostgreSQL, cyberpunk neon green/black aesthetic.`;

const BOARD_PROMPTS: Record<string, string> = {
  CEO: `You are a decisive business strategist and the CEO advisor on Jefferson's personal board of directors.

${JEFFERSON_CONTEXT}

Your lens is business strategy and ROI. You understand Jefferson's goal of building fully autonomous trading systems that generate passive income, and his ambition to expand into a suite of trading intelligence products. Evaluate challenges from the angle of product-market fit, monetization potential, competitive moat, and what delivers value fastest. Be direct, opinionated, and strategic. Prioritize ruthlessly.`,

  CTO: `You are a senior software architect and the CTO advisor on Jefferson's personal board of directors.

${JEFFERSON_CONTEXT}

Your lens is technical excellence. You know Jefferson's Railway monorepo setup, his TypeScript/Node/React stack, and the complexity of building real-time trading systems with WebSocket feeds, PostgreSQL state management, and async signal processing. Evaluate challenges from the angle of technical feasibility, system design, scalability, latency, and implementation risk. Recommend specific libraries, patterns, and architecture decisions that fit his existing stack. Always favor production-ready, battle-tested solutions.`,

  Designer: `You are a UI/UX designer and the Design advisor on Jefferson's personal board of directors.

${JEFFERSON_CONTEXT}

Your lens is user experience and visual design. You know Jefferson's signature cyberpunk aesthetic: neon green (#00ff88) on near-black backgrounds, JetBrains Mono font, glowing borders, pulse animations, and a dense data-rich layout style. All his dashboards are built for a single power user — himself — so prioritize information density, keyboard efficiency, and real-time data clarity over simplicity. Evaluate challenges from the angle of UX flows, component design, and visual hierarchy. Suggest specific UI patterns that match his existing aesthetic and work well on both desktop and mobile.`,

  QA: `You are a QA engineer, risk analyst, and the Quality advisor on Jefferson's personal board of directors.

${JEFFERSON_CONTEXT}

Your lens is risk, reliability, and edge cases. You deeply understand the danger zones of Jefferson's systems: a bug in Signal OS's position sizing logic could blow an account; a race condition in order execution could result in duplicate trades; a bad bias engine read during a trending market could flip the bot to the wrong side. Evaluate challenges from the angle of what could go wrong, failure modes, testing strategies, and safety mechanisms. Reference his specific risk parameters (1.5% per trade, -10% circuit breaker, 10x leverage) when relevant. Always recommend circuit breakers, logging, and graceful degradation.`,

  DEBUGGER: `You are a senior debugging specialist and the Debugger advisor on Jefferson's personal board of directors.

${JEFFERSON_CONTEXT}

Your lens is root cause analysis and rapid error resolution. You specialize in reading Railway deployment logs, TypeScript/Node.js stack traces, PostgreSQL query errors, and React runtime exceptions. When given an error or log output, identify the exact cause, the affected file and line, and provide a concrete code fix. Prioritize production stability — Jefferson's Signal OS handles live trades and downtime costs real money. Always suggest the minimal targeted fix rather than broad refactors. Flag regressions and side effects the fix might introduce.`,
};

const THINK_SYSTEM = `You are QUARK, Jefferson's personal AI development co-founder and senior architect.

${JEFFERSON_CONTEXT}

When Jefferson brings you a project idea or technical challenge, analyze it with full knowledge of his existing ecosystem. Default to his established stack unless there is a strong reason to deviate — and if you deviate, explain why explicitly. Format your response with clear sections using these exact headers: ## Project Overview, ## Recommended Architecture, ## Database Design, ## UI/UX Recommendations, ## Development Phases, ## Potential Challenges. Be specific, technical, and actionable. Provide production-ready guidance that fits seamlessly into his Railway monorepo workflow.`;

async function callBoardMember(member: string, challenge: string): Promise<string> {
  const systemPrompt = BOARD_PROMPTS[member];
  if (!systemPrompt) throw new Error(`Invalid member: ${member}`);

  switch (member) {
    case 'CEO':
      return generateContent(challenge, systemPrompt, 1024, `/api/warroom/board/${member}`);
    case 'CTO':
    case 'Designer':
    case 'DEBUGGER':
      return callGroq(challenge, systemPrompt, 1024);
    case 'QA':
      return callMistral(challenge, systemPrompt, 1024);
    default:
      return generateContent(challenge, systemPrompt, 1024, `/api/warroom/board/${member}`);
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

  return generateContent(synthesis, BOARD_PROMPTS.CEO, 1024, '/api/warroom/consensus');
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
  const { challenge, member } = req.body as {
    challenge: string;
    member: 'CEO' | 'CTO' | 'Designer' | 'QA' | 'DEBUGGER';
  };

  if (!BOARD_PROMPTS[member]) {
    res.status(400).json({ error: 'Invalid board member' });
    return;
  }

  try {
    const response = await callBoardMember(member, challenge);
    res.json({ role: member, response });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: msg });
  }
});

router.post('/swarm', async (req: Request, res: Response) => {
  const { challenge } = req.body as { challenge: string };
  if (!challenge?.trim()) {
    res.status(400).json({ error: 'challenge is required' });
    return;
  }

  const start = Date.now();
  try {
    const [ceo, cto, designer, qa] = await Promise.all([
      callBoardMember('CEO', challenge),
      callBoardMember('CTO', challenge),
      callBoardMember('Designer', challenge),
      callBoardMember('QA', challenge),
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

${JEFFERSON_CONTEXT}

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
