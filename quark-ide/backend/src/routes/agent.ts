import { Router } from 'express';
import { getFileTree, getFileContent, searchCodeInRepo } from '../services/github.js';
import { callAI } from '../lib/aiRouter.js';
import { generateContent } from '../services/gemini.js';
import pool from '../services/db.js';

// ── Agent session persistence (reuses memory_entries table) ───────────────────

const AGENT_SESSION_KEY = 'agent-session';
const AGENT_SESSION_NS  = 'quark-agent';

async function loadAgentSession(): Promise<string | null> {
  try {
    const r = await pool.query<{ content: string }>(
      `SELECT content FROM memory_entries WHERE key = $1 AND namespace = $2 LIMIT 1`,
      [AGENT_SESSION_KEY, AGENT_SESSION_NS],
    );
    return r.rows[0]?.content ?? null;
  } catch {
    return null;
  }
}

async function saveAgentSession(content: string): Promise<void> {
  await pool.query(
    `INSERT INTO memory_entries (key, content, namespace)
     VALUES ($1, $2, $3)
     ON CONFLICT (key, namespace) DO UPDATE SET content = EXCLUDED.content, timestamp = NOW()`,
    [AGENT_SESSION_KEY, content, AGENT_SESSION_NS],
  );
}

export async function saveAgentContext(ctx: {
  preloadedFiles: { path: string; content: string; fullContent?: string; startLine?: number; endLine?: number }[]
  functionName: string | null
  prompt: string
  repo: string
}): Promise<void> {
  await pool.query(
    `INSERT INTO memory_entries (key, content, namespace)
     VALUES ($1, $2, $3)
     ON CONFLICT (key, namespace) DO UPDATE SET content = EXCLUDED.content, timestamp = NOW()`,
    ['agent-context', JSON.stringify(ctx), AGENT_SESSION_NS],
  );
}

async function loadAgentContext(): Promise<{
  preloadedFiles: { path: string; content: string; fullContent?: string; startLine?: number; endLine?: number }[]
  functionName: string | null
  prompt: string
  repo: string
} | null> {
  try {
    const r = await pool.query<{ content: string }>(
      `SELECT content FROM memory_entries WHERE key = $1 AND namespace = $2 LIMIT 1`,
      ['agent-context', AGENT_SESSION_NS],
    );
    if (!r.rows[0]?.content) return null;
    const ctx = JSON.parse(r.rows[0].content);
    // Contexto válido por 10 minutos
    return ctx;
  } catch {
    return null;
  }
}

// ── Agent provider fallback chain ─────────────────────────────────────────────

const GROQ_URL       = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL     = 'llama-3.3-70b-versatile'
const DEEPSEEK_URL   = 'https://api.deepseek.com/v1/chat/completions'
const DEEPSEEK_MODEL = 'deepseek-chat'
const PROVIDER_TIMEOUT_MS = 25_000

function getGroqKeys(): string[] {
  return [
    process.env.GROQ_API_KEY,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
  ].filter((k): k is string => Boolean(k))
}

async function callGroqAgent(prompt: string, system: string, maxTokens = 4096): Promise<string> {
  const keys = getGroqKeys()
  if (keys.length === 0) throw new Error('No GROQ_API_KEY configured')
  for (const key of keys) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), PROVIDER_TIMEOUT_MS)
      const res = await fetch(GROQ_URL, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: GROQ_MODEL,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
        }),
      }).finally(() => clearTimeout(timer))
      if (res.status === 429) continue
      if (!res.ok) throw new Error(`Groq error: ${res.status}`)
      const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
      return json.choices?.[0]?.message?.content ?? ''
    } catch (err) {
      console.warn(`[agent] Groq key failed: ${(err as Error).message}`)
    }
  }
  throw new Error('All Groq keys failed')
}

async function callDeepSeekAgent(prompt: string, system: string, maxTokens = 4096): Promise<string> {
  const token = process.env.DEEPSEEK_API_KEY
  if (!token) throw new Error('DEEPSEEK_API_KEY not set')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PROVIDER_TIMEOUT_MS)
  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    signal: ctrl.signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
  }).finally(() => clearTimeout(timer))
  if (!res.ok) throw new Error(`DeepSeek error: ${res.status}`)
  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
  return json.choices?.[0]?.message?.content ?? ''
}

async function generateWithFallback(prompt: string, system: string): Promise<string> {
  const providers = [
    { label: 'Groq',     fn: () => callGroqAgent(prompt, system, 4096) },
    { label: 'DeepSeek', fn: () => callDeepSeekAgent(prompt, system, 4096) },
    { label: 'Gemini',   fn: () => generateContent(prompt, system, 4096, '/api/agent/generate') },
  ]
  let lastErr: Error = new Error('All providers failed')
  for (const { label, fn } of providers) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      console.warn(`[agent] ${label} failed: ${lastErr.message}`)
    }
  }
  throw lastErr
}

// ── Search keyword extractor ──────────────────────────────────────────────────

function extractSearchKeywords(prompt: string): string[] {
  const stopWords = new Set(['el', 'la', 'de', 'en', 'es', 'un', 'una', 'the', 'is', 'a', 'an', 'of', 'in', 'for', 'with', 'how', 'what', 'where', 'why', 'when', 'which', 'que', 'como', 'cual', 'donde', 'por', 'para', 'con', 'sin', 'los', 'las', 'del']);
  return prompt
    .toLowerCase()
    .replace(/[^a-záéíóúñA-ZÁÉÍÓÚÑ0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w))
    .slice(0, 4);
}

const router = Router();

const REPAIR_SYSTEM = `Eres un agente de reparación de JSON.
Recibes una respuesta malformada y debes devolver JSON válido.
REGLAS:
- Devuelve SOLO el JSON, sin markdown ni explicaciones
- El JSON debe tener exactamente: { "files": [{"path": string, "content": string}], "commitMessage": string, "mainComponent": string }
- En el campo content, escapa correctamente: comillas → \\" , saltos de línea → \\n, backticks → \`
- Si el contenido tiene SVG o HTML dentro del TSX, escápalo correctamente como string`;

async function repairJSON(rawResponse: string, originalPrompt: string): Promise<any> {
  const text = await callAI(
    'fix',
    `Prompt original: ${originalPrompt}\n\nRespuesta rota:\n${rawResponse.slice(0, 6000)}\n\nRepara el JSON y devuélvelo válido.`,
    REPAIR_SYSTEM,
  );
  return JSON.parse(text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim());
}

