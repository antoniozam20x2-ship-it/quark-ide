import { Router, Request, Response } from 'express';
import { streamChat } from '../services/gemini.js';
import { searchMemory } from '../services/rufloMemory.js';
import { getFileTree, getFileContent } from '../services/github.js';

const router = Router();

const APP_REPOS: Record<string, string> = {
  'signal os':  'Ahorar',
  'sniper os':  'Trade-SnipeOS',
  'nexus os':   'NEXUS-OS-app',
  'core ia':    'Code-Coretest',
  'quark ide':  'quark-ide',
};

async function fetchRepoContext(repoName: string): Promise<string> {
  const results = await Promise.allSettled([
    getFileTree(repoName, 'main'),
    getFileContent('README.md', repoName, 'main'),
  ]);

  const treeResult   = results[0];
  const readmeResult = results[1];

  const fileTree = treeResult.status === 'fulfilled'
    ? treeResult.value
        .filter((f) => f.type === 'blob')
        .map((f) => f.path)
        .slice(0, 60)
        .join('\n')
    : '(no disponible)';

  const readmeContent = readmeResult.status === 'fulfilled'
    ? readmeResult.value.slice(0, 3000)
    : '(README no encontrado)';

  return `
=== CONTEXTO DE APP: ${repoName} ===
Archivos principales:
${fileTree}

README:
${readmeContent}
=== FIN CONTEXTO ===`;
}

function detectMentionedApps(text: string): string[] {
  const lower = text.toLowerCase();
  return Object.entries(APP_REPOS)
    .filter(([appName]) => lower.includes(appName))
    .map(([, repo]) => repo);
}

type ProjectType = 'trading' | 'ecommerce' | 'dashboard' | 'landing' | 'app';

function detectProjectType(projectName: string): ProjectType {
  const n = projectName.toLowerCase();
  if (n.includes('signal') || n.includes('sniper') || n.includes('nexus') || n.includes('trade') || n.includes('trading') || n.includes('core')) return 'trading';
  if (n.includes('shop') || n.includes('store') || n.includes('ecommerce') || n.includes('tienda')) return 'ecommerce';
  if (n.includes('dashboard') || n.includes('admin') || n.includes('panel')) return 'dashboard';
  if (n.includes('landing') || n.includes('marketing') || n.includes('promo')) return 'landing';
  return 'app';
}

const PROJECT_REFERENCES: Record<ProjectType, string> = {
  trading:   'TradingView, Binance, Bloomberg Terminal',
  ecommerce: 'Amazon, Shopify, MercadoLibre',
  dashboard: 'Linear, Notion, Vercel Dashboard',
  landing:   'Stripe, Linear, Vercel marketing pages',
  app:       'Linear, Notion, Vercel',
};

const JEFFERSON_CONTEXT = `You are QUARK, Jefferson's personal AI co-founder and strategic thinking partner. You help him refine ideas, analyze problems, and prepare detailed briefs — but you NEVER generate code directly.

JEFFERSON'S ECOSYSTEM:
- Signal OS: autonomous crypto trading bot. Railway + PostgreSQL + TypeScript/Node.js + React. ADX, EMA 10/20/34/55, RSI 14, Supertrend, RVOL. 7-phase market system, 6 signals (S1-S3). Risk: 1.5%/trade, 10x leverage, max 4 positions, -10% circuit breaker, 1.5% trailing stop.
- Sniper OS: signal intelligence PWA on Railway. Under active development.
- NEXUS Capital: OKX Spot app with Snipe Radar and Smart Concept (SMC/CHoCH/BOS) indicators.
- QUARK IDE: his personal IDE with AI pipeline — Chat → Studio → Agent → Preview → Commit.
- Pine Script: TradingView handle jeffersonpuac. Multi-timeframe screeners, smart_score system.

TECH STACK: React + TypeScript + Node.js + Express + Railway + PostgreSQL. Cyberpunk neon green/black style.

YOUR ROLE:
- Understand what Jefferson wants to build or fix
- Ask smart clarifying questions when the idea is vague
- Analyze problems deeply — bugs, architecture, trading logic
- Prepare detailed, structured briefs ready for Studio or War Room
- Suggest improvements and catch flaws in his reasoning
- NEVER write code — always say "send this to Studio to build it" or "send this to War Room to analyze it"

WHEN TO SUGGEST SENDING:
- Idea is clear and detailed enough → suggest [🎨 Enviar a Studio]
- Bug or trading problem → suggest [📋 Enviar al Board]
- Still vague → keep asking questions

RESPONSE RULES:
- Conversational, direct, like a co-founder
- NEVER ask more than 1 question at a time
- When asking a question, ALWAYS offer options — format exactly: OPTIONS:["option1","option2","option3"]
- If the user can also answer freely, add on a new line: ALLOW_CUSTOM:true
- When the brief is ready, summarize it clearly before suggesting to send
- Never use markdown code blocks — you don't write code`;

