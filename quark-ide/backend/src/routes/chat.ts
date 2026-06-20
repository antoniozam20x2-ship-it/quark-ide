import { Router, Request, Response } from 'express';
import { searchMemory } from '../services/rufloMemory.js';
import { getFileTree, getFileContent } from '../services/github.js';
import pool from '../services/db.js';

// ── Chat history helpers ───────────────────────────────────────────────────────

const CHAT_CONVERSATION_TITLE = 'quark-chat';

async function getOrCreateConversation(): Promise<number> {
  const existing = await pool.query<{ id: number }>(
    `SELECT id FROM conversations WHERE title = $1 LIMIT 1`,
    [CHAT_CONVERSATION_TITLE],
  );
  if (existing.rows.length > 0) return existing.rows[0].id;
  const created = await pool.query<{ id: number }>(
    `INSERT INTO conversations (title) VALUES ($1) RETURNING id`,
    [CHAT_CONVERSATION_TITLE],
  );
  return created.rows[0].id;
}

async function saveMessage(conversationId: number, role: string, content: string): Promise<void> {
  await pool.query(
    `INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)`,
    [conversationId, role, content],
  );
  await pool.query(
    `UPDATE conversations SET updated_at = NOW() WHERE id = $1`,
    [conversationId],
  );
}

async function loadSharedAgentContext(repo: string): Promise<{
  preloadedFiles: { path: string; content: string }[]
} | null> {
  try {
    const r = await pool.query<{ content: string }>(
      `SELECT content FROM memory_entries WHERE key = $1 AND namespace = $2 LIMIT 1`,
      ['agent-context', 'quark-agent'],
    );
    if (!r.rows[0]?.content) return null;
    const ctx = JSON.parse(r.rows[0].content);
    if (ctx.repo !== repo) return null;
    return { preloadedFiles: ctx.preloadedFiles ?? [] };
  } catch {
    return null;
  }
}

// ── Groq key rotation ─────────────────────────────────────────────────────────

const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GROQ_TIMEOUT_MS = 25_000;

const GROQ_KEYS = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
].filter(Boolean) as string[];

class AtomicGroqIndex {
  private index = 0

  next(total: number): number {
    const current = this.index % total
    this.index = (this.index + 1) % total
    return current
  }

  current(total: number): number {
    return this.index % total
  }
}

const groqState = new AtomicGroqIndex()

/** Stream a Groq chat completion as SSE chunks.
 *  Rotates keys on 429 (rate-limit). Throws on all other errors. */
async function streamGroq(
  messages: { role: string; content: string }[],
  systemPrompt: string,
  onChunk: (text: string) => void,
): Promise<void> {
  if (GROQ_KEYS.length === 0) throw new Error('No GROQ_API_KEY configured');

  const startIndex = groqState.current(GROQ_KEYS.length);
  let attempts = 0;

  while (attempts < GROQ_KEYS.length) {
    const key = GROQ_KEYS[groqState.next(GROQ_KEYS.length)];
    attempts++;

    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), GROQ_TIMEOUT_MS);

    try {
      const res = await fetch(GROQ_URL, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          max_tokens: 1000,
          stream: true,
          messages: [
            { role: 'system', content: systemPrompt },
            ...messages.map((m) => ({
              role: m.role === 'assistant' ? 'assistant' : 'user',
              content: m.content,
            })),
          ],
        }),
      });

      // 429 → rotate to next key immediately
      if (res.status === 429) {
        console.warn(`[chat] Groq key …${key.slice(-4)} hit 429 — rotating to next key`);
        clearTimeout(timer);
        // If this was the last key, let it fall through to throw
        if (attempts < GROQ_KEYS.length) continue;
        throw new Error('All Groq keys returned 429 (rate-limited)');
      }

      if (!res.ok) throw new Error(`Groq error: ${res.status} ${res.statusText}`);
      if (!res.body) throw new Error('Groq: no response body');

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') return;
          try {
            const json = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const chunk = json.choices?.[0]?.delta?.content;
            if (chunk) onChunk(chunk);
          } catch { /* ignore malformed SSE lines */ }
        }
      }
      return; // success — stop loop
    } finally {
      clearTimeout(timer);
    }
  }

  // Fell through without success after trying all keys from startIndex
  throw new Error(`All ${GROQ_KEYS.length} Groq keys exhausted (started at key index ${startIndex})`);
}