async function repairOperationsJSON(rawResponse: string): Promise<{
  operations: Array<{ type: string; path: string; old_str: string; new_str: string }>;
  commitMessage: string;
}> {
  const REPAIR_OPS_SYSTEM = `Eres un agente de reparación de JSON.
Recibes una respuesta malformada y debes devolver JSON válido.
REGLAS:
- Devuelve SOLO el JSON, sin markdown ni explicaciones
- El JSON debe tener exactamente: { "operations": [{"type": "str_replace", "path": string, "old_str": string, "new_str": string}], "commitMessage": string }
- Escapa correctamente las comillas dentro de old_str y new_str`;

  const text = await callAI(
    'fix',
    `Respuesta rota:\n${rawResponse.slice(0, 4000)}\n\nRepara el JSON de operaciones y devuélvelo válido.`,
    REPAIR_OPS_SYSTEM,
  );
  return JSON.parse(text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim());
}

function applyOperations(
  originalContent: string,
  operations: Array<{ type: string; old_str: string; new_str: string }>,
  filePath: string,
  sendFn: (event: string, data: Record<string, unknown>) => void,
): string {
  let content = originalContent;

  for (const op of operations) {
    if (op.type !== 'str_replace') {
      sendFn('action', { text: `⚠️ Operación desconocida '${op.type}' — omitida` });
      continue;
    }

    const idx = content.indexOf(op.old_str);
    if (idx === -1) {
      sendFn('action', { text: `⚠️ str_replace sin match en ${filePath} — operación omitida` });
      continue;
    }

    content = content.slice(0, idx) + op.new_str + content.slice(idx + op.old_str.length);
    sendFn('action', { text: `✅ Patch aplicado en ${filePath}` });
  }

  return content;
}

// ── Read intent detection ────────────────────────────────────────────────────
const READ_KEYWORDS  = /\b(lee|leer|muéstrame|muestra|busca|buscar|encuentra|ver|dime|qué tiene|qué hay|analiza|analizar|diagnóstico|diagnóstica|revisa|revisar|explica|explicar|describe|describir|inspecciona|inspeccionar|abre|abrir|lista|listar|qué hace|cómo está|cómo funciona|show me|read|find|look at)\b/i;
const GEN_KEYWORDS   = /\b(genera|generar|crea|crear|escribe|escribir|implementa|implementar|añade|añadir|agrega|agregar|cambia|cambiar|modifica|modificar|fix|arregla|arreglar|refactoriza|refactorizar|construye|construir|desarrolla|desarrollar|actualiza|actualizar|add|create|write|implement|modify|change|build)\b/i;

function detectReadIntent(prompt: string): boolean {
  const hasRead = READ_KEYWORDS.test(prompt);
  const hasGen  = GEN_KEYWORDS.test(prompt);
  // Read intent only if has read keywords AND no explicit generation keywords
  return hasRead && !hasGen;
}

function extractFunctionBlock(
  content: string,
  functionName: string
): { block: string; startLine: number; endLine: number } | null {
  const lines = content.split('\n')
  const patterns = [
    new RegExp(`^(export\\s+)?(async\\s+)?function\\s+${functionName}\\s*[\\(<]`),
    new RegExp(`^(export\\s+)?const\\s+${functionName}\\s*=\\s*(async\\s+)?`),
    new RegExp(`^\\s+(async\\s+)?${functionName}\\s*[\\(<]`),
  ]
  let startLine = -1
  for (let i = 0; i < lines.length; i++) {
    if (patterns.some(p => p.test(lines[i]))) {
      startLine = i
      break
    }
  }
  if (startLine === -1) return null

  let depth = 0
  let endLine = startLine
  for (let i = startLine; i < lines.length; i++) {
    depth += (lines[i].match(/\{/g) ?? []).length
    depth -= (lines[i].match(/\}/g) ?? []).length
    if (depth <= 0 && i > startLine) {
      endLine = i
      break
    }
  }
  return {
    block: lines.slice(startLine, endLine + 1).join('\n'),
    startLine,
    endLine,
  }
}

function extractFunctionNameFromPrompt(prompt: string): string | null {
  const patterns = [
    /\b(?:función|function|func|fn|método|method)\s+([a-zA-Z_][a-zA-Z0-9_]*)/i,
    /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/,
    /\b(place[A-Z][a-zA-Z]+|check[A-Z][a-zA-Z]+|fetch[A-Z][a-zA-Z]+|handle[A-Z][a-zA-Z]+|get[A-Z][a-zA-Z]+|set[A-Z][a-zA-Z]+|update[A-Z][a-zA-Z]+|calc[A-Z][a-zA-Z]+|run[A-Z][a-zA-Z]+|execute[A-Z][a-zA-Z]+)\b/,
  ]
  for (const p of patterns) {
    const m = prompt.match(p)
    if (m?.[1]) return m[1]
  }
  return null
}

