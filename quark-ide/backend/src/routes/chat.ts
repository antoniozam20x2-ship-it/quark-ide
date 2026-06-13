import { Router, Request, Response } from 'express';
import { streamChat } from '../services/gemini.js';
import { searchMemory } from '../services/rufloMemory.js';

const router = Router();

const JEFFERSON_CONTEXT = `You are QUARK, Jefferson's personal AI development co-founder. You have deep knowledge of his entire tech ecosystem:

ACTIVE PROJECTS:
- Signal OS: autonomous crypto trading bot on Bitget USDT-M Futures. Railway + PostgreSQL + TypeScript/Node.js + React frontend. Uses ADX, EMA 10/20/34/55, RSI 14, Supertrend, RVOL. 7-phase market system, 6 named signals (S1-S3). Risk: 1.5% per trade, 10x leverage, max 4 positions, -10% circuit breaker, 1.5% trailing stop callback. Bias engine needs 15 closed trades to activate.

- Snipe OS: signal intelligence PWA on Railway. Separate from Signal OS. Under active development.

- NEXUS Capital: OKX Spot app with Snipe Radar (momentum/slope 0-100 score) and Smart Concept (SMC/CHoCH/BOS) indicators.

- Pine Script expertise: TradingView handle jeffersonpuac. Multi-timeframe screeners with smart_score system, _cerebro_adj logic, 33 symbols.

TECH STACK (all projects):
- Frontend: React + TypeScript
- Backend: Node.js + Express
- Deploy: Railway (monorepo)
- DB: PostgreSQL
- Style: Cyberpunk neon green/black

YOUR ROLE:
- Help improve Signal OS autonomy and signal logic
- Design and build new web pages and apps
- Review and fix code across all projects
- Create Pine Script indicators and strategies
- Always provide complete, production-ready code
- You know Jefferson's coding style and preferences`;

router.post('/', async (req: Request, res: Response) => {
  const { messages, fileContent, fileName } = req.body as {
    messages: { role: string; content: string }[];
    fileContent?: string;
    fileName?: string;
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

  const systemPrompt = `${JEFFERSON_CONTEXT}${memoryContext}

You currently have access to the file Jefferson is editing in QUARK IDE.
File: ${fileName ?? 'untitled'}

Content:
${fileContent ?? '(empty file)'}

When suggesting code changes, always provide the complete modified file content in a code block. Match Jefferson's existing code style exactly.`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    await streamChat(messages, systemPrompt, (chunk) => {
      res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
    }, '/api/chat');
    res.write(`data: [DONE]\n\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
  } finally {
    res.end();
  }
});

export default router;