router.post('/', async (req: Request, res: Response) => {
  const { messages, fileContent, fileName, activeProject, contextData } = req.body as {
    messages: { role: string; content: string }[];
    fileContent?: string;
    fileName?: string;
    activeProject?: { name: string; repo: string };
    contextData?: { repo: string; tree: string[]; keyFiles: { path: string; content: string }[] };
  };

  const lastUserMessage = messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';

  let memoryContext = '';
  try {
    const results = await searchMemory(lastUserMessage, 'quark-ide');
    const projectResults = await searchMemory(lastUserMessage, 'jefferson-projects');
    const allResults = [...results, ...projectResults].slice(0, 4);
    if (allResults.length > 0) {
      memoryContext = '\n\nRELEVANT CONTEXT FROM MEMORY:\n' + allResults.join('\n\n');
    }
  } catch {}

  // Contexto del proyecto activo
  let projectContext = '';
  if (activeProject?.name) {
    const projectType = detectProjectType(activeProject.name);
    const refs = PROJECT_REFERENCES[projectType];
    projectContext = `\n\nPROYECTO ACTIVO: ${activeProject.name} (repo: ${activeProject.repo})
Tipo detectado: ${projectType}
Referencias visuales para sugerencias: ${refs}`;
  }

  // Contexto real de repos mencionados en el mensaje
  let repoContext = '';
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER) {
    const mentionedRepos = detectMentionedApps(lastUserMessage);
    if (mentionedRepos.length > 0) {
      const contexts = await Promise.allSettled(mentionedRepos.map(fetchRepoContext));
      repoContext = contexts
        .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
        .map((r) => r.value)
        .join('\n');
    }
  }

  // Contexto enriquecido enviado desde el frontend (ya resuelto por /repo-context)
  let enrichedContext = '';
  if (contextData && (contextData.tree.length > 0 || contextData.keyFiles.length > 0)) {
    const treeStr = contextData.tree.slice(0, 80).join('\n');
    const filesStr = contextData.keyFiles
      .map((f) => `--- ${f.path} ---\n${f.content}`)
      .join('\n\n');
    enrichedContext = `\n\nTienes acceso al contexto real del repositorio ${contextData.repo}.

Estructura del proyecto:
${treeStr}

Archivos clave:
${filesStr}

Usa este contexto para dar respuestas precisas y específicas al código real. Cuando sugieras cambios, referencia los archivos exactos.`;
  }

  const systemPrompt = `${JEFFERSON_CONTEXT}${projectContext}${enrichedContext}${repoContext}${memoryContext}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Hard timeout — close stream after 45s no matter what
  const hardTimeout = setTimeout(() => {
    res.write(`data: ${JSON.stringify({ error: 'Request timed out. Try again.' })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }, 45_000);

  try {
    await streamChat(messages, systemPrompt, (chunk) => {
      res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
    }, '/api/chat');
    res.write(`data: [DONE]\n\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[chat] streamChat error:', msg);
    res.write(`data: ${JSON.stringify({ error: `Chat error: ${msg}` })}\n\n`);
    res.write('data: [DONE]\n\n');
  } finally {
    clearTimeout(hardTimeout);
    res.end();
  }
});

export default router;