const OPENROUTER_URL   = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'meta-llama/llama-3.3-70b-instruct:free';
const OPENROUTER_TIMEOUT_MS = 25_000;

const OPENROUTER_KEYS = [
  process.env.OPENROUTER_API_KEY,
  process.env.OPENROUTER_API_KEY_2,
  process.env.OPENROUTER_API_KEY_3,
].filter(Boolean) as string[];

async function streamOpenRouter(
  messages: { role: string; content: string }[],
  systemPrompt: string,
  onChunk: (text: string) => void,
): Promise<void> {
  if (OPENROUTER_KEYS.length === 0) throw new Error('No OPENROUTER_API_KEY configured');

  for (const key of OPENROUTER_KEYS) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), OPENROUTER_TIMEOUT_MS);

    try {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          max_tokens: 1000,
          stream: true,
          messages: [
            { role: 'system', content: systemPrompt },
            ...messages.map((m) => ({
              role: m.role === 'assistant' ? 'assistant' : 'user',
              content: m.content,
            })),
          ],
        }),
      });

      if (res.status === 429) {
        console.warn(`[chat] OpenRouter key …${key.slice(-4)} hit 429 — rotating`);
        clearTimeout(timer);
        continue;
      }

      if (!res.ok) throw new Error(`OpenRouter error: ${res.status} ${res.statusText}`);
      if (!res.body) throw new Error('OpenRouter: no response body');

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') return;
          try {
            const json = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const chunk = json.choices?.[0]?.delta?.content;
            if (chunk) onChunk(chunk);
          } catch { /* ignore malformed SSE lines */ }
        }
      }
      return;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error('All OpenRouter keys exhausted');
}

// ── Router ────────────────────────────────────────────────────────────────────

const router = Router();

