import { Router, Request, Response } from 'express';
import { streamChat } from '../services/gemini.js';
import { searchMemory } from '../services/rufloMemory.js';

const router = Router();

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

RESPONSE STYLE:
- Conversational, direct, like a co-founder
- Ask ONE question at a time when refining
- When the brief is ready, summarize it clearly before suggesting to send
- Never use markdown code blocks — you don't write code`;

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

  const systemPrompt = `${JEFFERSON_CONTEXT}${memoryContext}`;

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