// Ask Gemini to pick the most relevant file paths from the tree given the prompt
async function identifyFilesToRead(
  prompt: string,
  filePaths: string,
): Promise<string[]> {
  const identifyPrompt = `Dado este prompt del usuario y esta lista de archivos de un repo, devuelve un JSON array con los paths de los archivos más relevantes para responder al prompt. Máximo 5 archivos. Solo paths que existen en la lista.

PROMPT: ${prompt}

ARCHIVOS DISPONIBLES:
${filePaths}

Responde SOLO con un JSON array de strings, sin markdown ni explicaciones. Ejemplo: ["src/server.ts","src/db.ts"]`;

  const raw = (await callAI('analyze', identifyPrompt))
    .trim().replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();

  try {
    const paths = JSON.parse(raw) as string[];
    return Array.isArray(paths) ? paths.slice(0, 8) : [];
  } catch {
    // Fallback: extract anything that looks like a file path
    const matches = raw.match(/"([^"]+\.[a-z]{1,5})"/g) ?? [];
    return matches.map((m: string) => m.replace(/"/g, '')).slice(0, 8);
  }
}

router.post('/generate', async (req, res) => {
  const { prompt, repo: bodyRepo, branch = 'main', projectName, deepMode } = req.body as {
    prompt?: string;
    repo?: string;
    branch?: string;
    projectName?: string;
    deepMode?: boolean;
  };
  const repo = bodyRepo ?? process.env.GITHUB_REPO;
  console.log(`[Agent/generate] repo recibido dinámicamente: ${repo}`);

  if (!prompt || !repo) {
    res.status(400).json({ error: 'prompt and repo are required' });
    return;
  }

  const EXECUTION_KEYWORDS = /\b(ejecuta|ejecutar|corre los tests|correr los tests|run tests|verifica que funcione en vivo|verifica en producción|dame el resultado real|prueba en vivo|despliega|deploy)\b/i;
  if (EXECUTION_KEYWORDS.test(prompt)) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({
      event: 'action',
      text: '⚠️ LÍMITE DE QUARK: no puedo ejecutar código en tiempo real, solo leo, analizo y edito. Para correr y probar este cambio en vivo, usa Replit.',
    })}\n\n`);
    res.write(`data: ${JSON.stringify({ event: 'done', files: [], commitMessage: '', mainComponent: '', mainContent: '', repo, branch })}\n\n`);
    res.end();
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: string, data: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify({ event, ...data })}\n\n`);
  };

  try {
    // ── FAST READ PATH — explicit filename in prompt, skip tree + Gemini ──────
    const fastFileMatch = prompt.match(/[\w/\-\.]+\.(tsx|jsx|yaml|json|html|css|yml|env|py|md|ts|js|sh)/);
    if (fastFileMatch && READ_KEYWORDS.test(prompt) && !GEN_KEYWORDS.test(prompt)) {
      const filePath = fastFileMatch[0];
      send('action', { text: `📖 Modo lectura directa — ${filePath}` });
      try {
        const content = await getFileContent(filePath, repo);

        const keyword = prompt.match(/\b(EXPIRED|cronSchedule|cron|TTL|sweeper|signal|snipe|entry|exit|strategy|trigger|filter|interval|timeout|delay|retry|limit|threshold|price|fee|slippage)\b/i)?.[0];

        let finalContent: string;
        if (keyword) {
          const lines = content.split('\n');
          const relevant = lines
            .map((line, i) => ({ line, num: i + 1 }))
            .filter(({ line }) => line.toLowerCase().includes(keyword.toLowerCase()));
          finalContent = relevant.length
            ? relevant.map(({ line, num }) => `L${num}: ${line}`).join('\n')
            : `// No se encontró '${keyword}' en ${filePath}`;
          send('action', { text: `🔎 ${relevant.length} línea(s) con '${keyword}'` });
        } else {
          const rangeMatch = prompt.match(/l[íi]neas?\s+(\d+)\s*(?:a|-|hasta)\s*(\d+)/i);
          if (rangeMatch) {
            const start = Math.max(0, parseInt(rangeMatch[1]) - 1);
            const end = Math.min(content.split('\n').length, parseInt(rangeMatch[2]));
            const lines = content.split('\n').slice(start, end);
            finalContent = lines.map((l, idx) => `L${start + idx + 1}: ${l}`).join('\n');
            send('action', { text: `📍 Mostrando líneas ${start + 1}-${end} exactas` });
          } else {
            finalContent = content.split('\n').slice(0, 500).join('\n');
          }
        }

        send('done', {
          files: [{ path: filePath, content: finalContent }],
          commitMessage: '',
          mainComponent: filePath,
          mainContent: finalContent,
          repo,
          branch,
        });
      } catch (e: any) {
        send('action', { text: `⚠️ No se pudo leer ${filePath}: ${e.message}` });
        send('done', { files: [], commitMessage: '', mainComponent: '', mainContent: '', repo, branch });
      }
      await new Promise((r) => setTimeout(r, 100));
      res.end();
      return;
    }

    // Step 1: file tree (needed for smart read + generation paths)
    send('action', { text: '🔍 Leyendo estructura del repo...' });
    const tree = await getFileTree(repo, branch);
    const PRIORITY_PATTERNS = [
      /server\.(ts|js)$/,
      /routes\//,
      /services\//,
      /engine\.(ts|js)$/,
      /detector\.(ts|js)$/,
    ]
    const FRONTEND_PATTERNS = [
      /components\//,
      /pages\//,
      /\.tsx$/,
      /hooks\//,
    ]

    const filePaths = tree
      .filter((f) => f.type === 'blob')
      .filter((f) =>
        !f.path.includes('node_modules') &&
        !f.path.includes('.lock') &&
        !f.path.includes('dist/')
      )
      .sort((a, b) => {
        const score = (path: string) =>
          PRIORITY_PATTERNS.some(p => p.test(path)) ? 0 :
          FRONTEND_PATTERNS.some(p => p.test(path)) ? 1 : 2
        return score(a.path) - score(b.path)
      })
      .slice(0, 80)
      .map((f) => f.path)
      .join('\n');

    // ── READ PATH — no Gemini generation, just fetch real file content ────────
    if (detectReadIntent(prompt)) {
      send('action', { text: '📖 Modo lectura — identificando archivos relevantes...' });

      const pathsToRead = await identifyFilesToRead(prompt, filePaths);

      if (!pathsToRead.length) {
        send('action', { text: '⚠️ No se encontraron archivos relevantes para ese prompt.' });
        send('done', { files: [], commitMessage: '', mainComponent: '', mainContent: '', repo, branch });
        await new Promise((r) => setTimeout(r, 100));
        res.end();
        return;
      }

      send('action', { text: `📂 Leyendo ${pathsToRead.length} archivo(s) de GitHub...` });

      const functionName = extractFunctionNameFromPrompt(prompt)
      if (functionName) {
        send('action', { text: `🎯 Función detectada: ${functionName} — búsqueda quirúrgica` })
      }

      let foundInPreSelected = false

      const readResults = await Promise.all(
        pathsToRead.map(async (filePath) => {
          try {
            send('file', { path: filePath })
            const content = await getFileContent(filePath, repo)
            console.log(`[Agent/Read] ✅ ${filePath} (${content.length} chars)`)

            // Si hay función detectada, extraer solo ese bloque
            if (functionName) {
              const extracted = extractFunctionBlock(content, functionName)
              if (extracted) {
                foundInPreSelected = true
                send('action', { text: `✂️ Extrayendo ${functionName} (líneas ${extracted.startLine + 1}-${extracted.endLine + 1})` })
                return {
                  path: filePath,
                  content: extracted.block,
                  fullContent: content,
                  startLine: extracted.startLine,
                  endLine: extracted.endLine,
                }
              }
            }
            return { path: filePath, content, fullContent: content }
          } catch (e: any) {
            console.warn(`[Agent/Read] ⚠️ Could not read ${filePath}:`, e.message)
            send('action', { text: `⚠️ No se pudo leer: ${filePath}` })
            return null
          }
        })
      )

      let readFiles = readResults.filter((r): r is NonNullable<typeof r> => r !== null)

      // Fallback: si se buscaba una función específica y no apareció
      // en los archivos pre-seleccionados, ampliar la búsqueda a TODO el árbol
      if (functionName && !foundInPreSelected) {
        send('action', { text: `🔬 ${functionName} no está en los archivos esperados — buscando en GitHub directamente...` })

        const keywords = extractSearchKeywords(prompt);
        const enrichedQuery = [functionName, ...keywords].filter(Boolean).slice(0, 5).join(' ');
        const searchResults = await searchCodeInRepo(enrichedQuery, repo)

        if (searchResults.length > 0) {
          send('action', { text: `📡 GitHub encontró ${searchResults.length} archivo(s) con "${functionName}"` })

          const verifyResults = await Promise.all(
            searchResults.slice(0, 5).map(async ({ path: filePath }) => {
              try {
                const content = await getFileContent(filePath, repo)
                const extracted = extractFunctionBlock(content, functionName)
                if (extracted) return { filePath, content, extracted }
                return null
              } catch {
                return null
              }
            })
          )

          const hit = verifyResults.find(r => r !== null)
          if (hit) {
            send('action', { text: `🎯 Encontrada en ${hit.filePath} (líneas ${hit.extracted.startLine + 1}-${hit.extracted.endLine + 1})` })
            readFiles = [{
              path: hit.filePath,
              content: hit.extracted.block,
              fullContent: hit.content,
              startLine: hit.extracted.startLine,
              endLine: hit.extracted.endLine,
            }]
          } else {
            send('action', { text: `⚠️ GitHub mencionó "${functionName}" pero no se pudo extraer el bloque exacto` })
          }
        } else {
          send('action', { text: `⚠️ ${functionName} no se encontró en GitHub Code Search` })
        }
      }

      // ── AI analysis of read content ─────────────────────────────────────────
      if (readFiles.length > 0) {
        send('action', { text: '🔍 Analizando contenido...' });
        try {
          const fileContext = (await Promise.all(readFiles.map(async (f) => {
            const lines = f.content.split('\n');
            if (lines.length <= 120) {
              return `--- ${f.path} (${lines.length} líneas) ---\n${f.content}`;
            }
            // Archivo grande: keyword search inteligente
            try {
              const kwRaw = await generateWithFallback(
                `Dado este prompt de usuario: "${prompt}"\nGenera 5-8 keywords técnicas para buscar en código TypeScript.\nSOLO keywords separadas por coma. Sin explicación.`,
                'Responde SOLO con keywords separadas por coma. Sin texto extra.'
              );
              const keywords = kwRaw.split(',').map((k: string) => k.trim().toLowerCase()).filter(Boolean);
              const CTX = 30;
              const ranges: [number, number][] = [];
              lines.forEach((line, i) => {
                if (keywords.some((kw: string) => line.toLowerCase().includes(kw))) {
                  const lo = Math.max(0, i - CTX);
                  const hi = Math.min(lines.length - 1, i + CTX);
                  if (ranges.length && lo <= ranges[ranges.length - 1][1] + 1) {
                    ranges[ranges.length - 1][1] = Math.max(ranges[ranges.length - 1][1], hi);
                  } else {
                    ranges.push([lo, hi]);
                  }
                }
              });
              if (ranges.length === 0) {
                return `--- ${f.path} (${lines.length} líneas — sin hits para: ${keywords.join(', ')}) ---\n` +
                  lines.slice(0, 120).join('\n') + `\n// ... fallback primeras 120 líneas`;
              }
              const sections = ranges.map(([lo, hi]) => lines.slice(lo, hi + 1).join('\n'));
              const totalShown = ranges.reduce((acc, [lo, hi]) => acc + (hi - lo + 1), 0);
              return `--- ${f.path} (${lines.length} líneas — mostrando ${totalShown} relevantes para: ${keywords.join(', ')}) ---\n` +
                sections.join('\n\n// --- siguiente sección ---\n\n');
            } catch {
              return `--- ${f.path} (${lines.length} líneas) ---\n` +
                lines.slice(0, 120).join('\n') + `\n// ... fallback primeras 120 líneas`;
            }
          }))).join('\n\n');

          const analysis = await generateWithFallback(
            `El usuario preguntó: "${prompt}"\n\nContenido de los archivos leídos:\n${fileContext}`,
            `Eres un experto analista de código senior. Analiza los archivos leídos y responde directamente a lo que preguntó el usuario.
Sé conciso y preciso — máximo 8 líneas. Sin markdown, sin headers con #, sin listas con *.
Usa frases cortas. Cada idea en una línea separada.`,
          );

          // Stream each non-empty line as its own action event
          const analysisLines = analysis.split('\n').map((l) => l.trim()).filter(Boolean);
          for (const line of analysisLines) {
            send('action', { text: `💡 ${line}` });
          }
        } catch {
          send('action', { text: '⚠️ Análisis no disponible — revisa el contenido directamente' });
        }
      }

      // Guardar contexto para que DEEP mode lo reutilice
      const fnNameForCtx = extractFunctionNameFromPrompt(prompt)
      await saveAgentContext({
        preloadedFiles: readFiles,
        functionName: fnNameForCtx,
        prompt,
        repo,
      }).catch(() => {/* no bloquear si falla */})

      // done with real file content — no commitMessage (read-only)
      send('done', {
        files:         [],
        commitMessage: '',
        mainComponent: readFiles[0]?.path ?? '',
        mainContent:   readFiles[0]?.content ?? '',
        repo,
        branch,
        contextSaved:  true,
      });

      await new Promise((r) => setTimeout(r, 100));
      res.end();
      return;
    }

    // ── GENERATION PATH — Gemini generates new/modified files ────────────────

    // ── PRE-LECTURA INTELIGENTE ───────────────────────────────────────────────
    // Intentar reutilizar contexto de FAST mode
    let preloadedFiles: { path: string; content: string; fullContent?: string; startLine?: number; endLine?: number }[] = []
    const savedCtx = await loadAgentContext().catch(() => null)

    if (savedCtx && savedCtx.repo === repo) {
      const BACKEND_INDICATORS = [
        'lib/', 'services/', 'routes/api-server',
        'botEngine', 'tradingLogic', 'scoring', 'screener',
      ];
      const hasBackend = savedCtx.preloadedFiles.some((f: { path: string }) =>
        BACKEND_INDICATORS.some((indicator) => f.path.includes(indicator))
      );
      if (hasBackend) {
        preloadedFiles = savedCtx.preloadedFiles
        send('action', { text: `⚡ Contexto reutilizado de FAST mode — ${preloadedFiles.length} archivo(s) ya cargados` })
        send('action', { text: `📋 Usando: ${preloadedFiles.map(f => f.path.split('/').pop()).join(', ')}` })
        if (savedCtx.functionName) {
          send('action', { text: `🎯 Función en scope: ${savedCtx.functionName}` })
        }
      } else {
        console.log(`[agent] Cache only has frontend files — bypassing, running fresh search`);
        send('action', { text: `🔎 Caché solo tiene frontend — buscando archivos de backend...` })
      }
    }

    if (preloadedFiles.length === 0) {
      send('action', { text: `🔎 Buscando archivos relacionados con: "${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}"` })

    const relevantPathsRaw = await generateWithFallback(
      `Dado este prompt: "${prompt}"

Y estos archivos del repo:
${filePaths}

Devuelve un JSON array con máximo 5 paths de archivos que DEBES leer para responder correctamente.
Solo paths que existen en la lista. Sin markdown.
Ejemplo: ["src/services/radar.ts","src/routes/screener.ts"]`,
      'Eres un selector de archivos. Devuelve SOLO un JSON array de strings con los paths más relevantes. Sin explicaciones.'
    )
    try {
      const relevantPaths = JSON.parse(
        relevantPathsRaw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim()
      ) as string[]

      if (Array.isArray(relevantPaths) && relevantPaths.length > 0) {
        send('action', { text: `📂 Leyendo ${relevantPaths.length} archivo(s) clave...` })

        const results = await Promise.allSettled(
          relevantPaths.slice(0, 8).map(async (filePath) => {
            const content = await getFileContent(filePath, repo)
            return { path: filePath, content }
          })
        )

        preloadedFiles = results
          .filter((r): r is PromiseFulfilledResult<{ path: string; content: string }> => r.status === 'fulfilled')
          .map((r) => r.value)

        send('action', { text: `✅ Contexto real cargado — ${preloadedFiles.length} archivo(s)` })
        send('action', { text: `📋 Revisando: ${preloadedFiles.map(f => f.path.split('/').pop()).join(', ')}` })
      }
    } catch {
      // Si falla la pre-lectura, continúa sin contexto adicional
    }
    } // cierre del if preloadedFiles.length === 0

    const fileContextStr = preloadedFiles.length > 0
      ? '\n\nCONTENIDO REAL DE ARCHIVOS RELEVANTES:\n' +
        (await Promise.all(preloadedFiles.map(async (f) => {
          const lines = f.content.split('\n')
          if (lines.length <= 500) {
            // Intentar extracción quirúrgica si hay función detectada
            const fnName = extractFunctionNameFromPrompt(prompt)
            if (fnName) {
              const extracted = extractFunctionBlock(f.content, fnName)
              if (extracted) {
                return `--- ${f.path} (BLOQUE QUIRÚRGICO líneas ${extracted.startLine + 1}-${extracted.endLine + 1} de ${lines.length}) ---\n${extracted.block}\n// FULLFILE_LINES:${lines.length}|START:${extracted.startLine}|END:${extracted.endLine}|PATH:${f.path}`
              }
            }
            return `--- ${f.path} ---\n${f.content}`
          }

          // Archivo grande: extraer secciones relevantes por keywords
          let body: string
          try {
            const kwRaw = await generateWithFallback(
              `Dado este prompt de usuario: "${prompt}"\ny que estamos buscando en un archivo TypeScript,\ngenera 5-8 keywords técnicas que probablemente aparecen en el código relevante.\nResponde SOLO con las keywords separadas por coma. Sin explicación.`,
              'Responde SOLO con keywords separadas por coma. Sin texto extra.',
            )
            const keywords = kwRaw.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean)

            // Líneas con hits + ±30 de contexto → rangos fusionados
            const CTX = 30
            const ranges: [number, number][] = []
            lines.forEach((line, i) => {
              if (keywords.some((kw) => line.toLowerCase().includes(kw))) {
                const lo = Math.max(0, i - CTX)
                const hi = Math.min(lines.length - 1, i + CTX)
                if (ranges.length && lo <= ranges[ranges.length - 1][1] + 1) {
                  ranges[ranges.length - 1][1] = Math.max(ranges[ranges.length - 1][1], hi)
                } else {
                  ranges.push([lo, hi])
                }
              }
            })

            if (ranges.length === 0) {
              // Fallback: sin hits → slice(0,500)
              body = lines.slice(0, 500).join('\n') +
                `\n// ... (${lines.length - 500} líneas más — sin hits para: ${keywords.join(', ')})`
            } else {
              const sections = ranges.map(([lo, hi]) => lines.slice(lo, hi + 1).join('\n'))
              const totalShown = ranges.reduce((acc, [lo, hi]) => acc + (hi - lo + 1), 0)
              body = sections.join('\n\n// --- siguiente sección ---\n\n') +
                `\n\n// (${lines.length} líneas totales — mostrando ${totalShown} líneas relevantes para: ${keywords.join(', ')})`
            }
          } catch {
            // Fallback ante error en keyword extraction
            body = lines.slice(0, 500).join('\n') + `\n// ... (${lines.length - 500} líneas más)`
          }

          return `--- ${f.path} ---\n${body}`
        }))).join('\n\n')
      : ''

    // ── RAZONAMIENTO CON CLAUDE — solo en deepMode ───────────────────────────
    let reasoningContext = ''
    if (deepMode) {
      send('action', { text: `🧠 Analizando "${prompt.slice(0, 60)}${prompt.length > 60 ? '...' : ''}"` })
      try {
        const reasoningRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY!,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 1024,
            messages: [{
              role: 'user',
              content: `Eres un arquitecto de software senior. Analiza este problema y decide el mejor enfoque ANTES de escribir código.

PROBLEMA: ${prompt}

ARCHIVOS RELEVANTES DISPONIBLES:
${fileContextStr || filePaths}

Razona brevemente:
1. ¿Cuál es la causa raíz del problema?
2. ¿Qué archivos exactos hay que modificar?
3. ¿Cuál es el cambio mínimo necesario?
4. ¿Qué riesgos tiene este cambio?

Responde en máximo 150 palabras. Solo el razonamiento, sin código.`,
            }],
          }),
        })

        const reasoningData = await reasoningRes.json() as {
          content?: Array<{ type: string; text: string }>
        }

        reasoningContext = reasoningData.content?.[0]?.text ?? ''

        if (reasoningContext) {
          send('action', { text: `🔎 Causa raíz identificada` })
          send('action', { text: `💡 ${reasoningContext.slice(0, 200)}${reasoningContext.length > 200 ? '...' : ''}` })
          send('action', { text: `🎯 Enfoque definido — procediendo con el cambio mínimo necesario` })
        }
      } catch {
        send('action', { text: `⚡ Continuando sin razonamiento profundo (Claude no disponible)` })
      }
    } else {
      send('action', { text: `⚡ Modo análisis — leyendo contexto` })
    }

    // ── FAST MODE — Análisis puro, sin generación de código ──────────────────
    if (!deepMode) {
      send('action', { text: '🔍 Analizando...' });

      const fastSystemPrompt = `Eres QUARK Agent en modo ANÁLISIS.

ROL: Leer, diagnosticar, explicar. NUNCA modificar código.

CONTEXTO DISPONIBLE:
Repo: ${projectName ?? repo} (${repo})

Archivos existentes:
${filePaths}
${fileContextStr}

CUANDO TE PREGUNTEN POR UN PROBLEMA, responde SIEMPRE en este formato:

CAUSA: [1 línea exacta]
DÓNDE: [archivo:línea si aplica]
POR QUÉ: [máximo 3 líneas]
SOLUCIÓN: [descripción sin código]

REGLAS:
- Si la pregunta es de COMPRENSIÓN (¿cómo funciona X?, ¿qué hace Y?, ¿qué es X?):
  1. Usa el código del contexto como fuente interna — no lo muestres crudo
  2. Responde en lenguaje natural, como un senior explicando a un colega
  3. Incluye MÁXIMO 10 líneas de código solo si son indispensables para ilustrar
  4. NUNCA dumpees bloques de código mayores a 15 líneas sin explicación
  5. Estructura de respuesta: qué hace → cómo lo hace → dónde está en el código
- Si el problema es simple → respuesta corta (3-5 líneas)
- Si requiere profundidad → máximo 12 líneas de explicación
- NUNCA generes archivos ni código modificado
- Si necesitas más contexto → pídelo explícitamente`;

      try {
        const analysis = await generateWithFallback(
          fastSystemPrompt + '\n\nPREGUNTA: ' + prompt,
          'Eres un experto analista de código senior.\nREGLAS ESTRICTAS DE OUTPUT:\n- Máximo 10 líneas en total\n- Lenguaje natural, como un senior explicando a un colega\n- CERO bloques de código crudos\n- Solo menciona el archivo y línea si es indispensable\n- Estructura: qué hace (2 líneas) → cómo funciona (4 líneas) → dónde está (2 líneas)',
        );
        const lines = analysis.split('\n').map((l) => l.trim()).filter(Boolean);
        for (const line of lines) {
          send('action', { text: line });
        }
      } catch {
        send('action', { text: '⚠️ Análisis no disponible — intenta reformular la pregunta' });
      }

      send('done', { files: [], commitMessage: '', mainComponent: '', mainContent: '', repo, branch });
      await new Promise((r) => setTimeout(r, 100));
      res.end();
      return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    send('action', { text: '🔬 Modo cirugía — preparando patch...' });

    // Variables para el contexto quirúrgico
    const mainPreloaded = preloadedFiles[0];
    const blockStartLine = mainPreloaded?.startLine ?? 1;
    const blockEndLine = mainPreloaded?.endLine ?? 0;
    const mainFilePath = mainPreloaded?.path ?? '';

    const systemPrompt = `Eres QUARK Agent en modo CIRUGÍA QUIRÚRGICA.
Tu trabajo es generar las operaciones mínimas para corregir un problema específico.

BLOQUE DEL ARCHIVO (líneas ${blockStartLine}–${blockEndLine} de ${mainFilePath}):
\`\`\`
${fileContextStr}
\`\`\`

RAZONAMIENTO PREVIO:
${reasoningContext}

RESPONDE ÚNICAMENTE CON ESTE JSON (sin markdown, sin backticks, sin texto extra):
{
  "operations": [
    {
      "type": "str_replace",
      "path": "${mainFilePath}",
      "old_str": "texto exacto que existe en el bloque de arriba",
      "new_str": "texto corregido"
    }
  ],
  "commitMessage": "fix: descripción del cambio"
}

REGLAS CRÍTICAS:
- old_str debe ser texto que existe LITERALMENTE en el bloque de arriba
- Incluye suficiente contexto en old_str para que sea único (mínimo 1 línea completa)
- Máximo 3 operaciones por respuesta
- Si el fix requiere más de 3 operaciones, agrúpalas en menos str_replace con más contexto
- NUNCA inventes old_str — cópialo exactamente del bloque
- El JSON debe usar SOLO comillas dobles`;

    const raw = (await generateWithFallback(systemPrompt + '\n\nTAREA: ' + prompt, systemPrompt)).trim();

    console.log('[Agent] Raw length:', raw.length);
    console.log('[Agent] Raw preview:', raw.slice(0, 300));

    // Parsear respuesta de operaciones
    let operations: Array<{ type: string; path: string; old_str: string; new_str: string }> = [];
    let commitMessage = 'fix: patch aplicado por QUARK Agent';

    try {
      const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
      const parsedOps = JSON.parse(cleaned);
      operations = parsedOps.operations ?? [];
      commitMessage = parsedOps.commitMessage ?? commitMessage;
    } catch {
      send('action', { text: '⚠️ JSON malformado — intentando reparar...' });
      try {
        const repaired = await repairOperationsJSON(raw);
        operations = repaired.operations ?? [];
        commitMessage = repaired.commitMessage ?? commitMessage;
      } catch {
        send('action', { text: '❌ No se pudo parsear el patch — abortando' });
        send('done', { files: [], commitMessage: '', mainComponent: '', mainContent: '', repo, branch });
        res.end();
        return;
      }
    }

    // Construir archivos finales aplicando operaciones str_replace
    const finalFiles: { path: string; content: string }[] = [];

    for (const op of operations) {
      const preloaded = preloadedFiles.find(f => f.path === op.path);
      const originalContent = preloaded?.fullContent ?? preloaded?.content ?? '';

      if (!originalContent) {
        send('action', { text: `⚠️ No se encontró contenido original para ${op.path}` });
        continue;
      }

      const opsForFile = operations.filter(o => o.path === op.path);
      const patchedContent = applyOperations(originalContent, opsForFile, op.path, send);

      if (!finalFiles.find(f => f.path === op.path)) {
        finalFiles.push({ path: op.path, content: patchedContent });
      }
    }

    // Step 3: reportar archivos modificados
    send('action', { text: `✏️ ${finalFiles.length} archivo(s) modificado(s):` });
    for (const f of finalFiles) {
      send('file', { path: f.path });
    }

    // Step 4: archivo principal para el diff
    const mainFile = finalFiles.find((f) => f.path.endsWith('.tsx')) ?? finalFiles[0];

    // ── VALIDACIÓN ANTES DEL DIFF ─────────────────────────────────────────────
    send('action', { text: '🔍 Validando código generado...' })

    try {
      const filesToValidate = finalFiles
        .map((f: { path: string; content: string }) => `--- ${f.path} ---\n${f.content.split('\n').slice(0, 100).join('\n')}`)
        .join('\n\n')

      const validationRaw = await generateWithFallback(
        `Analiza estos archivos de código TypeScript/JavaScript generados y detecta errores críticos.
    
${filesToValidate}

Responde SOLO con este JSON:
{
  "valid": true/false,
  "errors": ["descripción del error 1", "descripción del error 2"],
  "affectedFiles": ["path/del/archivo"]
}

Busca ÚNICAMENTE errores críticos:
- Imports rotos o referencias a módulos inexistentes
- Variables o funciones usadas sin declarar
- Sintaxis inválida obvia
- Exports faltantes que otros archivos necesitan
NO reportes advertencias de estilo ni errores menores.`,
        'Eres un validador de código experto. Devuelve SOLO el JSON solicitado sin markdown ni explicaciones.'
      )

      const validation = JSON.parse(
        validationRaw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim()
      ) as { valid: boolean; errors: string[]; affectedFiles: string[] }

      if (!validation.valid && validation.errors.length > 0) {
        send('action', { text: `⚠️ ${validation.errors.length} error(es) detectado(s) — corrigiendo...` })

        const filesToValidateStr = finalFiles
          .map((f: { path: string; content: string }) => `--- ${f.path} ---\n${f.content.split('\n').slice(0, 100).join('\n')}`)
          .join('\n\n')

        const fixPrompt = `El código generado tiene estos errores críticos:
${validation.errors.map((e: string, i: number) => `${i + 1}. ${e}`).join('\n')}

Archivos afectados: ${validation.affectedFiles.join(', ')}

Código original:
${filesToValidateStr}

Corrige ÚNICAMENTE los errores listados. Conserva toda la lógica existente.
Responde con el mismo JSON de siempre:
{
  "files": [{"path": "...", "content": "..."}],
  "commitMessage": "fix: corregir errores de validación",
  "mainComponent": "..."
}`

        const fixedRaw = await generateWithFallback(fixPrompt,
          'Eres un agente de corrección de código. Devuelve SOLO el JSON solicitado.'
        )

        try {
          const fixedParsed = JSON.parse(
            fixedRaw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim()
          ) as { files: { path: string; content: string }[]; commitMessage: string; mainComponent: string }

          for (const fixedFile of fixedParsed.files) {
            const idx = finalFiles.findIndex((f: { path: string }) => f.path === fixedFile.path)
            if (idx >= 0) {
              finalFiles[idx] = fixedFile
            }
          }
          send('action', { text: '✅ Errores corregidos automáticamente' })
        } catch {
          send('action', { text: '⚠️ No se pudo auto-corregir — revisa el diff con cuidado' })
        }
      } else {
        send('action', { text: '✅ Código validado — sin errores críticos' })
      }
    } catch {
      send('action', { text: '⚡ Validación omitida — continúa con revisión manual' })
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Fuzzy match: exact path → suffix match → basename match
    function findOriginal(fPath: string): string | undefined {
      const exact = preloadedFiles.find((p) => p.path === fPath);
      if (exact) return exact.content;
      const bySuffix = preloadedFiles.find(
        (p) => p.path.endsWith('/' + fPath) || fPath.endsWith('/' + p.path)
      );
      if (bySuffix) return bySuffix.content;
      const base = fPath.split('/').pop();
      const byBase = preloadedFiles.find((p) => p.path.split('/').pop() === base);
      if (byBase) return byBase.content;
      return undefined;
    }

    // For files with no preloaded original, fetch directly from GitHub
    const filesWithOriginal = await Promise.all(
      finalFiles.map(async (f: { path: string; content: string }) => {
        let originalContent = findOriginal(f.path);
        if (originalContent === undefined) {
          try {
            originalContent = await getFileContent(f.path, repo);
          } catch {
            // Truly new file — omit originalContent so diff shows single-column
          }
        }
        return originalContent !== undefined ? { ...f, originalContent } : { ...f };
      })
    );

    send('done', {
      files: filesWithOriginal,
      commitMessage,
      mainComponent: mainFile?.path,
      mainContent: filesWithOriginal.find((f: { path: string }) => f.path === mainFile?.path)?.content ?? mainFile?.content ?? '',
      repo,
      branch,
    });

    // Flush antes de cerrar — da tiempo al cliente de recibir 'done'
    await new Promise((resolve) => setTimeout(resolve, 100));
    res.end();
  } catch (err) {
    send('error', { text: err instanceof Error ? err.message : String(err) });
    res.end();
  }
});