// GET /api/chat/history — return all messages for the persistent QUARK Chat session
router.get('/history', async (_req: Request, res: Response) => {
  try {
    const convId = await getOrCreateConversation();
    const result = await pool.query<{ role: string; content: string; created_at: string }>(
      `SELECT role, content, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [convId],
    );
    res.json({ conversationId: convId, messages: result.rows });
  } catch (err) {
    console.error('[chat/history] error:', err);
    res.status(500).json({ error: 'Failed to load chat history' });
  }
});

// DELETE /api/chat/history — wipe all messages and the conversation row
router.delete('/history', async (_req: Request, res: Response) => {
  try {
    const existing = await pool.query<{ id: number }>(
      `SELECT id FROM conversations WHERE title = $1 LIMIT 1`,
      [CHAT_CONVERSATION_TITLE],
    );
    if (existing.rows.length > 0) {
      const convId = existing.rows[0].id;
      await pool.query(`DELETE FROM messages WHERE conversation_id = $1`, [convId]);
      await pool.query(`DELETE FROM conversations WHERE id = $1`, [convId]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[chat/history DELETE] error:', err);
    res.status(500).json({ error: 'Failed to clear chat history' });
  }
});

// POST /api/chat/message — persist a single message (user or assistant)
router.post('/message', async (req: Request, res: Response) => {
  const { conversationId, role, content } = req.body as {
    conversationId: number;
    role: string;
    content: string;
  };
  if (!conversationId || !role || !content) {
    res.status(400).json({ error: 'conversationId, role and content are required' });
    return;
  }
  try {
    await saveMessage(conversationId, role, content);
    res.json({ ok: true });
  } catch (err) {
    console.error('[chat/message] error:', err);
    res.status(500).json({ error: 'Failed to save message' });
  }
});

const APP_REPOS: Record<string, string> = {
  'signal os':  'Ahorar',
  'sniper os':  'Trade-SnipeOS',
  'nexus os':   'NEXUS-OS-app',
  'core ia':    'Code-Coretest',
  'quark ide':  'quark-ide',
};

async function fetchRepoContext(repoName: string): Promise<string> {
  // Intentar reutilizar contexto ya cargado por QUARK Agent
  const shared = await loadSharedAgentContext(repoName)
  if (shared && shared.preloadedFiles.length > 0) {
    const filesStr = shared.preloadedFiles
      .map((f) => {
        const lines = f.content.split('\n')
        const truncated = lines.length > 300
          ? lines.slice(0, 300).join('\n') + `\n// ... (${lines.length - 300} líneas más)`
          : f.content
        return `--- ${f.path} ---\n${truncated}`
      })
      .join('\n\n')
    return `
=== CONTEXTO DE APP: ${repoName} (reutilizado de QUARK Agent) ===
Archivos ya analizados:
${filesStr}
=== FIN CONTEXTO ===`
  }

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

BRIEF FORMAT — when the brief is ready, ALWAYS wrap it in markers:
BRIEF_START
[prompt limpio y accionable, 2-4 líneas máximo, sin explicaciones ni contexto]
BRIEF_END
Then suggest the button below the markers. The content inside BRIEF_START/BRIEF_END
must be self-contained — no references to "as discussed" or "as mentioned above".

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
    const results        = await searchMemory(lastUserMessage, 'quark-ide');
    const projectResults = await searchMemory(lastUserMessage, 'jefferson-projects');
    const warRoomResults = await searchMemory(lastUserMessage, 'war-room');
    const allResults     = [...results, ...projectResults, ...warRoomResults].slice(0, 5);
    if (allResults.length > 0) {
      memoryContext = '\n\nRELEVANT CONTEXT FROM MEMORY:\n' + allResults.join('\n\n');
    }
  } catch {}

  let projectContext = '';
  if (activeProject?.name) {
    const projectType = detectProjectType(activeProject.name);
    const refs = PROJECT_REFERENCES[projectType];
    projectContext = `\n\nPROYECTO ACTIVO: ${activeProject.name} (repo: ${activeProject.repo})
Tipo detectado: ${projectType}
Referencias visuales para sugerencias: ${refs}`;
  }

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

  let enrichedContext = '';
  if (contextData && (contextData.tree.length > 0 || contextData.keyFiles.length > 0)) {
    const treeStr  = contextData.tree.slice(0, 80).join('\n');
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

  let studioProjectsContext = '';
  const improveKeywords = /\b(mejora|mejorar|editar|edita|actualiza|actualizar|cambia|cambiar|arregla|arreglar|modifica|modificar)\b/i;
  if (improveKeywords.test(lastUserMessage)) {
    try {
      const { rows } = await pool.query<{ id: number; name: string; folder: string }>(
        'SELECT id, name, folder FROM studio_projects ORDER BY created_at DESC',
      );
      if (rows.length > 0) {
        studioProjectsContext = `\n\nPROYECTOS GUARDADOS EN STUDIO:\n${rows.map((p) => `- ID:${p.id} "${p.name}" (carpeta: ${p.folder})`).join('\n')}\nSi el usuario quiere mejorar uno de estos proyectos, menciona que lo encontraste y pregunta si es ese. Cuando confirme, incluye PROJECT_ID:{el_id} en el BRIEF_START para que Studio lo cargue automáticamente.`;
      }
    } catch { /* no bloquear el chat si falla */ }
  }

  const systemPrompt = `${JEFFERSON_CONTEXT}${projectContext}${enrichedContext}${repoContext}${memoryContext}${studioProjectsContext}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Hard timeout — close stream after 45s no matter what
  const hardTimeout = setTimeout(() => {
    try {
      res.write(`data: ${JSON.stringify({ error: 'Request timed out. Try again.' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch { /* already closed */ }
  }, 45_000);

  const emit = (chunk: string) => res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);

  try {
    try {
      await streamGroq(messages, systemPrompt, emit);
    } catch (groqErr) {
      const groqMsg = groqErr instanceof Error ? groqErr.message : '';
      if (groqMsg.includes('exhausted') || groqMsg.includes('429') || groqMsg.includes('No GROQ_API_KEY')) {
        console.log('[chat] Groq exhausted — switching to OpenRouter');
        await streamOpenRouter(messages, systemPrompt, emit);
      } else {
        throw groqErr;
      }
    }
    res.write('data: [DONE]\n\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[chat] streamGroq error:', msg);
    res.write(`data: ${JSON.stringify({ error: `Chat error: ${msg}` })}\n\n`);
    res.write('data: [DONE]\n\n');
  } finally {
    clearTimeout(hardTimeout);
    res.end();
  }
});

export default router;