const GENERATE_HTML_SYSTEM_PROMPT = `You are an elite UI engineer and visual designer. Your job is to generate a SINGLE complete HTML file with embedded CSS and JavaScript that implements the requested UI with exceptional visual quality.

STRICT RULES:
1. Return ONLY raw HTML. No markdown, no explanation, no code fences. Start with <!DOCTYPE html>.
2. All CSS must be inside a <style> tag in <head>.
3. All JavaScript must be inside a <script> tag before </body>.
4. No external CDN links. Use only vanilla HTML/CSS/JS.
5. Make it visually stunning. Use the exact colors, typography, and layout described in the brief.
6. Include real placeholder content: product names, prices, descriptions — all invented but coherent.
7. The design must be fully responsive and work inside an iframe at 390px width (mobile-first).
8. Implement ALL interactions described: hover effects, cart updates, modals, animations.
9. Color palette: respect what the brief specifies. If cyberpunk: use #0a0a0a background, neon green #00ff88 accents, monospace fonts.
10. DO NOT generate a skeleton. Generate a COMPLETE, production-quality UI.`;

function extractHtml(raw: string): string {
  const fenceMatch = raw.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fenceMatch) return fenceMatch[1].trim();

  const trimmed = raw.trim();
  if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) return trimmed;

  const doctypeStart = trimmed.indexOf('<!DOCTYPE');
  if (doctypeStart !== -1) return trimmed.slice(doctypeStart);

  const htmlTagStart = trimmed.indexOf('<html');
  if (htmlTagStart !== -1) return trimmed.slice(htmlTagStart);

  return trimmed;
}

router.post('/generate-html', async (req, res) => {
  const { prompt, projectName, code, files } = req.body as {
    prompt?: string;
    projectName?: string;
    code?: string;
    files?: { path: string; content: string }[];
  };

  // Path A: convierte TSX/código del Agent a HTML standalone con Gemini
  if (code) {
    try {
      const filesContext = files?.length
        ? `\n\nArchivos del proyecto:\n${JSON.stringify(files, null, 2)}`
        : '';

      const geminiPrompt = `Convierte este componente React/TSX a HTML puro standalone (sin imports, sin build step, usando CDN de React desde unpkg).${filesContext}\n\nComponente principal:\n${code}\n\nResponde SOLO con el HTML completo, sin markdown ni backticks. Empieza con <!DOCTYPE html>.`;

      const rawHtml = (await callAI('html', geminiPrompt)).trim();
      if (!rawHtml) throw new Error('Sin contenido HTML generado');
      const cleanHtml = extractHtml(rawHtml);
      return res.json({ html: cleanHtml, success: true });
    } catch (err) {
      console.error('[generate-html/gemini] error:', err);
      return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Path B: genera HTML desde design prompt (GitHub Models GPT-4o → Gemini)
  if (!prompt) return res.status(400).json({ success: false, error: 'prompt o code requerido' });

  try {
    const rawHtml = (await callAI('html', prompt, GENERATE_HTML_SYSTEM_PROMPT)).trim();
    if (!rawHtml) throw new Error('Sin contenido HTML generado');
    const cleanHtml = extractHtml(rawHtml);
    res.json({ html: cleanHtml, success: true });
  } catch (err) {
    console.error('[generate-html] error:', err);
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ── /fix — AI returns search/replace patch; backend applies it ───────────────
router.post('/fix', async (req, res) => {
  const { repo: bodyRepo, branch = 'main', filePath, errorDescription } = req.body as {
    repo?: string;
    branch?: string;
    filePath?: string;
    errorDescription?: string;
  };
  const repo = bodyRepo ?? process.env.GITHUB_REPO;
  console.log(`[Agent/fix] repo recibido dinámicamente: ${repo}`);

  if (!repo || !filePath || !errorDescription) {
    res.status(400).json({ error: 'repo, filePath and errorDescription are required' });
    return;
  }

  try {
    const originalContent = await getFileContent(filePath, repo);

    const raw = (await callAI(
      'fix',
      `Error/Problema: ${errorDescription}\n\nArchivo ${filePath}:\n${originalContent}`,
      `Eres un engineer senior experto en TypeScript/Node.js.
Recibes un archivo con un error y una descripción del problema.
Devuelve SOLO un objeto JSON con este formato exacto, sin markdown, sin backticks, sin explicaciones:
{"search":"texto exacto a buscar en el archivo","replace":"texto de reemplazo"}
El campo "search" debe ser una cadena que exista literalmente en el archivo.
El campo "replace" es el texto que lo sustituirá.
Si necesitas múltiples cambios, devuelve un array: [{"search":"...","replace":"..."},{"search":"...","replace":"..."}]`,
    )).trim();

    if (!raw) throw new Error('Sin respuesta del AI');

    // Parse the patch(es)
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    let patches: { search: string; replace: string }[];
    try {
      const parsed = JSON.parse(cleaned);
      patches = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      throw new Error(`No se pudo parsear el patch JSON: ${cleaned.slice(0, 200)}`);
    }

    // Apply all patches to the original file content
    let fixedContent = originalContent;
    const applied: { search: string; applied: boolean }[] = [];

    for (const patch of patches) {
      if (typeof patch.search !== 'string' || typeof patch.replace !== 'string') {
        applied.push({ search: String(patch.search), applied: false });
        continue;
      }
      if (fixedContent.includes(patch.search)) {
        fixedContent = fixedContent.split(patch.search).join(patch.replace);
        applied.push({ search: patch.search, applied: true });
      } else {
        console.warn(`[/fix] search string not found in file: ${patch.search.slice(0, 80)}`);
        applied.push({ search: patch.search, applied: false });
      }
    }

    const anyApplied = applied.some((a) => a.applied);
    if (!anyApplied) {
      throw new Error('Ningún patch coincidió con el contenido del archivo. El AI generó search strings incorrectos.');
    }

    res.json({ fixedContent, originalContent, filePath, branch, patches: applied });
  } catch (err) {
    console.error('[/fix] error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── GET /repo-context ────────────────────────────────────────────────────────
router.get('/repo-context', async (req, res) => {
  const repo = (req.query.repo as string | undefined)?.trim();
  if (!repo) {
    res.status(400).json({ error: 'repo query param required' });
    return;
  }

  const owner = process.env.GITHUB_OWNER ?? 'antoniozam20x2-ship-it';
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  try {
    // 1. Fetch full tree
    const treeRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=1`,
      { headers },
    );
    if (!treeRes.ok) {
      res.json({ repo, tree: [], keyFiles: [] });
      return;
    }
    const treeData = await treeRes.json() as { tree: { path: string; type: string }[] };
    const allPaths = treeData.tree
      .filter((n) => n.type === 'blob')
      .map((n) => n.path);

    // 2. Filter relevant files (routes > components > config, max 8)
    const isRelevant = (p: string) =>
      p === 'package.json' ||
      p.startsWith('src/routes/') ||
      (p.startsWith('src/components/') && p.endsWith('.tsx')) ||
      /\b(schema|types|db|config)\b/.test(p.split('/').pop() ?? '');

    const priority = (p: string): number => {
      if (p === 'package.json') return 3;
      if (p.startsWith('src/routes/')) return 2;
      if (p.startsWith('src/components/')) return 1;
      return 0;
    };

    const filtered = allPaths
      .filter(isRelevant)
      .sort((a, b) => priority(b) - priority(a))
      .slice(0, 8);

    // 3. Fetch content for each file (parallel), truncate to 150 lines
    const fileResults = await Promise.allSettled(
      filtered.map(async (path) => {
        const r = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
          { headers },
        );
        if (!r.ok) return { path, content: '(no disponible)' };
        const data = await r.json() as { content?: string; encoding?: string };
        if (!data.content || data.encoding !== 'base64') return { path, content: '(no disponible)' };
        const decoded = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8');
        const lines = decoded.split('\n').slice(0, 500).join('\n');
        return { path, content: lines };
      }),
    );

    const keyFiles = fileResults
      .filter((r): r is PromiseFulfilledResult<{ path: string; content: string }> => r.status === 'fulfilled')
      .map((r) => r.value);

    res.json({ repo, tree: allPaths, keyFiles });
  } catch {
    res.json({ repo, tree: [], keyFiles: [] });
  }
});

// GET /agent/session — load last persisted agent session
router.get('/session', async (_req, res) => {
  try {
    const content = await loadAgentSession();
    if (!content) { res.json({ session: null }); return; }
    res.json({ session: JSON.parse(content) });
  } catch {
    res.json({ session: null });
  }
});

// POST /agent/session — persist current agent session
router.post('/session', async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    if (!body) { res.status(400).json({ error: 'No body' }); return; }
    await saveAgentSession(JSON.stringify(body));
    res.json({ ok: true });
  } catch (err) {
    console.error('[agent/session] save error:', err);
    res.status(500).json({ error: 'Failed to save session' });
  }
});

router.delete('/context', async (_req, res) => {
  try {
    await pool.query(
      `DELETE FROM memory_entries WHERE key = $1 AND namespace = $2`,
      ['agent-context', AGENT_SESSION_NS],
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
