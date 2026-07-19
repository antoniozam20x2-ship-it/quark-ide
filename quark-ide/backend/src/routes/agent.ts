import { Router } from 'express';
import { getFileTree, getFileContent, getFileContentConditional, searchCodeInRepo, createOrUpdateFile } from '../services/github.js';
import { lookupSymbol, rgSearch, isCloned, REPOS_DIR, getRepoSymbolNames, SymbolMatch } from '../services/localRepos.js';
import { callAI } from '../lib/aiRouter.js';
import { generateContent, generateContentWithRotation } from '../services/gemini.js';
import pool from '../services/db.js';
import { cacheNotifications } from '../lib/cacheNotifications.js';
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { runAutoMode, readChangedFileContents, cleanupWorkDir } from '../services/agentSdkAuto.js';
import { createHash } from 'crypto';
import { createPatch } from 'diff';
import ts from 'typescript';

// ── Entorno de ejecución ──────────────────────────────────────────────────────
const QUARK_ENV: 'railway' | 'replit' | 'local' =
  process.env.RAILWAY_ENVIRONMENT            ? 'railway'
  : (process.env.REPL_ID || process.env.REPL_OWNER) ? 'replit'
  : 'local';

// Verificación real de herramientas — no asume que nixpacks.toml funcionó
function probeBinary(bin: string): string {
  try {
    const out = execSync(`${bin} --version`, { timeout: 5000, stdio: 'pipe' })
      .toString().split('\n')[0].trim();
    return `✅ ${out}`;
  } catch {
    return `❌ no encontrado`;
  }
}
const rgStatus    = probeBinary('rg');
const ctagsStatus = probeBinary('ctags');

console.log(
  `[ENV] Quark IDE modo ${QUARK_ENV.toUpperCase()} | REPOS_DIR=${REPOS_DIR}\n` +
  `[ENV]   rg:    ${rgStatus}\n` +
  `[ENV]   ctags: ${ctagsStatus}`,
);
if (QUARK_ENV === 'railway' && (rgStatus.startsWith('❌') || ctagsStatus.startsWith('❌'))) {
  console.warn('[ENV] ⚠️  Una o más herramientas faltan — rgSearch devolverá [] en silencio hasta que estén instaladas. Verificá nixpacks.toml y que no haya un Dockerfile que lo sobreescriba.');
}

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

async function loadChatHistory(sessionId: string): Promise<any[]> {
  try {
    const r = await pool.query<{ content: string }>(
      `SELECT content FROM memory_entries WHERE key = $1 AND namespace = $2 LIMIT 1`,
      [`chat-${sessionId}`, AGENT_SESSION_NS],
    );
    return r.rows[0]?.content ? JSON.parse(r.rows[0].content) : [];
  } catch {
    return [];
  }
}

async function saveChatHistory(sessionId: string, messages: any[]): Promise<void> {
  await pool.query(
    `INSERT INTO memory_entries (key, content, namespace)
     VALUES ($1, $2, $3)
     ON CONFLICT (key, namespace) DO UPDATE SET content = EXCLUDED.content, timestamp = NOW()`,
    [`chat-${sessionId}`, JSON.stringify(messages.slice(-40)), AGENT_SESSION_NS],
  );
}

async function summarizeForCache(preloadedFiles: { path: string; content: string }[]): Promise<string> {
  const keys = getGroqKeys();
  if (keys.length === 0 || preloadedFiles.length === 0) return '';

  const combined = preloadedFiles.map(f => `--- ${f.path} ---\n${f.content.slice(0, 800)}`).join('\n\n');
  try {
    const summary = await callGroqAgent(
      combined,
      'Resume en máximo 5 líneas qué contienen estos archivos: nombres de funciones/clases/variables clave, y su propósito. Sé conciso y concreto — prioriza nombres propios y datos específicos sobre descripciones generales.',
      200,
    );
    return summary;
  } catch {
    return '';
  }
}

export async function saveAgentContext(ctx: {
  preloadedFiles: { path: string; content: string; fullContent?: string; startLine?: number; endLine?: number }[]
  functionName: string | null
  prompt: string
  repo: string
  querySignature?: string
  savedAt?: number
  summary?: string
}): Promise<void> {
  const ctxWithSig = {
    ...ctx,
    querySignature: ctx.prompt.toLowerCase().split(/\s+/).filter(w => w.length > 4).slice(0, 3).join('|'),
    savedAt: Date.now(),
  };
  await pool.query(
    `INSERT INTO memory_entries (key, content, namespace)
     VALUES ($1, $2, $3)
     ON CONFLICT (key, namespace) DO UPDATE SET content = EXCLUDED.content, timestamp = NOW()`,
    ['agent-context', JSON.stringify(ctxWithSig), AGENT_SESSION_NS],
  );
}

async function loadAgentContext(): Promise<{
  preloadedFiles: { path: string; content: string; fullContent?: string; startLine?: number; endLine?: number }[]
  functionName: string | null
  prompt: string
  repo: string
  querySignature?: string
  savedAt?: number
  summary?: string
} | null> {
  try {
    console.log(`[CACHE] Attempting to load from memory_entries — repo: ${AGENT_SESSION_NS}`);
    const r = await pool.query<{ content: string }>(
      `SELECT content FROM memory_entries WHERE key = $1 AND namespace = $2 LIMIT 1`,
      ['agent-context', AGENT_SESSION_NS],
    );
    if (!r.rows[0]?.content) return null;
    const ctx = JSON.parse(r.rows[0].content);
    const ageSeconds = ctx.savedAt ? Math.floor((Date.now() - ctx.savedAt) / 1000) : -1;
    const isExpired = ageSeconds > 30 * 60;
    const fileCount = ctx.preloadedFiles?.length ?? 0;
    console.log(`[CACHE] Found ${fileCount} files, age: ${ageSeconds}s, expired: ${isExpired}`);
    return ctx;
  } catch {
    return null;
  }
}

// ── Investigation finding cache (FAST → DEEP handoff) ────────────────────────

const FINDING_NS = 'quark-fast-finding';
const FINDING_TTL_MS = 2 * 60 * 60 * 1000; // 2 horas — aplica solo a quark-fast-finding

interface InvestigationFinding {
  id: string;
  repo: string;
  files: { path: string; lineRanges?: { start: number; end: number; matchedTerm: string }[] }[];
  diagnosis: string; // FAST mode: AI prose summary; DEEP mode: raw citation text (no interpretation)
  evidence?: { path: string; line: number; fragment: string }[]; // DEEP mode: structured raw file:line citations
  confidence: 'high' | 'medium' | 'low';
  savedAt: number;
}

async function saveInvestigationFinding(
  finding: Omit<InvestigationFinding, 'id' | 'savedAt'>,
): Promise<string> {
  const id = `finding-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record: InvestigationFinding = { ...finding, id, savedAt: Date.now() };
  await pool.query(
    `INSERT INTO memory_entries (key, content, namespace)
     VALUES ($1, $2, $3)
     ON CONFLICT (key, namespace) DO UPDATE SET content = EXCLUDED.content, timestamp = NOW()`,
    [id, JSON.stringify(record), FINDING_NS],
  );
  return id;
}

async function loadInvestigationFinding(id: string, repo?: string): Promise<InvestigationFinding | null> {
  try {
    const r = await pool.query<{ content: string }>(
      `SELECT content FROM memory_entries WHERE key = $1 AND namespace = $2 LIMIT 1`,
      [id, FINDING_NS],
    );
    if (!r.rows[0]?.content) return null;
    const finding: InvestigationFinding = JSON.parse(r.rows[0].content);
    if (Date.now() - finding.savedAt > FINDING_TTL_MS) return null;
    // Invalidación por repo: si el repo actual difiere del que generó el finding, descartar
    if (repo && finding.repo && finding.repo !== repo) return null;
    return finding;
  } catch {
    return null;
  }
}

// ── Shared context (cross-surface: Agent ↔ Chat ↔ War Room) ───────────────────

async function saveContextSummary(
  repo: string,
  summary: string,
  origin: 'agent' | 'warroom' | 'chat' | 'test1',
  sourceFiles: string[] = [],
): Promise<void> {
  try {
    const key = `context-log:${repo}:${Date.now()}`;
    await pool.query(
      `INSERT INTO memory_entries (key, content, namespace) VALUES ($1, $2, $3)
       ON CONFLICT (key, namespace) DO UPDATE SET content = EXCLUDED.content, timestamp = NOW()`,
      [key, JSON.stringify({ repo, summary, origin, sourceFiles, savedAt: Date.now() }), 'quark-shared-context'],
    );
  } catch (err) {
    console.warn('[shared-context] save failed:', err instanceof Error ? err.message : err);
  }
}

async function loadRecentContextSummaries(
  repo: string,
  maxAgeMinutes = 30,
  limit = 5,
): Promise<Array<{ summary: string; origin: string; sourceFiles: string[]; savedAt: number }>> {
  try {
    const r = await pool.query<{ content: string }>(
      `SELECT content FROM memory_entries WHERE key LIKE $1 AND namespace = $2 ORDER BY timestamp DESC LIMIT $3`,
      [`context-log:${repo}:%`, 'quark-shared-context', limit],
    );
    const cutoff = Date.now() - maxAgeMinutes * 60 * 1000;
    return r.rows
      .map(row => JSON.parse(row.content))
      .filter(entry => entry.savedAt > cutoff);
  } catch {
    return [];
  }
}

async function summarizeForSharedContext(text: string): Promise<string> {
  const keys = getGroqKeys();
  if (!text.trim()) { console.warn('[shared-context] summarize — text vacío'); return ''; }
  if (keys.length === 0) { console.warn('[shared-context] summarize — sin Groq keys'); return ''; }
  try {
    const result = await callGroqAgent(
      text.slice(0, 3000),
      'Resume en máximo 4 líneas los datos concretos de este contenido. REGLAS ESTRICTAS: (1) Conservá los nombres técnicos exactamente como aparecen — no los parafrasees ni generalices. (2) Describí los mecanismos específicos que aparecen en el texto, no sus equivalentes genéricos. (3) No agregues "probablemente", "podría", ni ningún hedging que no estuviera en el original. (4) Prioriza: nombres de funciones/clases/variables → flujos de control específicos → valores y configuraciones concretas → propósito de cada pieza.',
      180,
    );
    console.log('[shared-context] summarize OK — chars:', result.length);
    return result;
  } catch (err) {
    console.warn('[shared-context] summarize failed:', err instanceof Error ? err.message : err);
    return '';
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

async function generateWithFallback(
  prompt: string,
  system: string,
  onFail?: (label: string, msg: string) => void,
): Promise<string> {
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
      onFail?.(label, lastErr.message)
    }
  }
  throw lastErr
}

/**
 * DEEP mode fallback chain: Gemini Flash-Lite primary (large context, key rotation)
 * → DeepSeek → Groq. Inverted from FAST because DEEP sends skeleton + multiple files
 * in a single pass where Gemini's context window is the real advantage.
 */
async function generateWithFallbackDeep(
  prompt: string,
  system: string,
  onFail?: (label: string, msg: string) => void,
): Promise<string> {
  const providers = [
    { label: 'Gemini',   fn: () => generateContentWithRotation(prompt, system, 8192, '/api/agent/deep') },
    { label: 'DeepSeek', fn: () => callDeepSeekAgent(prompt, system, 4096) },
    { label: 'Groq',     fn: () => callGroqAgent(prompt, system, 4096) },
  ]
  let lastErr: Error = new Error('All providers failed')
  for (const { label, fn } of providers) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      console.warn(`[agent/deep] ${label} failed: ${lastErr.message}`)
      onFail?.(label, lastErr.message)
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
): { content: string; failedOps: Array<{ old_str: string; new_str: string }> } {
  let content = originalContent;
  const failedOps: Array<{ old_str: string; new_str: string }> = [];

  for (const op of operations) {
    if (op.type !== 'str_replace') {
      sendFn('action', { text: `⚠️ Operación desconocida '${op.type}' — omitida` });
      continue;
    }

    // Exact match only — no fuzzy fallback
    const idx = content.indexOf(op.old_str);

    if (idx !== -1) {
      content = content.slice(0, idx) + op.new_str + content.slice(idx + op.old_str.length);
      sendFn('action', { text: `✅ Cambio aplicado en ${filePath}` });
      continue;
    }

    // old_str not found — track failure, continue with remaining ops
    sendFn('action', { text: `❌ old_str no encontrado en ${filePath}` });
    sendFn('action', { text: `⚠️ Texto buscado: "${op.old_str.slice(0, 80).replace(/\n/g, '↵')}${op.old_str.length > 80 ? '...' : ''}"` });
    failedOps.push({ old_str: op.old_str, new_str: op.new_str });
  }

  return { content, failedOps };
}

// ── Read intent detection ────────────────────────────────────────────────────
const READ_KEYWORDS  = /\b(lee|leer|muéstrame|muestra|busca|buscar|encuentra|ver|dime|qué tiene|qué hay|analiza|analizar|diagnóstico|diagnóstica|revisa|revisar|explica|explicar|describe|describir|inspecciona|inspeccionar|abre|abrir|lista|listar|qué hace|cómo está|cómo funciona|show me|read|find|look at)\b/i;
const GEN_KEYWORDS   = /\b(genera|generar|crea|crear|escribe|escribir|implementa|implementar|añade|añadir|agrega|agregar|cambia|cambiar|modifica|modificar|fix|arregla|arreglar|corrige|corregir|resetea|resetear|resuelve|resolver|sincroniza|sincronizar|repara|reparar|refactoriza|refactorizar|construye|construir|desarrolla|desarrollar|actualiza|actualizar|add|create|write|implement|modify|change|build|correct|resolve|reset|sync)\b/i;

const ANALYSIS_KEYWORDS = /\b(qué significa|qué es|cómo funciona|explica|cuándo se activa|por qué|cuáles son|qué argumentos|qué condiciones|cómo se calcula|señal|signal|S1|S2|S3|S4|S5|S6|score|scoring|bias|screener|scanner|trailing|streak|circuit)\b/i;

function detectReadIntent(prompt: string): boolean {
  const hasRead     = READ_KEYWORDS.test(prompt);
  const hasGen      = GEN_KEYWORDS.test(prompt);
  const hasAnalysis = ANALYSIS_KEYWORDS.test(prompt);
  // Read intent only if has read keywords AND no explicit generation keywords
  return (hasRead || hasAnalysis) && !hasGen;
}

async function classifyIntentWithAI(prompt: string): Promise<'read' | 'modify'> {
  const keys = getGroqKeys();
  if (keys.length === 0) {
    return detectReadIntent(prompt) ? 'read' : 'modify';
  }

  const systemPrompt = `Clasifica la intención del usuario respecto a un repositorio de código.
Responde ÚNICAMENTE con una palabra: "read" o "modify".

"read" = el usuario quiere ENTENDER, VER, EXPLICAR o DIAGNOSTICAR código existente, sin cambiarlo.
Ejemplos: "cómo funciona X", "explícame Y", "por qué falla Z", "muéstrame el archivo", "qué hace esta función".

"modify" = el usuario quiere CREAR, CAMBIAR, CORREGIR o AGREGAR código.
Ejemplos: "agrega una función", "corrige el bug de X", "cambia el color", "resetea el circuit breaker", "arregla Y".

Si hay ambigüedad, prioriza "read" — es más seguro pedir una explicación de más que modificar código sin que se pidiera.
Responde solo la palabra, sin explicación, sin puntuación.`;

  try {
    const raw = await callGroqAgent(prompt, systemPrompt, 10);
    const cleaned = raw.trim().toLowerCase();
    return cleaned.includes('modify') ? 'modify' : 'read';
  } catch {
    return detectReadIntent(prompt) ? 'read' : 'modify';
  }
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

async function extractKeywordsForSearch(prompt: string, repo: string = ''): Promise<string[]> {
  const keys = getGroqKeys();
  if (keys.length === 0) return [];

  // Signal OS non-obvious concept translations — applied only for that repo.
  // Each row returns ONLY the specific terms for that translation. No shared suffixes.
  const isSignalOS = /ahorar/i.test(repo);
  const signalOSLayer = isSignalOS ? `
TRADUCCIONES ESPECÍFICAS (solo para este repo — aplicalas si el prompt menciona exactamente estos conceptos, ignorá esta sección si no hay match):
- "RVOL" o "señal S1" → checkS1Bull
- "señal S2" o "SMC" o "smart money" → checkS2
- "señal S3" o "alineación" o "EMA" → checkS3Bull
- "señal S4" → checkS4
- "señal S5" o "impulso" o "early" → checkS5ImpulsBull
- "señal S6" o "FVG" o "fair value gap" → checkS6Bull
- "trailing" o "stop móvil" o "trailing stop" → trailingStop, moving_plan, rangeRate
- "streak" o "racha" o "pérdidas consecutivas" → circuitBreaker
` : '';

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      signal: ctrl.signal,
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
            content: `Extraé los identificadores técnicos y nombres propios del prompt del usuario para buscar en GitHub Code Search.
${signalOSLayer}
REGLAS:
- Extraé exactamente los términos técnicos, nombres de funciones, clases o variables que aparecen en el prompt.
- No agregues términos de contexto genérico que no estén mencionados en el prompt.
- Si el prompt contiene un concepto en lenguaje natural sin nombre técnico claro, usá las palabras más específicas del prompt tal como están.
- Devolvé un JSON array de máximo 4 strings.
- Respondé SOLO el array JSON, sin explicación, sin backticks.`,
          },
          { role: 'user', content: prompt },
        ],
      }),
    }).finally(() => clearTimeout(timer));

    if (!res.ok) return [];
    const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const raw = json.choices?.[0]?.message?.content ?? '[]';
    const parsed = JSON.parse(raw.trim()) as unknown;
    if (Array.isArray(parsed) && parsed.every((t) => typeof t === 'string')) {
      console.log(`[agent] AI keywords: [${parsed.join(', ')}]`);
      return parsed as string[];
    }
    return [];
  } catch (err) {
    console.warn('[agent] extractKeywordsForSearch failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

async function searchAndLoadFiles(
  prompt: string,
  repo: string,
  send: (event: string, data: Record<string, unknown>) => void,
): Promise<{ path: string; content: string; fullContent?: string; lineRanges?: { start: number; end: number; matchedTerm: string }[] }[]> {
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
    'signalHistory',
    'signalDirection',
    'SignalContext',
    'SignalBubbles',
    'lib/api-zod/',
    'generated/',
    'db.ts',
    'gemini.ts',
    'routes/gemini',
  ];

  const isCodeFile = (path: string): boolean =>
    !EXCLUDED_PATHS.some((ex) => path.includes(ex));

  const keywords = await extractKeywordsForSearch(prompt, repo);

  const searchTerms = keywords.length > 0
    ? keywords
    : prompt.split(/\s+/).filter((w) => w.length > 5).slice(0, 3);

  send('action', { text: `🔎 Buscando: [${searchTerms.join(', ')}]` });

  // Un solo llamado con todos los términos unidos por "|" — aprovecha symbol_index + ripgrep de una vez
  let allMatches: GrepMatch[] = [];
  try {
    allMatches = await unifiedGrepSearch(searchTerms.join('|'), repo, send);
  } catch (e: any) {
    if (e.message !== 'GITHUB_RATE_LIMIT') throw e;
    send('action', { text: '⚠️ GitHub rate limit alcanzado durante el fallback — usando resultados parciales o árbol de archivos' });
  }

  const codeMatches = allMatches.filter((m) => isCodeFile(m.path));

  if (codeMatches.length > 0) {
    const uniquePaths = [...new Map(codeMatches.map(m => [m.path, m])).values()];
    send('action', { text: `📂 Encontrado — leyendo ${Math.min(uniquePaths.length, 3)} archivo(s)...` });
    console.log(`[agent] unifiedGrepSearch → ${uniquePaths.length} archivos: ${uniquePaths.map(m => m.path).join(', ')}`);

    const loaded = await Promise.allSettled(
      uniquePaths.slice(0, 3).map(async (m) => {
        const fullContent = await getFileContent(m.path, repo);
        const lines = fullContent.split('\n');

        if (lines.length <= 300) {
          return { path: m.path, content: fullContent, fullContent, lineRanges: undefined };
        }

        // Preferir el número de línea del match si está disponible
        let hitLine = m.line !== undefined ? m.line - 1 : -1;
        let hitTerm = searchTerms[0];

        if (hitLine === -1) {
          hitTerm = searchTerms.find(t =>
            fullContent.toLowerCase().includes(t.toLowerCase())
          ) ?? searchTerms[0];
          hitLine = lines.findIndex(l =>
            l.toLowerCase().includes(hitTerm.toLowerCase())
          );
        }

        if (hitLine === -1) {
          return { path: m.path, content: lines.slice(0, 300).join('\n'), fullContent };
        }

        const start = Math.max(0, hitLine - 3);
        const end = Math.min(lines.length, hitLine + 25);
        const section = lines.slice(start, end).join('\n');

        console.log(`[agent] ${m.path}: extracting lines ${start}-${end} around "${hitTerm}" (hit at line ${hitLine})`);

        return {
          path: m.path,
          content: `// ... (líneas 1-${start} omitidas)\n\n${section}\n\n// ... (líneas ${end}-${lines.length} omitidas)`,
          fullContent,
          lineRanges: [{ start: start + 1, end, matchedTerm: hitTerm }],
        };
      })
    );

    return loaded
      .filter((r): r is PromiseFulfilledResult<{ path: string; content: string; fullContent: string }> => r.status === 'fulfilled')
      .map((r) => r.value);
  }

  send('action', { text: '⚠️ Sin resultados en índice local ni GitHub — usando árbol como fallback' });
  return [];
}

const PRIORITY_PATTERNS = [
  /server\.(ts|js)$/,
  /lib\//,
  /routes\//,
  /services\//,
  /engine\.(ts|js)$/,
  /detector\.(ts|js)$/,
  /tradingLogic/,
  /botEngine/,
  /scoring/,
  /screener/,
];
const FRONTEND_PATTERNS = [
  /components\//,
  /pages\//,
  /\.tsx$/,
  /hooks\//,
];

const LIST_FILES_EXCLUDED = ['node_modules/', '.lock', 'dist/', '.git/', 'package-lock.json'];
const LIST_FILES_MAX = 150;

async function listFilesFiltered(repo: string, filterPath?: string): Promise<string> {
  const tree = await getFileTree(repo, 'main');

  let paths = tree
    .filter((f: any) => f.type === 'blob')
    .map((f: any) => f.path as string)
    .filter((p: string) => !LIST_FILES_EXCLUDED.some(ex => p.includes(ex)));

  if (filterPath) {
    paths = paths.filter((p: string) => p.startsWith(filterPath));
  }

  const score = (p: string): number =>
    PRIORITY_PATTERNS.some(pt => pt.test(p)) ? 0 :
    FRONTEND_PATTERNS.some(pt => pt.test(p)) ? 1 : 2;

  paths.sort((a: string, b: string) => score(a) - score(b));

  const shown = paths.slice(0, LIST_FILES_MAX);
  const suffix = paths.length > LIST_FILES_MAX
    ? `\n// ... (${paths.length - LIST_FILES_MAX} archivos más — usá el parámetro "path" para filtrar por carpeta)`
    : '';

  return shown.join('\n') + suffix;
}

const AGENT_TOOLS = [
  {
    name: "read_file",
    description: "Lee un archivo del repo. Para archivos grandes, especificá start_line/end_line para traer solo la sección relevante (más eficiente). Si no especificás rango, se devuelven las primeras ~2000 tokens del archivo.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        start_line: { type: "number" },
        end_line: { type: "number" }
      },
      required: ["path"]
    }
  },
  {
    name: "grep_code",
    description: "Busca un patrón/función/variable en todo el repo, devuelve archivo+línea",
    input_schema: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"]
    }
  },
  {
    name: "list_files",
    description: "Lista archivos del repo, opcionalmente filtrado por carpeta",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } }
    }
  },
  {
    name: "apply_patch",
    description: "Aplica un str_replace sobre un archivo. old_str debe ser único y existir literalmente.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_str: { type: "string" },
        new_str: { type: "string" }
      },
      required: ["path", "old_str", "new_str"]
    }
  },
  {
    name: "task_complete",
    description: "Llamar cuando el cambio está terminado y verificado",
    input_schema: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"]
    }
  }
];

const CHAT_TOOLS = [
  ...AGENT_TOOLS,
  {
    name: "propose_patch",
    description: "Propone un cambio para revisión del usuario ANTES de aplicarlo. Úsala en vez de apply_patch cuando quieras que el usuario apruebe primero.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_str: { type: "string" },
        new_str: { type: "string" },
        reasoning: { type: "string", description: "Por qué este cambio resuelve la causa raíz, no solo el síntoma" }
      },
      required: ["path", "old_str", "new_str", "reasoning"]
    }
  }
];

async function runAgenticLoop(
  prompt: string,
  repo: string,
  send: (event: string, data: Record<string, unknown>) => void,
  seedFiles: { path: string; content: string }[] = [],
  seedReasoning: string = '',
  maxTurns = 12,
): Promise<{ files: { path: string; content: string }[]; commitMessage: string; incomplete: boolean }> {
  const modifiedFiles = new Map<string, string>();
  for (const f of seedFiles) {
    modifiedFiles.set(f.path, f.content);
  }
  const seedContext = seedFiles.length > 0
    ? `\n\nYA SE INVESTIGÓ Y SE CARGARON ESTOS ARCHIVOS — NO los vuelvas a buscar con grep_code, léelos directo con read_file si necesitas más detalle, o modifícalos directo con apply_patch:\n${seedFiles.map(f => f.path).join('\n')}` 
    : '';
  const reasoningNote = seedReasoning
    ? `\n\nANÁLISIS PREVIO DE CAUSA RAÍZ (ya hecho, no lo repitas, úsalo como punto de partida):\n${seedReasoning}`
    : '';
  const messages: any[] = [
    { role: 'user', content: [{ type: 'text', text: `TAREA: ${prompt}\n\nRepo: ${repo}${seedContext}${reasoningNote}\n\nUsa las tools para explorar el código, entender el problema y aplicar el fix mínimo necesario. Verifica que old_str exista literalmente antes de usar apply_patch. Cuando termines, llama a task_complete.`, cache_control: { type: 'ephemeral' } }] }
  ];

  let commitMessage = 'fix: cambio aplicado por QUARK Agent (modo agéntico)';

  for (let turn = 0; turn < maxTurns; turn++) {
    send('action', { text: `🔄 Turno ${turn + 1}/${maxTurns}` });

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 2048,
        tools: AGENT_TOOLS.map((t, i) =>
          i === AGENT_TOOLS.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t
        ),
        messages,
      }),
    });

    const data = await res.json() as { type?: string; error?: { message: string }; content: any[]; stop_reason: string };
    if (!res.ok || data.type === 'error') {
      send('action', { text: `❌ Error de API en turno ${turn + 1}: ${data.error?.message ?? `HTTP ${res.status}`}` });
      return {
        files: Array.from(modifiedFiles.entries()).map(([path, content]) => ({ path, content })),
        commitMessage,
        incomplete: true,
      };
    }
    messages.push({ role: 'assistant', content: data.content });

    const toolUses = data.content.filter((b) => b.type === 'tool_use');

    if (toolUses.length === 0) {
      break;
    }

    const toolResults: any[] = [];

    for (const tool of toolUses) {
      let resultText = '';

      if (tool.name === 'list_files') {
        resultText = await listFilesFiltered(repo, tool.input.path);
      }

      if (tool.name === 'read_file') {
        send('action', { text: `📖 Leyendo ${tool.input.path}` });
        const content = modifiedFiles.get(tool.input.path) ?? await getFileContent(tool.input.path, repo);
        const lines = content.split('\n');
        if (tool.input.start_line) {
          resultText = lines.slice(tool.input.start_line - 1, tool.input.end_line ?? lines.length).join('\n');
        } else {
          resultText = lines.length > 500
            ? lines.slice(0, 500).join('\n') + `\n// ... (${lines.length - 500} líneas más, pide un rango si necesitas más)`
            : content;
        }
        if (!modifiedFiles.has(tool.input.path)) modifiedFiles.set(tool.input.path, content);
      }

      if (tool.name === 'grep_code') {
        send('action', { text: `🔎 Buscando "${tool.input.pattern}"` });
        try {
          const agMatches = await unifiedGrepSearch(tool.input.pattern, repo, send);
          if (agMatches.length === 0) {
            resultText = isCloned(repo)
              ? `Sin resultados para "${tool.input.pattern}" en el clon local. El término puede no existir literalmente — revisá variantes o usá read_file en los archivos más probables.`
              : `Sin resultados vía GitHub code search para "${tool.input.pattern}".`;
          } else {
            resultText = agMatches.map(m => {
              if (m.symbolType) return `${m.path} — línea ${m.line}: [${m.symbolType}] "${m.text}"`;
              if (m.line) return `${m.path} — línea ${m.lineApprox ? '~' : ''}${m.line}: "${m.text}"`;
              return `${m.path} — "${m.text}"`;
            }).join('\n');
          }
        } catch (e: any) {
          if (e.message === 'GITHUB_RATE_LIMIT') {
            resultText = `Error: GitHub code search rate limit alcanzado (10 req/min). Esperá ~1 min y reintentá, o usá read_file directamente en los archivos sospechosos.`;
          } else {
            throw e;
          }
        }
      }

      if (tool.name === 'apply_patch') {
        const { path, old_str, new_str } = tool.input;
        const current = modifiedFiles.get(path) ?? await getFileContent(path, repo);
        const idx = current.indexOf(old_str);
        if (idx === -1) {
          resultText = `ERROR: old_str no encontrado literalmente en ${path}. Vuelve a leer el archivo con read_file y copia el texto exacto.`;
        } else if (current.indexOf(old_str, idx + 1) !== -1) {
          resultText = `ERROR: old_str no es único en ${path}. Agrega más líneas de contexto.`;
        } else {
          const patched = current.slice(0, idx) + new_str + current.slice(idx + old_str.length);
          modifiedFiles.set(path, patched);
          resultText = `OK: patch aplicado en ${path}`;
          send('action', { text: `✅ Patch aplicado en ${path}` });
        }
      }

      if (tool.name === 'task_complete') {
        commitMessage = `fix: ${tool.input.summary}`;
        send('action', { text: `🎯 ${tool.input.summary}` });
        toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: 'OK' });
        messages.push({ role: 'user', content: toolResults });
        return {
          files: Array.from(modifiedFiles.entries()).map(([path, content]) => ({ path, content })),
          commitMessage,
          incomplete: false,
        };
      }

      toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: resultText });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  send('action', { text: `⚠️ Se alcanzó el límite de ${maxTurns} turnos sin task_complete` });
  return {
    files: Array.from(modifiedFiles.entries()).map(([path, content]) => ({ path, content })),
    commitMessage,
    incomplete: true,
  };
}

async function validateWithTsc(
  finalFiles: { path: string; content: string }[],
  preloadedFiles: { path: string; content: string; fullContent?: string }[],
  repo: string,
): Promise<{ valid: boolean; errors: string[]; affectedFiles: string[] }> {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'quark-validate-'));

  try {
    for (const f of finalFiles) {
      const fullPath = path.join(tmpDir, f.path);
      mkdirSync(path.dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, f.content, 'utf-8');
    }

    for (const f of preloadedFiles) {
      if (finalFiles.some(ff => ff.path === f.path)) continue;
      const fullPath = path.join(tmpDir, f.path);
      mkdirSync(path.dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, f.fullContent ?? f.content, 'utf-8');
    }

    const tsconfigContent = await getFileContent('tsconfig.json', repo).catch(() => null);
    if (tsconfigContent) {
      writeFileSync(path.join(tmpDir, 'tsconfig.json'), tsconfigContent, 'utf-8');
    }

    execSync(
      `npx tsc --noEmit --pretty false --skipLibCheck --moduleResolution node ${finalFiles.map(f => `"${f.path}"`).join(' ')}`,
      { cwd: tmpDir, timeout: 20_000, encoding: 'utf-8' },
    );
    return { valid: true, errors: [], affectedFiles: [] };
  } catch (err: any) {
    const output: string = err.stdout?.toString() ?? '';
    const errors = output
      .split('\n')
      .filter((line) => /error TS\d+:/.test(line))
      .filter((line) => finalFiles.some(f => line.includes(f.path.split('/').pop() ?? '')))
      .slice(0, 15);
    const affectedFiles = finalFiles
      .filter(f => errors.some(e => e.includes(f.path.split('/').pop() ?? '')))
      .map(f => f.path);
    return { valid: errors.length === 0, errors, affectedFiles };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

router.post('/auto', async (req, res) => {
  const { prompt, repo: bodyRepo, branch = 'main' } = req.body as {
    prompt?: string; repo?: string; branch?: string;
  };
  const repo = bodyRepo ?? process.env.GITHUB_REPO;

  if (!prompt || !repo) {
    res.status(400).json({ error: 'prompt and repo are required' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (event: string, data: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify({ event, ...data })}\n\n`);
  };

  let workDir = '';
  try {
    const result = await runAutoMode(
      `${prompt}\n\n(Nota: el código fuente puede estar anidado dentro de una subcarpeta del repo, ej. backend/src o <nombre-repo>/backend/src — verificá la estructura real con un solo comando find o glob antes de asumir que está en la raíz.)`,
      repo,
      branch,
      send,
    );
    workDir = result.workDir;

    if (!result.success) {
      send('action', { text: `❌ AUTO falló: ${result.error}` });
      send('done', { files: [], commitMessage: '', mainComponent: '', mainContent: '', repo, branch });
      res.end();
      return;
    }

    if (result.changedFiles.length === 0) {
      send('action', { text: '⚠️ AUTO no modificó ningún archivo' });
      send('done', { files: [], commitMessage: '', mainComponent: '', mainContent: '', repo, branch });
      res.end();
      return;
    }

    const filesWithContent = await readChangedFileContents(workDir, result.changedFiles, repo);

    send('done', {
      files: filesWithContent,
      commitMessage: `feat: cambio autónomo vía Quark AUTO — ${result.summary.slice(0, 100)}`,
      mainComponent: filesWithContent[0]?.path ?? '',
      mainContent: filesWithContent[0]?.content ?? '',
      totalCostUsd: result.totalCostUsd,
      repo,
      branch,
    });
  } catch (err) {
    send('error', { text: err instanceof Error ? err.message : String(err) });
  } finally {
    if (workDir) cleanupWorkDir(workDir);
    res.end();
  }
});

router.post('/generate', async (req, res) => {
  // Auto-detectar deepMode desde prefijos del prompt
  let { prompt: rawPrompt, repo: bodyRepo, branch = 'main', projectName, deepMode, findingId } = req.body as {
    prompt?: string; repo?: string; branch?: string; projectName?: string; deepMode?: boolean; findingId?: string;
  };

  // Auto-detect mode from prefixes — takes priority over toggle
  if (rawPrompt?.includes('[DEEP]')) deepMode = true;
  if (rawPrompt?.includes('[FAST]')) deepMode = false;

  // Capturar intención explícita ANTES de borrar los prefijos
  const forceModifyIntent = /\[DEEP\]\[MODIFICAR\]|\[DEEP\]\[CREAR\]/i.test(rawPrompt ?? '');
  // resolvedIntent se calcula después de parsear prompt (ver más abajo)

  // Strip prefixes from prompt
  const prompt = rawPrompt
    ?.replace(/\[DEEP\]\[CREAR\]/gi, '')
    ?.replace(/\[DEEP\]\[MODIFICAR\]/gi, '')
    ?.replace(/\[DEEP\]\[AUDITAR\]/gi, '')
    ?.replace(/\[DEEP\]/gi, '')
    ?.replace(/\[FAST\]/gi, '')
    ?.trim();

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
    const resolvedIntent = forceModifyIntent ? 'modify' : await classifyIntentWithAI(prompt);
    console.log(`[Agent/generate] resolvedIntent="${resolvedIntent}" forceModify=${forceModifyIntent}`);

    // ── FAST READ PATH — explicit filename in prompt, skip tree + Gemini ──────
    const fastFileMatch = prompt.match(/[\w/\-\.]+\.(tsx|jsx|yaml|json|html|css|yml|env|py|md|ts|js|sh)/);
    if (fastFileMatch && resolvedIntent === 'read') {
      const filePath = fastFileMatch[0];
      send('action', { text: `📖 Modo lectura directa — ${filePath}` });
      let content: string;
      try {
        content = await getFileContent(filePath, repo);
      } catch {
        send('action', { text: `⚠️ ${filePath} no encontrado en la raíz — buscando ruta real...` });
        const searchResults = await searchCodeInRepo(filePath.split('/').pop() ?? filePath, repo);
        if (searchResults.length === 0) {
          send('action', { text: `❌ No se encontró ningún archivo llamado ${filePath} en el repo` });
          send('done', { files: [], commitMessage: '', mainComponent: '', mainContent: '', repo, branch });
          await new Promise((r) => setTimeout(r, 100));
          res.end();
          return;
        }
        const realPath = searchResults[0].path;
        send('action', { text: `📍 Encontrado en: ${realPath}` });
        content = await getFileContent(realPath, repo);
      }

      try {
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
        // Guardar en contexto compartido (FAST READ PATH)
        const fastSharedSummary = await summarizeForSharedContext(finalContent);
        const fastSummaryText = fastSharedSummary || `Archivo leído: ${filePath}`;
        await saveContextSummary(repo, fastSummaryText, 'agent', [filePath])
          .catch(err => console.warn('[shared-context] FAST PATH save failed:', err instanceof Error ? err.message : err));
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

    // ── READ PATH — FAST or DEEP based on deepMode toggle ───────────────────
    if (resolvedIntent === 'read') {

      // ── FAST READ (deepMode === false) ──────────────────────────────────────
      // One pass: symbol_index + fuzzy-match → smartReadSection (~20-40 lines).
      // Groq output: prose only — ZERO code blocks or bare code lines.
      // If the first pass finds nothing: say so and stop. No retry.
      if (!deepMode) {
        send('action', { text: '⚡ FAST — localizando símbolo...' });

        const fastKeywords = await extractKeywordsForSearch(prompt, repo);
        const fastPattern = fastKeywords.length > 0
          ? fastKeywords.join('|')
          : prompt.split(/\s+/).filter(w => w.length > 4).slice(0, 3).join('|');

        // searchWithTestFallback: first pass → if all test → retry without test paths.
        // Returns matches sorted production-first; allTest=true when retry also failed.
        const { matches: fastMatches, allTest: fastAllTest } =
          await searchWithTestFallback(fastPattern, repo, send);

        if (fastMatches.length === 0) {
          send('action', { text: '❌ No encontré referencias directas a esos términos. Reformulá con el nombre exacto de la función o variable, o usá DEEP mode para una búsqueda extensiva.' });
          send('done', { files: [], commitMessage: '', mainComponent: '', mainContent: '', repo, branch });
          await new Promise(r => setTimeout(r, 100));
          res.end();
          return;
        }

        // fastMatches already sorted production-first by searchWithTestFallback.
        const best = fastMatches[0];
        const bestIsTest = fastAllTest; // true only when ALL results (incl. retry) are test
        if (bestIsTest) {
          send('action', { text: '⚠️ Solo encontré código de test — el símbolo de producción puede tener un nombre diferente. Reformulá con el nombre exacto o usá DEEP mode.' });
        }
        send('action', { text: `📍 Símbolo encontrado: ${best.path}${best.line ? `:${best.line}` : ''}` });

        // Cambio 3: si el hit viene de ripgrep (sin symbolType), intentar resolver
        // la definición real del símbolo en symbol_index antes de leer el fragmento.
        // Evita que readEnclosingFunction lea la función LLAMADORA en vez del cuerpo
        // del símbolo buscado cuando ripgrep retornó un call site en vez de la definición.
        let readPath = best.path;
        let readLine  = best.line;
        if (!best.symbolType && fastKeywords.length > 0) {
          for (const kw of fastKeywords) {
            if (/^[a-zA-Z_$][a-zA-Z0-9_$]+$/.test(kw)) {
              const sym = await lookupSymbol(kw, repo);
              if (sym?.symbolType === 'function') {
                readPath = sym.filePath;
                readLine  = sym.lineNumber;
                send('action', { text: `🎯 Definición en índice: ${sym.filePath}:${sym.lineNumber}` });
                break;
              }
            }
          }
        }

        let sectionText = '';
        let sectionStart = 0;
        let sectionEnd = 0;
        try {
          const fullContent = await getFileContent(readPath, repo);
          const section = readLine
            // BUG 4 fix: read the full enclosing function so conditions near the
            // bottom of a function body (e.g. RSI 46-54 check) are not cut off.
            // Falls back to smartReadSection ±60 lines if brace-matching fails.
            ? (readEnclosingFunction(fullContent, readLine) ?? smartReadSection(fullContent, readLine, 60))
            : smartReadSection(fullContent, best.text ?? '', 60);
          if (section) {
            sectionText = section.excerpt;
            sectionStart = section.startLine;
            sectionEnd = section.endLine;
          } else {
            const firstLines = fullContent.split('\n').slice(0, 40);
            sectionText = firstLines.map((l, i) => `${i + 1}: ${l}`).join('\n');
            sectionEnd = firstLines.length;
          }

          // Cambio 1: inyectar constantes UPPER_CASE referenciadas en el fragmento
          // pero definidas fuera de él (en el mismo archivo, ya cargado en memoria).
          // Costo: cero red — fullContent ya está en memoria, es un scan O(n) de strings.
          if (sectionText) {
            const rawExcerpt = sectionText.replace(/^\d+:\s*/mg, ''); // quitar prefijos de línea
            const allConstNames = [...rawExcerpt.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)].map(m => m[1]);
            const uniqueConsts = [...new Set(allConstNames)]
              .filter(c => !new RegExp(`\\b${c}\\s*[=:]`).test(rawExcerpt)); // no definidas en el fragmento
            if (uniqueConsts.length > 0) {
              const fileLines = fullContent.split('\n');
              const constDefs: string[] = [];
              for (const constName of uniqueConsts.slice(0, 10)) {
                const lineIdx = fileLines.findIndex(
                  l => /\b(const|let|var|export)\b/.test(l) && l.includes(constName) && l.includes('=')
                );
                if (lineIdx !== -1 && (lineIdx + 1 < sectionStart || lineIdx + 1 > sectionEnd)) {
                  constDefs.push(`${lineIdx + 1}: ${fileLines[lineIdx].trimEnd()}`);
                }
              }
              if (constDefs.length > 0) {
                const header = `// Constantes referenciadas (definidas fuera del fragmento):\n${constDefs.join('\n')}\n`;
                sectionText = header + '\n' + sectionText;
                send('action', { text: `📎 +${constDefs.length} constante(s): ${uniqueConsts.slice(0, 4).join(', ')}` });
              }
            }
          }
        } catch {
          send('action', { text: '⚠️ No se pudo leer el contexto del símbolo.' });
          send('done', { files: [], commitMessage: '', mainComponent: '', mainContent: '', repo, branch });
          await new Promise(r => setTimeout(r, 100));
          res.end();
          return;
        }

        try {
          const fastAnalysis = await generateWithFallback(
            `El usuario pregunta: "${prompt}"\n\nFragmento del código en ${best.path} (líneas ${sectionStart}-${sectionEnd}):\n${sectionText}`,
            `Eres un experto analista de código de trading respondiendo en FAST mode.

REGLA DE VOCABULARIO — obligatoria:
Usá los términos técnicos de trading tal como los usa un trader profesional, en inglés cuando corresponda: \
**FVG**, **EMA**, **SMA**, **RSI**, **ADX**, **ATR**, **SuperTrend**, **VWAP**, **RVOL**, **Score**, etc. \
NUNCA los parafrasees con descripciones genéricas ("hueco entre velas", "promedio móvil", "indicador de fuerza"). \
El usuario ya conoce estos términos y quiere verlos directamente.

REGLA DE FORMATO — sin excepciones:
- Escribí en párrafos de prosa conectada (NO bullets sueltos, NO listas).
- Aplicá **negrita** a cada término técnico de trading y a cada valor numérico clave (períodos, umbrales, scores, multiplicadores) \
cada vez que aparecen. Ejemplos: **FVG**, **EMA10**, **ATR × 0.03**, **Score ≥ 50**, **3 velas**.
- PROHIBIDO: bloques de código con triple backtick, líneas de código sueltas, expresiones con operadores crudos (===, &&, arr[i]).
- Si el código tiene un valor numérico concreto, nombralo con negrita y contexto: "**EMA10**", "umbral de **3 velas**", \
"multiplicador **0.3**" — NUNCA "un parámetro configurable".
- Máximo 3 párrafos cortos (2-3 oraciones cada uno).

ESTRUCTURA:
Párrafo 1 — qué hace / cuál es el propósito de la señal o función.
Párrafo 2 — cómo funciona: condiciones, indicadores y valores concretos con negrita.
Párrafo 3 — cuándo se activa / restricciones o contexto de uso.

REGLA DE SCOPE:
Si el fragmento incluye un bloque "// Constantes referenciadas" con múltiples valores del mismo tipo \
(ej. varios períodos de EMA), mencioná solo los que tienen un ROL ACTIVO en la lógica de la función analizada. \
No listés todas las constantes inyectadas si la función solo usa una.

REGLA ANTI-ALUCINACIÓN: Solo afirmá lo que está explícitamente en el fragmento. \
Si el fragmento no alcanza para responder del todo, decilo en una oración y sugerí DEEP mode.

REGLA DE FIDELIDAD PARCIAL — cuando el fragmento es de test o cubre solo parte de la pregunta:
Identificá si el fragmento es de test (nombres como testFoo, mockBar, comentarios de /api/dev/, etc.) \
o si solo cubre parcialmente la pregunta. En ese caso:
  1. Decilo en UNA oración concisa al inicio del párrafo 1: "Este fragmento corresponde a código \
de test, no a la implementación de producción." — o equivalente según el caso.
  2. Luego describí con la MISMA PRECISIÓN Y DETALLE que en casos exitosos lo que el fragmento \
SÍ muestra con certeza: parámetros reales, valores concretos, flujo visible, condiciones presentes. \
Aplicá las mismas reglas de vocabulario, **negrita** y detalle numérico — no diluyas la descripción.
  3. PROHIBIDO usar "se puede inferir", "podría ser", "sería necesario examinar" para describir \
lo que el fragmento YA MUESTRA con certeza. Esas frases solo son válidas para afirmaciones \
sobre código que NO está en el fragmento — no para lo que sí está visible.`,
          );

          const fastLines = fastAnalysis.split('\n').map(l => l.trim()).filter(Boolean);
          for (const line of fastLines) {
            send('action', { text: `💡 ${line}` });
          }

          // BUG 5 fix: confidence level derives from match origin, not hardcoded 'medium'.
          // symbol_index hit (symbolType set) = exact lookup → HIGH.
          // fuzzy-match / ripgrep hit = approximate location → MEDIUM.
          // Test match: cap at 'medium' regardless of lookup method (not production code).
          const fastConfidence: 'high' | 'medium' = (best.symbolType && !bestIsTest) ? 'high' : 'medium';
          const fastConfidenceReason = bestIsTest
            ? 'FAST mode — resultado de test/dev, no de producción. Reformulá con el nombre exacto de la función de producción o usá DEEP mode.'
            : fastConfidence === 'high'
              ? 'FAST mode — símbolo ubicado por symbol_index (lookup exacto)'
              : 'FAST mode — símbolo ubicado por fuzzy-match/ripgrep (posición aproximada)';

          const fastFindingId = await saveInvestigationFinding({
            repo,
            files: [{ path: best.path, lineRanges: best.line ? [{ start: sectionStart, end: sectionEnd, matchedTerm: fastPattern }] : [] }],
            diagnosis: fastAnalysis,
            confidence: fastConfidence,
          }).catch(() => null);

          send('confidence', {
            level: fastConfidence,
            reason: fastConfidenceReason,
            suggestedAction: 'deep',
            files: [best.path],
            diagnosis: fastAnalysis,
            findingId: fastFindingId ?? undefined,
          });

          const fastSharedSummary = await summarizeForSharedContext(fastAnalysis);
          await saveContextSummary(repo, fastSharedSummary || `FAST read: ${best.path}`, 'agent', [best.path])
            .catch(() => {});
        } catch {
          send('action', { text: '⚠️ Análisis no disponible — intenta reformular la pregunta' });
        }

        send('done', { files: [], commitMessage: '', mainComponent: best.path, mainContent: '', repo, branch });
        await new Promise(r => setTimeout(r, 100));
        res.end();
        return;
      }

      // ── DEEP READ (deepMode === true) ───────────────────────────────────────
      // Step 1: generateStructuralSkeleton on top repo files to locate relevant code.
      // Step 2: symbol_index + fuzzy-match + ripgrep — stops at first confirmed hit.
      // Step 3: extract literal fragments with exact file:line citations.
      // Output: raw evidence only — NO interpretation, NO diagnosis, NO "probablemente".
      send('action', { text: '🔭 DEEP — explorando estructura del repo...' });

      // Step 1: generate structural skeletons of the top repo files (sorted by
      // PRIORITY_PATTERNS already applied to filePaths above). Skeletons are
      // sent to Gemini Flash-Lite in one pass — large context is the reason
      // Gemini is the primary model here, not Groq.
      const topFilePaths = filePaths.split('\n').filter(Boolean).slice(0, 8);
      const skeletonParts: string[] = [];
      await Promise.allSettled(topFilePaths.map(async fp => {
        try {
          const fc = await getFileContent(fp, repo);
          const sk = generateStructuralSkeleton(fc, fp);
          if (sk && sk !== fc) {
            skeletonParts.push(`--- skeleton: ${fp} ---\n${sk.split('\n').slice(0, 30).join('\n')}`);
          }
        } catch { /* skip unfetchable */ }
      }));
      if (skeletonParts.length > 0) {
        send('action', { text: `🦴 Skeleton generado (${skeletonParts.length} archivos) — Gemini identificando targets...` });
      }

      // Step 2: Gemini Flash-Lite (primary, large context) reads all skeletons
      // in one call and returns the files most likely to contain the answer.
      // Falls back to the full skeleton list if Gemini fails or returns garbage.
      let targetFilePaths: string[] = topFilePaths;
      if (skeletonParts.length > 0) {
        try {
          const filePickRaw = await generateWithFallbackDeep(
            `PREGUNTA DEL USUARIO: ${prompt}\n\nSKELETON DE ARCHIVOS DEL REPO:\n${skeletonParts.join('\n\n')}`,
            `Eres un experto en localización de código. Dado el skeleton de los archivos y la pregunta del usuario, identificá qué archivos contienen el código relevante.
Respondé ÚNICAMENTE con un JSON array de strings con los paths exactos (tal como aparecen en los skeletons, incluyendo directorios). Máximo 4 archivos.
Ejemplo de respuesta válida: ["src/services/trading.ts", "src/lib/signals.ts"]
Sin explicación, sin texto adicional — solo el JSON array.`,
          );
          const picked = JSON.parse(filePickRaw.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '')) as unknown;
          if (Array.isArray(picked) && picked.length > 0 && picked.every((p: unknown) => typeof p === 'string')) {
            targetFilePaths = (picked as string[]).filter(p => p.length > 0);
            send('action', { text: `🎯 Gemini → ${targetFilePaths.length} archivo(s): ${targetFilePaths.map(p => p.split('/').pop()).join(', ')}` });
          }
        } catch {
          // Gemini failed or returned non-JSON — fall back to full skeleton file list
          send('action', { text: '⚠️ Gemini file-pick falló — buscando en todos los archivos skeleton' });
        }
      }

      // Step 3: extract keywords and search. unifiedGrepSearch stops at the first
      // confirmed symbol_index hit (O(1)), then ripgrep, then GitHub API fallback.
      // Results are filtered to prefer Gemini-identified target files.
      const deepKeywords = await extractKeywordsForSearch(prompt, repo);
      const deepPattern = deepKeywords.length > 0
        ? deepKeywords.join('|')
        : prompt.split(/\s+/).filter(w => w.length > 4).slice(0, 4).join('|');

      send('action', { text: `🔍 DEEP — buscando: [${deepPattern}]` });

      // searchWithTestFallback: first pass → if all test → retry without test paths.
      // Returns matches sorted production-first; we then further rank by targetSet.
      const { matches: productionFirstMatches } =
        await searchWithTestFallback(deepPattern, repo, send);

      // DEEP priority: 1) Gemini target + production, 2) other production, 3) test/dev last.
      // searchWithTestFallback guarantees production comes before test; we add the
      // targetSet layer on top without re-running isTestMatch from scratch.
      const targetSet = new Set(targetFilePaths);
      const deepMatches = productionFirstMatches.length > 0
        ? [
            ...productionFirstMatches.filter(m => targetSet.has(m.path)  && !isTestMatch(m.path, m.text)),
            ...productionFirstMatches.filter(m => !targetSet.has(m.path) && !isTestMatch(m.path, m.text)),
            ...productionFirstMatches.filter(m => isTestMatch(m.path, m.text)),
          ]
        : [];

      if (deepMatches.length === 0) {
        send('action', { text: '❌ Sin resultados confirmados en symbol_index ni ripgrep. Reformulá con el nombre exacto de la función o variable.' });
        send('done', { files: [], commitMessage: '', mainComponent: '', mainContent: '', repo, branch });
        await new Promise(r => setTimeout(r, 100));
        res.end();
        return;
      }

      // Extract literal fragments — no AI, no interpretation
      const deepEvidence: { path: string; line: number; endLine: number; fragment: string }[] = [];
      for (const match of deepMatches.slice(0, 5)) {
        try {
          const fc = await getFileContent(match.path, repo);
          let section = match.line
            // BUG 4 fix: read full enclosing function, not a fixed ±20-line window.
            ? (readEnclosingFunction(fc, match.line) ?? smartReadSection(fc, match.line, 60))
            : (match.text ? smartReadSection(fc, match.text, 60) : null);
          if (!section) continue;

          // BUG 2 fix: validate the extracted fragment actually contains the
          // searched symbol literally. symbol_index can point to a stale line
          // number if the file changed since last indexing — if the symbol name
          // doesn't appear in the window we read, skip this match so we don't
          // falsely report it as HIGH-CONFIDENCE evidence of that symbol.
          const symbolTerms = deepKeywords.length > 0 ? deepKeywords : deepPattern.split('|').map(t => t.trim()).filter(Boolean);
          let symbolFound = symbolTerms.some(t => t.length > 2 && section!.excerpt.toLowerCase().includes(t.toLowerCase()));

          if (!symbolFound && match.line) {
            // readEnclosingFunction may have extracted a sibling function (backward-scan
            // bug). Fallback: simple ±50-line range read directly around the match line.
            // This mirrors what Haiku does natively and is proven to work in production.
            const rangeSection = smartReadSection(fc, match.line, 50);
            if (rangeSection) {
              const rangeLower = rangeSection.excerpt.toLowerCase();
              if (symbolTerms.some(t => t.length > 2 && rangeLower.includes(t.toLowerCase()))) {
                section = rangeSection;
                symbolFound = true;
                send('action', { text: `📖 Fallback lectura por rango — ${match.path}:${match.line}±50` });
              }
            }
          }

          if (!symbolFound) {
            send('action', { text: `⚠️ ${match.path}:${match.line} — fragmento no contiene el símbolo buscado [${symbolTerms.slice(0, 2).join(', ')}], descartado` });
            continue;
          }

          // Annotate the fragment with any recognized trading patterns (FVG, etc.)
          // before storing — the annotation flows through deepEvidenceSummary →
          // diagnosis → fastFindingContext so CHAT/Haiku reads it as resolved metadata.
          const { annotatedFragment, notes: patternNotes } = annotateTradingPatterns(
            section.excerpt, section.startLine, match.path,
          );
          for (const note of patternNotes) send('action', { text: `🔍 ${note}` });
          deepEvidence.push({ path: match.path, line: section.startLine, endLine: section.endLine, fragment: annotatedFragment });
          send('action', { text: `📌 ${match.path}:${section.startLine}-${section.endLine}` });
          const preview = section.excerpt.split('\n').slice(0, 20);
          for (const fl of preview) {
            send('action', { text: fl });
          }
        } catch { /* skip unfetchable files */ }
      }

      if (deepEvidence.length === 0) {
        send('action', { text: '⚠️ Match encontrado en índice pero no se pudo leer el fragmento del archivo.' });
      }

      // Persist raw evidence — diagnosis field holds the FULL function fragment so
      // CHAT/Haiku receives the complete body, not a truncated preview.
      const deepEvidenceSummary = deepEvidence
        .map(e => `${e.path}:${e.line}\n${e.fragment}`)
        .join('\n\n');

      // Assess whether evidence is from test/dev code — affects confidence label.
      const deepAllTest  = deepEvidence.length > 0 && deepEvidence.every(e => isTestMatch(e.path, e.fragment));
      const deepSomeTest = deepEvidence.some(e => isTestMatch(e.path, e.fragment));
      const deepConfidence: 'high' | 'medium' | 'low' =
        deepEvidence.length === 0 ? 'low' : deepAllTest ? 'medium' : 'high';
      if (deepAllTest) {
        send('action', { text: '⚠️ DEEP — solo se encontró código de test/dev. La función de producción puede tener un nombre diferente. Reformulá con el nombre exacto o revisá los archivos de producción directamente.' });
      } else if (deepSomeTest) {
        send('action', { text: '⚠️ DEEP — evidencia mixta: algunos fragmentos son de test/dev (rankeados al final). Los primeros resultados son de producción.' });
      }

      const deepFindingId = await saveInvestigationFinding({
        repo,
        files: deepEvidence.map(e => ({ path: e.path, lineRanges: [{ start: e.line, end: (e as any).endLine ?? e.line + 40, matchedTerm: deepPattern }] })),
        diagnosis: deepEvidenceSummary,
        evidence: deepEvidence,
        confidence: deepConfidence,
      }).catch(() => null);

      const deepConfidenceReason = deepAllTest
        ? 'DEEP mode — solo evidencia de test/dev. La implementación de producción puede tener un nombre diferente.'
        : deepSomeTest
          ? 'DEEP mode — evidencia mixta (producción + test). Los fragmentos de producción aparecen primero.'
          : 'DEEP mode — fragmentos literales con citas file:line exactas, sin interpretación';

      send('confidence', {
        level: deepConfidence,
        reason: deepConfidenceReason,
        suggestedAction: 'chat',
        files: deepEvidence.map(e => e.path),
        findingId: deepFindingId ?? undefined,
        diagnosis: deepEvidence.length > 0
          ? deepEvidenceSummary
          : 'DEEP mode no pudo confirmar evidencia literal para este símbolo. El índice puede estar desactualizado o el símbolo puede tener un nombre diferente en el código fuente.',
      });

      await saveContextSummary(repo, deepEvidenceSummary || 'DEEP read — sin evidencia', 'agent', deepEvidence.map(e => e.path))
        .catch(() => {});

      // Persist agent context so follow-up CHAT/DEEP turns can reuse file list
      await saveAgentContext({
        preloadedFiles: deepEvidence.map(e => ({ path: e.path, content: '' })),
        functionName: extractFunctionNameFromPrompt(prompt),
        prompt,
        repo,
        summary: deepEvidenceSummary.slice(0, 500),
      }).catch(() => {});
      cacheNotifications.emit('cache-update', { type: 'cache-update', repo, source: 'agent', timestamp: new Date().toISOString() });

      send('done', {
        files:         [],
        commitMessage: '',
        mainComponent: deepEvidence[0]?.path ?? '',
        mainContent:   '',
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
      // Validar que el caché es relevante para esta pregunta
      const currentSig = prompt.toLowerCase().split(/\s+/).filter((w: string) => w.length > 4).slice(0, 3).join('|');
      const cachedSig = savedCtx.querySignature ?? '';
      const sigMatch = cachedSig && currentSig && (
        cachedSig === currentSig ||
        currentSig.split('|').some((w: string) => cachedSig.includes(w))
      );
      // Caché expira después de 30 minutos
      const cacheAge = Date.now() - (savedCtx.savedAt ?? 0);
      const cacheValid = cacheAge < 30 * 60 * 1000;

      if (hasBackend && sigMatch && cacheValid) {
        preloadedFiles = savedCtx.preloadedFiles;
        send('action', { text: `⚡ Contexto reutilizado — ${preloadedFiles.length} archivo(s) ya cargados` });
        send('action', { text: `📋 Usando: ${preloadedFiles.map((f: { path: string }) => f.path.split('/').pop()).join(', ')}` });
      } else {
        const reason = !hasBackend ? 'solo tiene frontend'
          : !sigMatch ? 'pregunta cambió de tema'
          : 'caché expirado (>5min)';
        console.log(`[agent] Cache bypass: ${reason}`);
        send('action', { text: `🔎 Buscando contexto fresco (${reason})...` });
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

    // ── DEEP + FAST finding: inyectar archivos ya investigados ───────────────
    let findingDiagnosis: string | null = null;
    let findingConfidence: 'high' | 'medium' | 'low' | null = null;
    if (deepMode && findingId) {
      const finding = await loadInvestigationFinding(findingId).catch(() => null);
      if (finding) {
        findingDiagnosis = finding.diagnosis;
        findingConfidence = finding.confidence;
        const findingFilePaths = finding.files.map(f => f.path);
        send('action', { text: `📎 Hallazgo previo cargado (FAST→DEEP) — archivos priorizados: ${findingFilePaths.map(p => p.split('/').pop()).join(', ')}` });
        // Agregar archivos del finding que no estén ya en preloadedFiles
        const alreadyLoaded = new Set(preloadedFiles.map(f => f.path));
        const missingPaths = findingFilePaths.filter(p => !alreadyLoaded.has(p));
        if (missingPaths.length > 0) {
          const fetchResults = await Promise.allSettled(
            missingPaths.map(async p => ({ path: p, content: await getFileContent(p, repo) }))
          );
          const fetched = fetchResults
            .filter((r): r is PromiseFulfilledResult<{ path: string; content: string }> => r.status === 'fulfilled')
            .map(r => r.value);
          preloadedFiles = [...fetched, ...preloadedFiles];
        }
      }
    }

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
            'anthropic-beta': 'prompt-caching-2024-07-31',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1024,
            output_config: { effort: 'high' },
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

REGLA ANTI-ALUCINACIÓN: Si el contexto de archivos disponible NO contiene evidencia directa de la causa raíz que estás por proponer, decilo explícitamente en vez de inferir una causa plausible. No completes con conocimiento genérico de patrones de bugs si no está confirmado en el código real que tenés delante.

RESULTADO PARCIAL vs. DEFINITIVO: si tu análisis se basa en un archivo truncado o parcial (revisá si el contexto dice "líneas más omitidas" o similar), aclaralo en tu respuesta — no presentes una causa raíz como confirmada si no viste el archivo completo o las funciones relacionadas que podrían afectar el comportamiento.

ANCLAJE: cada afirmación sobre por qué falla el código debe citar la línea o condición literal del contexto que la sustenta. Si no podés citarla, no la incluyas en tu razonamiento.

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
      } catch (reasoningErr) {
        send('action', { text: `⚠️ Análisis de causa-raíz no completado — ${reasoningErr instanceof Error ? reasoningErr.message : 'error desconocido'}` })
        send('action', { text: `⚠️ El patch se generará sin el paso de razonamiento previo — revisá el resultado con más cuidado` })
      }
    } else {
      send('action', { text: `⚡ Modo análisis — leyendo contexto` })
    }

    // ── FAST MODE — Análisis puro, sin generación de código ──────────────────
    if (!deepMode) {
      send('action', { text: '🔍 Analizando...' });

      const fastSystemPrompt = `Eres QUARK Agent en modo ANÁLISIS.

ROL: Leer, diagnosticar, explicar. NUNCA modificar código.

RAZONAMIENTO PASO A PASO (OBLIGATORIO):
Antes de responder, razona visiblemente en este orden:
1. ¿Qué término/función exacto busco?
2. ¿En qué archivo/línea lo encontré?
3. ¿Qué hace exactamente ese código?
4. ¿Cómo responde a la pregunta del usuario?
Si no encontraste el término, dilo explícitamente y sugerí variantes a buscar.

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
- Si necesitas más contexto → pídelo explícitamente
- Si no encontrás algo → decilo claramente y sugerí próximos pasos concretos`;

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

    // Variables para el contexto quirúrgico (declaradas aquí para uso en toda la sección DEEP)
    const mainPreloaded = preloadedFiles[0];
    const blockStartLine = mainPreloaded?.startLine ?? 1;
    const blockEndLine = mainPreloaded?.endLine ?? 0;
    const mainFilePath = mainPreloaded?.path ?? '';

    // ── DETECCIÓN: ¿crear archivo nuevo o modificar existente? ──────────────
    const CREATE_KEYWORDS = /\[DEEP\]\[CREAR\]|\b(crea|crear|crea el archivo|nuevo archivo|create|new file|añade el archivo|agrega el archivo)\b/i;
    const isNewFile = CREATE_KEYWORDS.test(prompt);
    const newFilePath = prompt.match(/[\w/\-\.]+\.(ts|tsx|js|jsx|json|py|md|yml|yaml)/)?.[0] ?? null;
    const fileExistsInPreloaded = newFilePath
      ? preloadedFiles.some(f => f.path.includes(newFilePath.split('/').pop() ?? ''))
      : false;

    // ─── COMPLEJIDAD: Si NO es crear archivo nuevo, evaluar complejidad ─────
    if (!isNewFile || (isNewFile && fileExistsInPreloaded)) {
      send('action', { text: `🔎 Evaluando complejidad del cambio solicitado...` });

      const mainFileLineCount = mainPreloaded?.content?.split('\n').length ?? 0;
      const isLargeFile = mainFileLineCount > 500;
      const mentionsMultipleFunctions = (prompt.match(/función|function/gi) ?? []).length > 2;
      const architecturalChange = /\b(refactor|arquitectur|diseño|estructura|patrón|pattern)\b/i.test(prompt);
      // Señales de complejidad de diagnóstico: el prompt implica que hay que investigar
      // la causa raíz antes de poder editar con confianza — igual que classifyComplexity en CHAT.
      const isDiagnosticComplexity = /\b(por qu[eé]|porqu[eé]|causa ra[ií]z|no funciona|bug|error|falla|se rompe|arregla|corrige|resuelve|investiga|diagn[oó]stico)\b/i.test(prompt);

      const isComplexChange = isLargeFile || mentionsMultipleFunctions || architecturalChange || isDiagnosticComplexity;

      if (isComplexChange) {
        send('action', { text: `🔄 Exploración iterativa (loop agéntico) — Claude lee, edita y verifica en hasta 12 turnos` });
        // Adaptar el prompt agéntico según la confianza del hallazgo de FAST
        let agenticPrompt = prompt;
        if (findingDiagnosis) {
          if (findingConfidence === 'high') {
            // Alta confianza: diagnóstico completo, saltar exploración y aplicar fix directo
            agenticPrompt = `DIAGNÓSTICO YA COMPLETO (FAST mode, confianza ALTA — NO repitas exploración):
${findingDiagnosis}

TAREA: ${prompt}

El diagnóstico de arriba ya identifica la causa raíz y los archivos exactos. Lee esos archivos con read_file, aplica el fix mínimo con apply_patch, y llamá task_complete. No hagas grep_code ni busques más contexto salvo que el patch falle.`;
          } else {
            // Media/baja confianza: usar como punto de partida, DEEP decide si necesita más
            agenticPrompt = `INVESTIGACIÓN PREVIA (FAST mode, confianza ${findingConfidence?.toUpperCase()} — úsala como punto de partida, explorá más si hace falta):
${findingDiagnosis}

TAREA: ${prompt}

Estos archivos ya fueron identificados como relevantes — prioriza explorarlos antes que el repo completo.`;
          }
        }
        const agenticResult = await runAgenticLoop(
          agenticPrompt,
          repo,
          send,
          preloadedFiles.map(f => ({ path: f.path, content: f.fullContent ?? f.content })),
          reasoningContext,
        );

        if (agenticResult.files.length === 0) {
          send('action', { text: `⚠ El agente no logró resolver el cambio en el límite de turnos — revisión manual recomendada` });
          send('done', { files: [], commitMessage: '', mainComponent: '', mainContent: '', repo, branch });
          res.end();
          return;
        }

        const filesWithOriginal = await Promise.all(
          agenticResult.files.map(async (f) => {
            try {
              const originalContent = await getFileContent(f.path, repo);
              return { ...f, originalContent };
            } catch {
              return f;
            }
          })
        );

        send('done', {
          files: filesWithOriginal,
          commitMessage: agenticResult.commitMessage,
          mainComponent: agenticResult.files[0]?.path ?? '',
          mainContent: agenticResult.files[0]?.content ?? '',
          incomplete: agenticResult.incomplete,
          repo,
          branch,
        });
        await new Promise((r) => setTimeout(r, 100));
        res.end();
        return;
      }
    }

    // ── CREAR ARCHIVO NUEVO ──────────────────────────────────────────────────
    if (isNewFile && newFilePath && !fileExistsInPreloaded) {
      send('action', { text: `🆕 Modo creación — generando ${newFilePath}...` });

      const createSystemPrompt = `Eres QUARK Agent en modo CREACIÓN DE ARCHIVO NUEVO.
Genera el contenido completo del archivo solicitado.

CONTEXTO DEL REPO:
${fileContextStr || filePaths}

RAZONAMIENTO PREVIO:
${reasoningContext}

RESPONDE ÚNICAMENTE CON ESTE JSON (sin markdown, sin backticks, sin texto extra):
{
  "files": [
    {
      "path": "${newFilePath}",
      "content": "contenido completo del archivo"
    }
  ],
  "commitMessage": "feat: descripción del archivo creado"
}

REGLAS:
- El contenido debe ser TypeScript/JavaScript válido y production-ready
- Usa los imports correctos basándote en el contexto del repo
- El archivo debe integrarse con el stack existente (Node.js/Express/TypeScript)
- NO incluyas explicaciones, SOLO el JSON`;

      const raw = (await generateWithFallback(
        createSystemPrompt + '\n\nTAREA: ' + prompt,
        createSystemPrompt,
      )).trim();

      let newFiles: { path: string; content: string }[] = [];
      let commitMessage = `feat: crear ${newFilePath}`;

      try {
        const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
        const parsed = JSON.parse(cleaned) as { files: { path: string; content: string }[]; commitMessage: string };
        newFiles = parsed.files ?? [];
        commitMessage = parsed.commitMessage ?? commitMessage;
      } catch {
        send('action', { text: '⚠️ JSON malformado — intentando reparar...' });
        try {
          const repaired = await repairJSON(raw, prompt);
          newFiles = repaired.files ?? [];
          commitMessage = repaired.commitMessage ?? commitMessage;
        } catch {
          send('action', { text: '❌ No se pudo parsear el archivo generado' });
          send('done', { files: [], commitMessage: '', mainComponent: '', mainContent: '', repo, branch });
          res.end();
          return;
        }
      }

      if (newFiles.length === 0) {
        send('action', { text: '❌ El AI no generó contenido para el archivo' });
        send('done', { files: [], commitMessage: '', mainComponent: '', mainContent: '', repo, branch });
        res.end();
        return;
      }

      send('action', { text: `✅ ${newFilePath} generado — ${newFiles[0].content.split('\n').length} líneas` });
      send('file', { path: newFilePath });

      send('done', {
        files: newFiles,
        commitMessage,
        mainComponent: newFilePath,
        mainContent: newFiles[0].content,
        repo,
        branch,
      });

      await new Promise((r) => setTimeout(r, 100));
      res.end();
      return;
    }

    // Verificar que el archivo fue cargado correctamente para str_replace
    if (!mainPreloaded?.content || mainPreloaded.content.length < 100) {
      send('action', { text: `❌ Contexto insuficiente para patch — el archivo no fue cargado completo` });
      send('done', { files: [], commitMessage: '', mainComponent: '', mainContent: '', repo, branch });
      res.end();
      return;
    }
    send('action', { text: `📏 Contexto cargado — ${mainPreloaded.content.split('\n').length} líneas disponibles para patch` });

    // ─── ARCHIVO GRANDE DETECTION ───────────────────────────────────────────
    const mainFileLineCount = mainPreloaded?.content?.split('\n').length ?? 0;
    const isLargeFile = mainFileLineCount > 500;

    if (isLargeFile && !deepMode) {
      send('action', { text: `⚠️ ARCHIVO GRANDE DETECTADO (${mainFileLineCount} líneas)` });
      send('action', { text: `📋 Modo FAST recomendado para archivos >500 líneas` });
      send('action', { text: `💡 Alternativas: 1) Divide el cambio en archivos pequeños, 2) Usa FAST mode primero, 3) Manual en Replit si es crítico` });
      send('done', { files: [], commitMessage: '', mainComponent: '', mainContent: '', repo, branch });
      res.end();
      return;
    }

    send('action', { text: '⚡ Cambio directo (single-shot) — generando patch en una sola pasada' });
    send('action', { text: '🔬 Modo cirugía — preparando patch...' });

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

REGLA ANTI-ALUCINACIÓN: old_str y new_str deben basarse ÚNICAMENTE en el BLOQUE DEL ARCHIVO mostrado arriba. Si el cambio que te piden requiere información que no está en ese bloque (por ejemplo, otra función que podría estar relacionada pero no fue incluida en el contexto), respondé con operations: [] y explicá en el JSON qué información adicional necesitás — no inventes el contenido de una función que no viste.

RESULTADO PARCIAL: si el BLOQUE DEL ARCHIVO tiene comentarios de "líneas omitidas" (indicando que es una sección truncada, no el archivo completo), y tu cambio podría verse afectado por código fuera de esa sección, marcá esa incertidumbre en el campo commitMessage con un prefijo "[REVISAR: contexto parcial]" en vez de asumir que el bloque mostrado es todo lo relevante.

REGLAS CRÍTICAS PARA old_str:
- old_str debe ser texto copiado LITERALMENTE del bloque de arriba — sin cambiar ni un carácter
- old_str debe incluir MÍNIMO 3 líneas completas de contexto (antes y después del cambio)
- old_str debe ser ÚNICO en el archivo — si la línea se repite, incluye más contexto hasta que sea única
- old_str NUNCA puede terminar en mitad de una línea — siempre líneas completas
- NUNCA uses old_str de una sola línea — mínimo 3 líneas
- Si el cambio requiere agregar código nuevo, usa old_str con las 2 líneas ANTES del punto de inserción y new_str con esas mismas 2 líneas + el código nuevo
- NUNCA inventes old_str — cópialo byte a byte del bloque
- Máximo 2 operaciones por respuesta
- El JSON debe usar SOLO comillas dobles
- Si no puedes identificar un old_str único de mínimo 3 líneas, responde con operations: [] y explica por qué`;

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
    const allFailedOps: { path: string; old_str: string }[] = [];

    for (const op of operations) {
      if (finalFiles.find(f => f.path === op.path)) continue; // ya procesado

      const preloaded = preloadedFiles.find(f => f.path === op.path);
      const originalContent = preloaded?.fullContent ?? preloaded?.content ?? '';

      if (!originalContent) {
        send('action', { text: `⚠️ No se encontró contenido original para ${op.path}` });
        continue;
      }

      const opsForFile = operations.filter(o => o.path === op.path);
      let { content: patchedContent, failedOps } = applyOperations(originalContent, opsForFile, op.path, send);

      // Retry once per failed op using generateWithFallback
      if (failedOps.length > 0) {
        send('action', { text: `🔄 ${failedOps.length} operación(es) fallida(s) en ${op.path} — reintentando con corrección automática...` });

        for (const failed of failedOps) {
          const filePreview = originalContent.split('\n').slice(0, 150).join('\n');
          const repairPrompt = `Una operación str_replace falló porque el texto a reemplazar no existe literalmente en el archivo.

Archivo: ${op.path}
Primeras 150 líneas del archivo REAL:
\`\`\`
${filePreview}
\`\`\`

Texto que NO se encontró (old_str original):
\`\`\`
${failed.old_str}
\`\`\`

Texto de reemplazo deseado (new_str):
\`\`\`
${failed.new_str}
\`\`\`

Devuelve SOLO un JSON con la operación corregida buscando el fragmento equivalente en el archivo real:
{"type": "str_replace", "old_str": "...", "new_str": "..."}

El old_str DEBE existir literalmente en el archivo. Si no podés encontrar el fragmento correcto, devuelve {"type": "noop"}.
Devuelve SOLO el JSON, sin markdown ni explicaciones.`;

          try {
            const repairedRaw = await generateWithFallback(
              repairPrompt,
              'Eres un agente de corrección de patches. Devuelve SOLO el JSON solicitado.'
            );
            const repaired = JSON.parse(
              repairedRaw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim()
            ) as { type: string; old_str?: string; new_str?: string };

            if (repaired.type === 'str_replace' && repaired.old_str && repaired.new_str) {
              const idx = patchedContent.indexOf(repaired.old_str);
              if (idx !== -1) {
                patchedContent = patchedContent.slice(0, idx) + repaired.new_str + patchedContent.slice(idx + repaired.old_str.length);
                send('action', { text: `✅ Corrección automática aplicada en ${op.path}` });
              } else {
                send('action', { text: `❌ Corrección automática también falló en ${op.path} — operación omitida` });
                send('action', { text: `⚠️ El texto a reemplazar no fue encontrado en el archivo real. Puede que el archivo haya cambiado o el modelo no citó texto literal.` });
                allFailedOps.push({ path: op.path, old_str: failed.old_str });
              }
            } else {
              send('action', { text: `❌ Corrección automática también falló en ${op.path} — operación omitida` });
              send('action', { text: `⚠️ El texto a reemplazar no fue encontrado en el archivo real. Puede que el archivo haya cambiado o el modelo no citó texto literal.` });
              allFailedOps.push({ path: op.path, old_str: failed.old_str });
            }
          } catch {
            send('action', { text: `❌ No se pudo corregir automáticamente la operación en ${op.path} — operación omitida` });
            send('action', { text: `⚠️ El texto a reemplazar no fue encontrado en el archivo real. Puede que el archivo haya cambiado o el modelo no citó texto literal.` });
            allFailedOps.push({ path: op.path, old_str: failed.old_str });
          }
        }
      }

      finalFiles.push({ path: op.path, content: patchedContent });
    }

    // Reportar operaciones que fallaron definitivamente
    if (allFailedOps.length > 0) {
      send('action', { text: `⚠️ ${allFailedOps.length} operación(es) NO aplicada(s) — el diff muestra solo los cambios que SÍ se aplicaron:` });
      for (const f of allFailedOps) {
        send('action', { text: `  ✗ ${f.path}: "${f.old_str.slice(0, 60).replace(/\n/g, '↵')}${f.old_str.length > 60 ? '...' : ''}"` });
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
    send('action', { text: '🔍 Validando código generado con TypeScript compiler...' })

    try {
      const validation = await validateWithTsc(finalFiles, preloadedFiles, repo)

      if (!validation.valid && validation.errors.length > 0) {
        send('action', { text: `❌ TypeScript falló — ${validation.errors.length} error(es):` })
        for (const err of validation.errors) {
          const errMsg = err.length > 200 ? err.slice(0, 200) + '...' : err;
          send('action', { text: `  ${errMsg}` });
        }

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
          send('action', { text: `⚠️ No se pudo auto-corregir — errores pendientes: ${validation.errors.join(' | ')}` })
          send('action', { text: `⚠️ Revisión manual requerida — el diff está disponible para inspección` })
          if (isNewFile) {
            send('action', { text: `📋 Archivo nuevo — commit disponible a pesar de advertencias` })
            // No bloquear — continúa al send('done')
          } else {
            send('done', { files: [], commitMessage: '', mainComponent: '', mainContent: '', repo, branch })
            res.end()
            return
          }
        }
      } else {
        send('action', { text: '✅ Código validado — sin errores críticos' })
      }
    } catch (validationErr) {
      send('action', { text: `⚡ Validación omitida: ${validationErr instanceof Error ? validationErr.message : String(validationErr)}` })
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

    // ── PRE-COMMIT CHECKLIST ──────────────────────────────────────────────────
    // 1. Verificación de archivo: el archivo modificado debe coincidir con el mencionado en el prompt
    const promptLower = prompt.toLowerCase();
    for (const f of finalFiles) {
      const fname = f.path.split('/').pop()?.toLowerCase() ?? '';
      const fpath = f.path.toLowerCase();
      if (!promptLower.includes(fname) && !promptLower.includes(fpath)) {
        send('action', { text: `⚠️ El prompt no menciona "${f.path}" explícitamente — verifica que es el archivo correcto` });
      }
    }

    // 2. Verificación de referencias: tablas, endpoints y funciones mencionadas en el prompt
    const refCandidates: string[] = [
      // Palabras snake_case (nombres de tabla)
      ...Array.from(prompt.matchAll(/\b([a-z][a-z0-9]{2,}_[a-z][a-z0-9_]{2,})\b/g)).map(m => m[1]),
      // Endpoints /api/... o /v\d/...
      ...Array.from(prompt.matchAll(/\/(?:api|v\d)[a-zA-Z0-9/_\-?=&%.]+/g)).map(m => m[0]),
      // Funciones explícitas getX() / doX()
      ...Array.from(prompt.matchAll(/\b([a-zA-Z][a-zA-Z0-9]{3,})\(\)/g)).map(m => m[1]),
    ];
    const diffText = finalFiles.map(f => f.content).join('\n');
    for (const ref of refCandidates) {
      if (ref.length > 4 && !diffText.includes(ref)) {
        send('action', { text: `⚠️ El prompt pedía "${ref}" pero el diff no contiene esa referencia` });
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

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

function classifyEffort(message: string): 'medium' | 'high' | 'xhigh' {
  const PATCH_SIGNALS = /\b(corrige|corrección|arregla|arreglar|resuelve|resolver|refactor|implementa|implementar|agrega la función|crea la función|propose_patch)\b/i;
  const MULTI_FILE_SIGNALS = (message.match(/\.(ts|tsx|js|jsx)\b/g) ?? []).length > 1;
  const ARCHITECTURAL_SIGNALS = /\b(arquitectura|refactor completo|múltiples archivos|todo el flujo|cadena completa)\b/i;

  if (ARCHITECTURAL_SIGNALS.test(message) || MULTI_FILE_SIGNALS) return 'xhigh';
  if (PATCH_SIGNALS.test(message)) return 'high';
  return 'medium';
}

// Classifies whether the user wants an EXPLANATION (Haiku handles end-to-end)
// or CODE GENERATION/MODIFICATION (Haiku explores, Sonnet patches).
function classifyIntent(message: string): 'explain' | 'generate' {
  const GENERATE_SIGNALS = /\b(corrige|corrigí|arregla|arreglá|implementa|implementá|agrega|agregá|añade|añadí|crea|creá|refactor|escribe|escribí|modifica|modificá|cambia|cambiá|propone|proponé|propone un patch|haz el cambio|hacé el cambio|fix|patch|añadir|agregar|crear|modificar|cambiar|implementar|escribir|elimina|eliminá|borrá|borrar|remov|delet|insert|reemplaz|reemplazá|update|añadi)\b/i;
  return GENERATE_SIGNALS.test(message) ? 'generate' : 'explain';
}

function classifyComplexity(message: string): 'simple' | 'complex' {
  const COMPLEX_SIGNALS = [
    /\b(por qué|causa raíz|no funciona|bug|error|falla|se rompe|arregla|corrige|resuelve)\b/i,
    /\b(refactor|arquitectura|diseño|patrón)\b/i,
    /\b(revisa|audita|analiza en profundidad)\b/i,
  ];
  const MULTI_STEP_HINT = message.length > 200 || message.split(/[.?]/).length > 3;
  const mentionsMultipleFiles = (message.match(/\.(ts|tsx|js|jsx)\b/g) ?? []).length > 1;

  const isComplex = COMPLEX_SIGNALS.some(p => p.test(message)) || MULTI_STEP_HINT || mentionsMultipleFiles;
  return isComplex ? 'complex' : 'simple';
}

function buildTriagePrompt(cacheHint: string): string {
  return `Responde de forma breve y directa, usando SOLO tu conocimiento general — no tienes acceso a herramientas ni al código real del repo.
${cacheHint}
SOBRE EL CONTEXTO ADICIONAL: si aparece una sección "RESUMEN" o "CONTEXTO ADICIONAL" arriba, ese contenido proviene de una inspección real del código fuente de este mismo repo, hecha por este sistema hace menos de 30 minutos — no es una suposición ni una fuente externa incierta. Tratá esos datos como hechos verificados: usá los nombres exactos que aparecen ahí, no los parafrasees, y no agregues disclaimers como "probablemente", "podría ser" o "esto puede variar" sobre información que ya está confirmada.
IMPORTANTE: si la pregunta es sobre algo ESPECÍFICO de este proyecto (nombres de agentes/componentes propios, funciones particulares, arquitectura específica de este repo) y NO tenés ese dato exacto en el contexto de arriba, NO completes con conocimiento genérico de IA/programación — responde ÚNICAMENTE con "NEEDS_TOOLS: " seguido de una razón breve.
Si la pregunta es genuinamente genérica (conceptos estándar de programación, definiciones de libro) SÍ podés responder normal, sin ese prefijo.
RESULTADO PARCIAL vs. CONCLUSIÓN DEFINITIVA: si el contexto disponible solo cubre una fuente o un término, no presentes la ausencia de datos como una conclusión definitiva sobre el proyecto. Usá lenguaje parcial: "El contexto disponible no menciona esto — puede estar bajo otro nombre o en un módulo no revisado aún." Reservá afirmaciones definitivas ("esto no existe en el proyecto") solo cuando el contexto cubre múltiples fuentes relacionadas sin resultado.
REGLA DE ANCLAJE POR AFIRMACIÓN:
Cada afirmación específica sobre el comportamiento del código (qué activa algo, qué condición dispara qué, cómo se relacionan dos variables) debe ir acompañada del fragmento de código exacto del resumen o contexto que la sustenta — no solo el nombre del archivo.
Formato: la afirmación, seguida de la línea o condición literal entre backticks que la prueba.
Si no podés citar el fragmento exacto que sustenta una afirmación, no la incluyas — es señal de que estás infiriendo en vez de leyendo.
Si el código tiene dos funciones o ramas similares y opuestas (ej. una versión "Bull"/"alcista" y otra "Bear"/"bajista", o un "if" y su "else" equivalente), tratalas por separado — no mezcles las condiciones de ambas en un mismo párrafo. Indicá explícitamente qué condición pertenece a cuál.
SOBRE EVIDENCIA DEEP MODE: si el contexto contiene una sección "EVIDENCIA VERIFICADA (DEEP mode)", esas citas de archivo:línea son lecturas reales del código fuente — tratálas como hechos confirmados. No agregues frases como "probablemente", "podría ser" ni cuestiones la veracidad de lo citado. Usá esa evidencia directamente en tu respuesta sin rodearte de disclaimers.`;
}

router.post('/apply-patch', async (req, res) => {
  const { repo, path: filePath, old_str, new_str } = req.body as {
    repo?: string; path?: string; old_str?: string; new_str?: string;
  };
  if (!repo || !filePath || !old_str || !new_str) {
    res.status(400).json({ ok: false, error: 'repo, path, old_str y new_str son requeridos' });
    return;
  }

  try {
    const originalContent = await getFileContent(filePath, repo);
    const idx = originalContent.indexOf(old_str);
    if (idx === -1) {
      res.status(400).json({ ok: false, error: 'old_str no encontrado en el archivo — puede haber cambiado desde que se propuso el patch' });
      return;
    }
    if (originalContent.indexOf(old_str, idx + 1) !== -1) {
      res.status(400).json({ ok: false, error: 'old_str no es único en el archivo — no se puede aplicar de forma segura' });
      return;
    }
    const patchedContent = originalContent.slice(0, idx) + new_str + originalContent.slice(idx + old_str.length);

    await createOrUpdateFile(
      filePath,
      patchedContent,
      `fix: patch aplicado por QUARK Chat en ${filePath}`,
      repo,
    );

    res.json({ ok: true, path: filePath });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Shared tool executor ──────────────────────────────────────────────────────

// ── Session-level file cache — smartReadFile con decisión full/cached/diff/skeleton ───────────
interface SessionFileCacheEntry {
  contentHash: string;
  fullContent: string;
  lastReadAt: number;
  /** ETag returned by GitHub for this content version, used for conditional GETs. */
  etag: string | null;
}

const SESSION_FILE_CACHE = new Map<string, { files: Map<string, SessionFileCacheEntry>; ts: number }>();
const SESSION_CACHE_TTL_MS = 30 * 60 * 1000;

function getSessionFiles(sessionId: string): Map<string, SessionFileCacheEntry> {
  const now = Date.now();
  for (const [id, entry] of SESSION_FILE_CACHE) {
    if (now - entry.ts > SESSION_CACHE_TTL_MS) SESSION_FILE_CACHE.delete(id);
  }
  let entry = SESSION_FILE_CACHE.get(sessionId);
  if (!entry) { entry = { files: new Map(), ts: now }; SESSION_FILE_CACHE.set(sessionId, entry); }
  entry.ts = now;
  return entry.files;
}

// ── Security: paths that bypass smart cache and are always read in full ───────
const NO_CACHE_PATTERNS = [
  /\.env/i,
  /SECRET/i,
  /API_KEY/i,
  /[/\\]dist[/\\]/,
  /node_modules[/\\]/,
  /\.min\.js$/,
];
// Risk config patterns for sensitive repos (Ahorar = Signal OS, Trade-SnipeOS = Sniper OS)
const SENSITIVE_REPO_PATTERNS: Record<string, RegExp[]> = {
  'Ahorar':         [/[/\\]config[/\\]/i, /[/\\]secrets?[/\\]/i, /[/\\]keys?[/\\]/i, /[/\\]credentials?[/\\]/i],
  'Trade-SnipeOS':  [/[/\\]config[/\\]/i, /[/\\]secrets?[/\\]/i, /[/\\]keys?[/\\]/i, /[/\\]credentials?[/\\]/i],
};

function isNoCacheFile(filePath: string, repo: string): boolean {
  if (NO_CACHE_PATTERNS.some(p => p.test(filePath))) return true;
  return (SENSITIVE_REPO_PATTERNS[repo] ?? []).some(p => p.test(filePath));
}

function contentSha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// ── Structural skeleton generator (TypeScript Compiler API + Python regex) ────
function generateStructuralSkeleton(content: string, filePath: string): string {
  // Python: regex-based skeleton
  if (filePath.endsWith('.py')) {
    try {
      const lines = content.split('\n')
        .filter(l => /^(import |from .+ import |class |def |    def )/.test(l))
        .map(l => l.endsWith(':') ? l + ' ...' : l);
      return lines.length > 0 ? lines.join('\n') : content;
    } catch { return content; }
  }

  // TS/JS: TypeScript Compiler API
  try {
    const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX
      : filePath.endsWith('.jsx') ? ts.ScriptKind.JSX
      : filePath.endsWith('.ts')  ? ts.ScriptKind.TS
      : ts.ScriptKind.JS;

    const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind);
    const out: string[] = [];

    const g = (node: ts.Node) => node.getText(sf);
    const mods = (m: ts.NodeArray<ts.ModifierLike> | undefined) =>
      m?.length ? m.map(x => x.getText(sf)).join(' ') + ' ' : '';

    function visit(node: ts.Node): void {
      if (ts.isImportDeclaration(node)) { out.push(g(node)); return; }
      if (ts.isExportDeclaration(node)) { const t = g(node); if (t.length < 300) out.push(t); return; }
      if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) { out.push(g(node)); return; }

      if (ts.isFunctionDeclaration(node) && node.name) {
        const params = node.parameters.map(p => g(p)).join(', ');
        const ret = node.type ? `: ${g(node.type)}` : '';
        out.push(`${mods(node.modifiers)}function ${g(node.name)}(${params})${ret} { ... }`);
        return;
      }

      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          const init = decl.initializer;
          if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
            const fn = init as ts.ArrowFunction | ts.FunctionExpression;
            const params = fn.parameters.map(p => g(p)).join(', ');
            const ret = fn.type ? `: ${g(fn.type)}` : '';
            const asyncKw = fn.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : '';
            out.push(`${mods(node.modifiers)}const ${g(decl.name)} = ${asyncKw}(${params})${ret} => { ... }`);
          } else {
            const t = g(node); if (t.length < 200) out.push(t);
          }
        }
        return;
      }

      if (ts.isClassDeclaration(node) && node.name) {
        const heritage = node.heritageClauses?.map(h => g(h)).join(' ') ?? '';
        out.push(`${mods(node.modifiers)}class ${g(node.name)}${heritage ? ' ' + heritage : ''} {`);
        for (const m of node.members) {
          if (ts.isConstructorDeclaration(m) || ts.isMethodDeclaration(m)) {
            const mn = ts.isConstructorDeclaration(m) ? 'constructor' : g((m as ts.MethodDeclaration).name!);
            const params = m.parameters.map(p => g(p)).join(', ');
            const ret = (m as ts.MethodDeclaration).type ? `: ${g((m as ts.MethodDeclaration).type!)}` : '';
            out.push(`  ${mods(m.modifiers)}${mn}(${params})${ret} { ... }`);
          } else if (ts.isPropertyDeclaration(m)) {
            const pt = m.type ? `: ${g(m.type)}` : '';
            out.push(`  ${mods(m.modifiers)}${g(m.name)}${pt};`);
          }
        }
        out.push('}'); return;
      }
    }

    ts.forEachChild(sf, visit);
    return out.length > 0 ? out.join('\n') : content;
  } catch (err) {
    console.warn('[smartReadFile] skeleton parse failed, using full content:', err instanceof Error ? err.message : err);
    return content;
  }
}

// ── Smart read file: full / cached / diff / skeleton ─────────────────────────
const SMART_DIFF_CHAR_LIMIT  = 1500;
const SMART_DIFF_LINE_LIMIT  = 100;
const SMART_LARGE_BYTES      = 50 * 1024;
const SMART_LARGE_LINES      = 2000;
const SKELETON_EXT           = /\.(ts|tsx|js|jsx|py)$/;

type SmartReadDecision = 'full' | 'cached' | 'diff' | 'skeleton';

/** Fire-and-forget PostgreSQL insert for measuring token and quota savings. */
function logSmartRead(opts: {
  sessionId: string;
  repo: string;
  path: string;
  decision: SmartReadDecision;
  httpStatus: 200 | 304;
  tokensBefore: number;
  tokensAfter: number;
}): void {
  pool.query(
    `INSERT INTO smart_read_log
       (session_id, repo, path, decision, http_status, tokens_before, tokens_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [opts.sessionId, opts.repo, opts.path, opts.decision,
     opts.httpStatus, opts.tokensBefore, opts.tokensAfter],
  ).catch(err =>
    console.warn('[smartReadFile] log insert failed:', err instanceof Error ? err.message : err),
  );
}

async function smartReadFile(
  filePath: string,
  repo: string,
  sessionId: string,
  send: (event: string, data: Record<string, unknown>) => void,
): Promise<{ result: string; decision: SmartReadDecision }> {
  // ── Security exclusion — always full read, no ETag, no cache ───────────────
  if (isNoCacheFile(filePath, repo)) {
    send('action', { text: `📖 Leyendo ${filePath}` });
    // No If-None-Match → always 200, result never null
    const fetched = await getFileContentConditional(filePath, repo);
    const content = fetched!.content;
    const est = Math.ceil(content.length / 4);
    logSmartRead({ sessionId, repo, path: filePath, decision: 'full', httpStatus: 200, tokensBefore: est, tokensAfter: est });
    return { result: content, decision: 'full' };
  }

  const sessionFiles = getSessionFiles(sessionId);
  const cacheKey = `${filePath}@${repo}`;
  const cached = sessionFiles.get(cacheKey);

  // ── Conditional GET — sends If-None-Match when we have a stored ETag ───────
  const fetched = await getFileContentConditional(filePath, repo, undefined, cached?.etag ?? undefined);

  // ── 304 Not Modified — GitHub confirmed the content hasn't changed ─────────
  if (fetched === null) {
    // cached is guaranteed to exist: we only send If-None-Match when cached != null
    send('action', { text: `📖 Leyendo ${filePath} (sin cambios)` });
    const est = Math.ceil(cached!.fullContent.length / 4);
    logSmartRead({ sessionId, repo, path: filePath, decision: 'cached', httpStatus: 304, tokensBefore: est, tokensAfter: est });
    return { result: cached!.fullContent, decision: 'cached' };
  }

  // ── 200 — new content received ─────────────────────────────────────────────
  const { content: currentContent, etag: currentEtag } = fetched;
  const currentHash = contentSha256(currentContent);

  // First read in this session
  if (!cached) {
    sessionFiles.set(cacheKey, { contentHash: currentHash, fullContent: currentContent, lastReadAt: Date.now(), etag: currentEtag });
    send('action', { text: `📖 Leyendo ${filePath}` });
    const est = Math.ceil(currentContent.length / 4);
    logSmartRead({ sessionId, repo, path: filePath, decision: 'full', httpStatus: 200, tokensBefore: est, tokensAfter: est });
    return { result: currentContent, decision: 'full' };
  }

  // Hash fallback: server returned 200 but hash is the same (ETag absent or not honoured)
  if (cached.contentHash === currentHash) {
    sessionFiles.set(cacheKey, { ...cached, etag: currentEtag ?? cached.etag, lastReadAt: Date.now() });
    send('action', { text: `📖 Leyendo ${filePath} (sin cambios)` });
    const est = Math.ceil(cached.fullContent.length / 4);
    logSmartRead({ sessionId, repo, path: filePath, decision: 'cached', httpStatus: 200, tokensBefore: est, tokensAfter: est });
    return { result: cached.fullContent, decision: 'cached' };
  }

  // Content changed — decide diff / skeleton / full
  const diffText = createPatch(filePath, cached.fullContent, currentContent, '', '');
  const diffLines = diffText.split('\n').length;
  const isSmallDiff = diffText.length < SMART_DIFF_CHAR_LIMIT && diffLines < SMART_DIFF_LINE_LIMIT;
  const isLarge = currentContent.length > SMART_LARGE_BYTES
    || currentContent.split('\n').length > SMART_LARGE_LINES;

  // Update cache regardless of which branch we take below
  sessionFiles.set(cacheKey, { contentHash: currentHash, fullContent: currentContent, lastReadAt: Date.now(), etag: currentEtag });

  const estFull = Math.ceil(currentContent.length / 4);

  if (isSmallDiff) {
    const estDiff = Math.ceil(diffText.length / 4);
    logSmartRead({ sessionId, repo, path: filePath, decision: 'diff', httpStatus: 200, tokensBefore: estFull, tokensAfter: estDiff });
    send('action', { text: `📖 Leyendo ${filePath} (diff desde última lectura)` });
    return { result: `[Archivo modificado desde tu última lectura. Diff:]\n${diffText}`, decision: 'diff' };
  }

  if (isLarge && SKELETON_EXT.test(filePath)) {
    const skeleton = generateStructuralSkeleton(currentContent, filePath);
    const estSkeleton = Math.ceil(skeleton.length / 4);
    logSmartRead({ sessionId, repo, path: filePath, decision: 'skeleton', httpStatus: 200, tokensBefore: estFull, tokensAfter: estSkeleton });
    send('action', { text: `📖 Leyendo ${filePath} (esqueleto estructural — archivo grande modificado)` });
    return {
      result: `[Archivo grande modificado. Esqueleto estructural — pedí lectura completa si necesitás implementación]\n${skeleton}`,
      decision: 'skeleton',
    };
  }

  // Fallback: full content
  logSmartRead({ sessionId, repo, path: filePath, decision: 'full', httpStatus: 200, tokensBefore: estFull, tokensAfter: estFull });
  send('action', { text: `📖 Leyendo ${filePath}` });
  return { result: currentContent, decision: 'full' };
}

/**
 * Convierte un término de búsqueda en un patrón regex para ripgrep.
 *
 * Con -i (case-insensitive):
 *   "fair value gap"  → \bfair[\s_-]*value[\s_-]*gap\b
 *   "trailing_stop"   → \btrailing[\s_-]*stop\b
 *   "trailingStop"    → \b(?:trailingStop|trailing_stop|TRAILINGSTOP)\b
 *   "checkS6Bull"     → \b(?:checkS6Bull|check_s6bull|CHECKS6BULL|checkS\d+Bull)\b
 *   "FVG"             → \b(?:FVG|fvg)\b
 */
function buildRipgrepPattern(term: string): string {
  const trimmed = term.trim();
  if (!trimmed) return trimmed;

  // Escapa chars especiales de regex (deja dígitos sin tocar, los reemplazamos luego)
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // ── Frase en lenguaje natural (con espacios) ─────────────────────────────
  // "fair value gap" → \bfair[\s_-]*value[\s_-]*gap\b  (matchea fairValueGap, fair_value_gap, etc.)
  if (/\s/.test(trimmed)) {
    const words = trimmed.split(/\s+/).filter(Boolean).map(esc);
    return `\\b${words.join('[\\s_-]*')}\\b`;
  }

  // ── Separadores explícitos (guion / guion_bajo) ───────────────────────────
  // "trailing-stop" → \btrailing[\s_-]*stop\b
  if (/[-_]/.test(trimmed)) {
    const parts = trimmed.split(/[-_]/).filter(Boolean).map(esc);
    return `\\b${parts.join('[\\s_-]*')}\\b`;
  }

  // ── Término sin espacios ni separadores ──────────────────────────────────
  const alternatives: string[] = [esc(trimmed)];

  // camelCase / PascalCase → añadir snake_case y UPPER_CASE
  // "trailingStop" → trailingStop|trailing_stop|TRAILINGSTOP
  if (/[a-z][A-Z]/.test(trimmed)) {
    const snake = trimmed.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
    alternatives.push(esc(snake));
    alternatives.push(esc(trimmed.toUpperCase()));
  }

  // Dígito embebido en camelCase: checkS6Bull, S6Bull, ATR14, etc.
  // → variante con dígito wildcard: checkS\d+Bull  (matchea checkS1Bull…checkS9Bull)
  if (/[A-Za-z]\d+[A-Za-z]/.test(trimmed)) {
    const digitWild = esc(trimmed).replace(/\d+/g, '\\d+');
    if (digitWild !== esc(trimmed)) alternatives.push(digitWild);
  }

  // Acrónimo en MAYÚSCULAS puro (FVG, ATR, RSI)
  // Con -i ya matchea fvg/Fvg; añadir lowercase por si el código usa minúsculas
  if (/^[A-Z]{2,}$/.test(trimmed)) {
    alternatives.push(esc(trimmed.toLowerCase()));
  }

  const deduped = [...new Set(alternatives)];
  if (deduped.length === 1) return `\\b${deduped[0]}\\b`;
  return `\\b(?:${deduped.join('|')})\\b`;
}

function cleanForGitHubSearch(pattern: string): string {
  return pattern.replace(/[="(){}[\]<>]/g, ' ').replace(/\s+/g, ' ').trim();
}

function generateSearchVariants(term: string): string[] {
  const variants = new Set<string>([term]);

  // ── camelCase / PascalCase → snake_case ──────────────────────────────────
  const toSnakeFromCamel = term.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  if (toSnakeFromCamel !== term) variants.add(toSnakeFromCamel);
  const underscored = term.replace(/-/g, '_');
  if (underscored !== term) variants.add(underscored);
  const strippedSeparators = term.replace(/[-_]/g, '');
  if (strippedSeparators !== term && strippedSeparators.length > 3) variants.add(strippedSeparators);

  // ── Acrónimo ALL_CAPS (FVG, ATR, RSI) → añadir versión en minúsculas ────
  // GitHub Code Search es case-sensitive por defecto; fvg puede aparecer como variable
  if (/^[A-Z]{2,}(\d*)$/.test(term)) {
    variants.add(term.toLowerCase());
  }

  // ── Término con dígito embebido (checkS6Bull) → añadir prefijo sin dígito ─
  // GitHub no soporta regex; buscar el prefijo hasta el primer dígito como fallback
  if (/[A-Za-z]\d+[A-Z]/.test(term)) {
    const prefixOnly = term.split(/\d/)[0];  // "checkS" de "checkS6Bull"
    if (prefixOnly.length >= 4) variants.add(prefixOnly);
  }

  // ── Frase en lenguaje natural → todas las variantes de código ────────────
  if (/\s/.test(term)) {
    const words = term.trim().split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
      const camelCase = words[0].toLowerCase() +
        words.slice(1).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
      variants.add(camelCase);

      const snakeCase = words.map(w => w.toLowerCase()).join('_');
      variants.add(snakeCase);

      const constantCase = words.map(w => w.toUpperCase()).join('_');
      variants.add(constantCase);

      const pascalCase = words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
      variants.add(pascalCase);

      const noSpaces = words.join('').toLowerCase();
      if (noSpaces.length > 3) variants.add(noSpaces);

      // Acrónimo de las iniciales ("fair value gap" → FVG)
      const acronym = words.map(w => w[0].toUpperCase()).join('');
      if (acronym.length >= 2) variants.add(acronym);
    }
  }

  // Cap a 3 variantes por término — el fallback a GitHub tiene rate limit de 10 req/min.
  // Con ripgrep local como ruta primaria este fallback debe ser raro, pero cuando se activa
  // no debe quemar el límite completo en una sola búsqueda.
  const MAX_VARIANTS = 3;
  return [...variants].filter(Boolean).slice(0, MAX_VARIANTS);
}

/**
 * Extrae un fragmento de código con contexto alrededor de un anchor.
 *
 * @param content    Contenido completo del archivo (string)
 * @param anchor     Número de línea 1-based, o texto para buscar en el contenido
 * @param contextLines Líneas de contexto antes/después del anchor (default: 25)
 * @returns  { excerpt, startLine, endLine }  o null si no se encontró el anchor
 *
 * Permite dar al agente solo la sección relevante al match de búsqueda,
 * sin necesitar cargar el archivo completo en el prompt.
 */
function smartReadSection(
  content: string,
  anchor: number | string,
  contextLines = 25,
): { excerpt: string; startLine: number; endLine: number } | null {
  const lines = content.split('\n');
  let center: number; // 0-indexed

  if (typeof anchor === 'number') {
    center = Math.max(0, anchor - 1);
  } else {
    // Buscar primera línea que contenga el texto del anchor (case-insensitive)
    const needle = anchor.trim().toLowerCase();
    const idx = lines.findIndex(l => l.toLowerCase().includes(needle));
    if (idx === -1) return null;
    center = idx;
  }

  const start = Math.max(0, center - contextLines);
  const end   = Math.min(lines.length - 1, center + contextLines);

  const excerpt = lines
    .slice(start, end + 1)
    .map((l, i) => `${start + i + 1}: ${l}`)
    .join('\n');

  return { excerpt, startLine: start + 1, endLine: end + 1 };
}

/**
 * BUG 4 fix — lee la función completa que contiene la línea ancla, siguiendo
 * el balance de llaves. Evita cortes en el medio de un bloque de condiciones.
 * Cap de seguridad: 300 líneas por función.
 * Si el balance no cierra dentro del cap, retorna null → el llamador cae a
 * smartReadSection con un ventana más amplia (±60 líneas).
 */
function readEnclosingFunction(
  content: string,
  anchorLine: number, // 1-indexed
): { excerpt: string; startLine: number; endLine: number } | null {
  const lines = content.split('\n');
  const anchor = Math.max(0, anchorLine - 1); // convertir a 0-indexed

  // Cuenta llaves netas en una línea (ignorando strings de forma aproximada)
  function netBraces(line: string): number {
    let n = 0, inStr = false, strChar = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inStr) {
        if (c === strChar && line[i - 1] !== '\\') inStr = false;
      } else if (c === '"' || c === "'" || c === '`') {
        inStr = true; strChar = c;
      } else if (c === '{') n++;
      else if (c === '}') n--;
    }
    return n;
  }

  // Si la línea anchor ES la declaración de la función buscada (el symbol_index
  // apunta a la definición, no a un call site), saltar el backward scan.
  // El backward scan desde una línea de declaración cae inexorablemente dentro de
  // la función hermana anterior, extrayendo su cuerpo en vez del símbolo buscado.
  const anchorLineText = lines[anchor] ?? '';
  const anchorIsDeclaration =
    /\bfunction\s+\w/.test(anchorLineText) ||                          // function foo(
    /\basync\s+function\s+\w/.test(anchorLineText) ||                  // async function foo(
    (/\b(const|let|var|export)\b/.test(anchorLineText) &&              // const foo = (...)  => {
      /=\s*(async\s*)?\(/.test(anchorLineText) &&
      /[)]\s*(:\s*\w[\w<>, |]*\s*)?(=>|\{)/.test(anchorLineText));

  // Escanear hacia atrás desde anchor para encontrar el { de apertura del bloque
  // que nos contiene, y luego la declaración de función asociada.
  // Sólo lo hacemos cuando el anchor es un call site / línea interior, no una declaración.
  let depth = 0;
  let funcStart = anchor;
  if (!anchorIsDeclaration) {
    for (let i = anchor; i >= 0; i--) {
      depth -= netBraces(lines[i]); // yendo hacia atrás: { suma depth
      if (depth > 0) {
        // Estamos dentro de un bloque que abre en línea i o antes.
        // Buscar hasta 5 líneas más atrás la declaración de función.
        funcStart = i;
        for (let j = Math.max(0, i - 4); j <= i; j++) {
          if (/\b(function|const|let|var|async)\b|\)\s*[\{:]/.test(lines[j])) {
            funcStart = j;
          }
        }
        break;
      }
    }
  }

  // Escanear hacia adelante desde funcStart para encontrar el } de cierre.
  // IMPORTANTE: sólo aceptar el cierre si ya pasamos la línea ancla.
  // Si cerramos una función ANTES del ancla (e.g. checkS5EarlyBull cuando
  // buscamos checkS6Bull), eso es una función hermana anterior — reseteamos
  // y seguimos adelante hasta encontrar el bloque que realmente contiene el ancla.
  depth = 0;
  let started = false;
  let funcEnd = Math.min(lines.length - 1, funcStart + 299);
  for (let i = funcStart; i < lines.length && i <= funcStart + 299; i++) {
    const n = netBraces(lines[i]);
    depth += n;
    if (n > 0) started = true;
    if (started && depth === 0) {
      if (i >= anchor) {
        // Hemos cerrado un bloque que cubre o supera la línea ancla → es el correcto.
        funcEnd = i;
        break;
      }
      // Cerramos un bloque que termina ANTES del ancla → era una función anterior,
      // no la que buscamos. Seguir escaneando.
      started = false;
      depth = 0;
    }
  }

  // Si no encontramos cierre o la función es demasiado grande, retornar null
  if (!started) return null;

  const excerpt = lines
    .slice(funcStart, funcEnd + 1)
    .map((l, idx) => `${funcStart + idx + 1}: ${l}`)
    .join('\n');

  return { excerpt, startLine: funcStart + 1, endLine: funcEnd + 1 };
}

interface GrepMatch {
  path: string;
  line?: number;
  lineApprox?: boolean;
  text?: string;
  symbolType?: string;
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[\s_-]/g, '');
}

/**
 * Busca símbolos reales del repo cuyo nombre normalizado contenga el término
 * candidato normalizado. Reemplaza la necesidad de una lista de stopwords:
 * un término que no matchea nada real (ej. "funciona") simplemente no
 * devuelve candidatos, sin mantenimiento manual.
 *
 * Ordena por longitud ascendente — el símbolo más corto/específico que
 * contiene el término suele ser el match más relevante.
 */
function findRealSymbolMatches(term: string, symbolNames: string[], maxResults = 3): string[] {
  const normTerm = normalizeForMatch(term);
  if (normTerm.length < 3) return []; // términos muy cortos son ambiguos, no forzar match

  return symbolNames
    .filter(sym => normalizeForMatch(sym).includes(normTerm))
    .sort((a, b) => a.length - b.length)
    .slice(0, maxResults);
}

// ── Test / dev-only code detector ────────────────────────────────────────────
// Heuristically identifies whether a search match points to test or dev code
// rather than production logic. Used to DEPRIORITIZE (not exclude) such results
// so production implementations surface first in both FAST and DEEP.
function isTestMatch(filePath: string, matchText?: string): boolean {
  // 1. Test file by path convention (.test.ts, .spec.ts, /tests/, /__tests__/, etc.)
  if (/\.(test|spec)\.[jt]sx?$/.test(filePath)) return true;
  if (/[/](tests?|__tests__|mocks?|fixtures?)[/]/i.test(filePath)) return true;

  if (matchText) {
    // 2. Symbol/function name declared with test/mock/debug prefix (camelCase)
    //    Catches: function testFoo, const testFoo, async function mockBar — NOT placeTrailingStop
    if (/\b(?:function\s+|(?:const|let|var)\s+)(?:async\s+)?(?:function\s+)?(test|mock|debug|stub|fake|dummy)[A-Za-z]/i.test(matchText)) return true;
    // 3. Call/assignment form: testFoo( or testFoo = (camelCase after test prefix)
    if (/\btest[A-Z]\w*\s*[=(]/i.test(matchText)) return true;
    // 4. Dev/test-only indicators in comments or route strings
    if (/\/api\/dev\/|X-Dev-Secret|never writes to|for (?:test|dev)(?:ing)? only/i.test(matchText)) return true;
  }

  return false;
}

// ── Shared test-aware search with automatic production retry ─────────────────
// Both FAST and DEEP call this instead of duplicating the detect-and-retry
// pattern. Workflow:
//   1. First search via unifiedGrepSearch (index + ripgrep)
//   2. Partition results into production vs test/dev
//   3. If ALL first-pass results are test → retry with ripgrep glob exclusions
//   4. Return sorted matches (production first) + allTest / someTest flags
//
// The caller decides which warning message to emit based on the flags;
// this function only emits the intermediate retry status action.
async function searchWithTestFallback(
  pattern: string,
  repo: string,
  send: (event: string, data: Record<string, unknown>) => void,
): Promise<{ matches: GrepMatch[]; allTest: boolean; someTest: boolean }> {
  const first = await unifiedGrepSearch(pattern, repo, send);
  if (first.length === 0) return { matches: [], allTest: false, someTest: false };

  const production = first.filter(m => !isTestMatch(m.path, m.text));
  const test       = first.filter(m =>  isTestMatch(m.path, m.text));

  if (production.length > 0) {
    // Normal case: at least some production results — return them sorted.
    return { matches: [...production, ...test], allTest: false, someTest: test.length > 0 };
  }

  // All first-pass results are test/dev — retry with ripgrep glob exclusions
  // so test directories are skipped at the OS level (faster, avoids cap issues).
  send('action', { text: '🔄 Solo resultados de test — reintentando con exclusión de rutas de test...' });
  const retry     = await unifiedGrepSearch(pattern, repo, send, { excludeTestPaths: true });
  const retryProd = retry.filter(m => !isTestMatch(m.path, m.text));

  if (retryProd.length > 0) {
    send('action', { text: `✅ Reintento: ${retryProd.length} resultado(s) de producción encontrado(s).` });
    return { matches: retryProd, allTest: false, someTest: false };
  }

  // Retry also found nothing in production — proceed with test results but
  // set allTest so the caller can warn and cap confidence accordingly.
  return { matches: test, allTest: true, someTest: true };
}

// ── Trading pattern detector for DEEP mode ───────────────────────────────────
// Identifies known trading patterns in extracted code fragments by their
// LOGICAL STRUCTURE — not by variable names. Works across any repo
// (Signal OS, Nexus OS, etc.) regardless of how variables are named.
//
// To add a new pattern: push a new entry to TRADING_PATTERNS below.
// Each entry implements detect(lines, fragmentStartLine) and returns
// { matchedLines, detail } if found, or null if not.

interface TradingPatternResult {
  matchedLines: number[];  // 1-based absolute line numbers within the source file
  detail: string;          // human-readable annotation for the evidence note
}

interface TradingPattern {
  name: string;        // e.g. 'FVG', 'EMA_CROSS'
  description: string; // e.g. 'Fair Value Gap'
  detect: (lines: string[], fragmentStartLine: number) => TradingPatternResult | null;
}

const TRADING_PATTERNS: TradingPattern[] = [
  {
    name: 'FVG',
    description: 'Fair Value Gap',
    detect(lines: string[], fragmentStartLine: number): TradingPatternResult | null {
      // FVG structural signature: a comparison between an array value at the
      // *current* bar index and an array value N bars *back* (offset index).
      // This is the universal FVG implementation regardless of naming.
      //
      // Canonical form (checkS6Bull in Signal OS): lows[i] > highs[i-2]
      //   • arr[loopVar]        — current bar's value
      //   • arr2[loopVar - N]   — value N bars ago (N >= 1)
      //   • comparison operator between them
      //
      // The backreference on the loop variable (group 2) prevents matching
      // unrelated index comparisons like arr[i] > arr2[j-1].
      //
      // Fallback: explicit fvg-named variable (fvgBull, fvgBear, etc.)
      // which is also structural — it means the repo already computed the gap.

      // word[i] OP word[i-N]
      const OFFSET_CMP_FORWARD = /\b\w+\s*\[\s*(\w+)\s*\]\s*[><=!]{1,3}\s*\w+\s*\[\s*\1\s*-\s*\d+\s*\]/;
      // word[i-N] OP word[i]
      const OFFSET_CMP_REVERSE = /\b\w+\s*\[\s*(\w+)\s*-\s*\d+\s*\]\s*[><=!]{1,3}\s*\w+\s*\[\s*\1\s*\]/;
      // Explicit fvg variable (named structural result)
      const FVG_NAMED_VAR = /\bfvg(?:Bull|Bear|bull|bear|Up|Down|Long|Short|[A-Z])/;

      const matchedLines: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (OFFSET_CMP_FORWARD.test(line) || OFFSET_CMP_REVERSE.test(line) || FVG_NAMED_VAR.test(line)) {
          matchedLines.push(fragmentStartLine + i);
        }
      }

      if (matchedLines.length === 0) return null;

      const first = matchedLines[0];
      const last = matchedLines[matchedLines.length - 1];
      const lineRef = first === last ? `línea ${first}` : `líneas ${first}-${last}`;
      return {
        matchedLines,
        detail: `${lineRef} implementan el patrón FVG (comparación de low/close actual contra high de N velas atrás).`,
      };
    },
  },
  // ── Future patterns — add here without touching the rest of the pipeline ──
  // { name: 'EMA_CROSS', description: 'EMA crossover', detect: ... },
  // { name: 'RSI_CONDITION', description: 'RSI overbought/oversold', detect: ... },
];

/**
 * Analyzes a raw code fragment extracted by DEEP mode and appends an
 * annotation block for any recognized trading pattern.
 *
 * The annotation becomes part of the fragment stored in deepEvidence →
 * deepEvidenceSummary → diagnosis → fastFindingContext sent to CHAT/Haiku,
 * so Haiku receives pre-resolved pattern metadata and does NOT need its own
 * structural recognition logic.
 *
 * @param fragment   Raw code text extracted from the source file
 * @param startLine  1-based line number where the fragment begins in the file
 * @param filePath   Source file path (used in display text only)
 */
function annotateTradingPatterns(
  fragment: string,
  startLine: number,
  filePath: string,
): { annotatedFragment: string; notes: string[] } {
  const lines = fragment.split('\n');
  const notes: string[] = [];
  const fileName = filePath.split('/').pop() ?? filePath;

  for (const pattern of TRADING_PATTERNS) {
    const result = pattern.detect(lines, startLine);
    if (result) {
      notes.push(
        `[QUARK PATTERN] ${pattern.name} (${pattern.description}) detectado en ${fileName}: ${result.detail}`,
      );
    }
  }

  if (notes.length === 0) return { annotatedFragment: fragment, notes: [] };

  const annotationBlock =
    '\n\n// ── Patrones de trading detectados por DEEP (estructura lógica, no nombres de variable) ──\n'
    + notes.map(n => `// Nota: ${n}`).join('\n');

  return { annotatedFragment: fragment + annotationBlock, notes };
}

async function unifiedGrepSearch(
  pattern: string,
  repo: string,
  send: (event: string, data: Record<string, unknown>) => void,
  options?: { excludeTestPaths?: boolean },
): Promise<GrepMatch[]> {
  const rawTerms = pattern.split('|').map((t: string) => t.trim()).filter(Boolean);
  console.log(`[unifiedGrepSearch] patrón: "${pattern}" → ${rawTerms.length} término(s): [${rawTerms.join(', ')}]${options?.excludeTestPaths ? ' [excl. test]' : ''}`);
  send('action', { text: `🧠 Paso 1 — buscando en índice de símbolos: [${rawTerms.join(', ')}]` });

  // ── 1. Symbol index — exact identifier lookup, O(1) ──────────────────────
  const symbolMatches: { term: string; sym: SymbolMatch }[] = [];
  for (const term of rawTerms) {
    if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(term)) {
      const sym = await lookupSymbol(term, repo);
      if (sym) symbolMatches.push({ term, sym });
    }
  }
  if (symbolMatches.length > 0) {
    console.log(`[unifiedGrepSearch] symbol_index hits exactos: [${symbolMatches.map(m => m.term).join(', ')}]`);
  }

  // ── 1.5. Fuzzy match contra símbolos reales del repo ──────────────────────
  // Solo se activa si el paso 1 (match exacto) no encontró nada. Consulta la
  // lista real de símbolos indexados (cacheada) y busca cuáles contienen el
  // término candidato. Esto reemplaza la necesidad de generar variantes a
  // ciegas o de mantener una lista de stopwords: un término genérico como
  // "funciona" simplemente no matchea ningún símbolo real y se descarta solo.
  if (symbolMatches.length === 0) {
    const realSymbolNames = await getRepoSymbolNames(repo);
    if (realSymbolNames.length > 0) {
      for (const term of rawTerms) {
        const fuzzyCandidates = findRealSymbolMatches(term, realSymbolNames);
        if (fuzzyCandidates.length > 0) {
          console.log(`[unifiedGrepSearch] fuzzy match: "${term}" → símbolos reales [${fuzzyCandidates.join(', ')}]`);
        }
        for (const symName of fuzzyCandidates) {
          const sym = await lookupSymbol(symName, repo);
          if (sym) symbolMatches.push({ term: symName, sym });
        }
      }
    }
  }

  if (symbolMatches.length > 0) {
    // Preferir el término/símbolo más largo — términos cortos y genéricos que
    // igual lograron matchear (ej. tipos comunes) suelen ser menos específicos
    // que nombres técnicos largos como "trailingStop" o "checkS1Bull".
    symbolMatches.sort((a, b) => b.term.length - a.term.length);
    // When excludeTestPaths is active, skip symbol_index entries that point to
    // test files — the retry should surface the production symbol instead.
    const validMatches = options?.excludeTestPaths
      ? symbolMatches.filter(m => !isTestMatch(m.sym.filePath))
      : symbolMatches;
    if (validMatches.length > 0) {
      const best = validMatches[0];
      send('action', { text: `⚡ Símbolo en índice: ${best.sym.filePath}:${best.sym.lineNumber} (término: "${best.term}")` });
      return [{ path: best.sym.filePath, line: best.sym.lineNumber, text: best.term, symbolType: best.sym.symbolType }];
    }
    // All symbol_index hits were test paths — fall through to ripgrep with exclusions
    send('action', { text: `⬜ Paso 1 — índice solo apunta a test, ignorado` });
  } else {
    send('action', { text: `⬜ Paso 1 — no en índice` });
  }

  // ── 2. ripgrep on local clone — primary search ────────────────────────────
  if (isCloned(repo)) {
    // Cada término se convierte en un patrón regex con separadores opcionales entre
    // palabras, luego se unen con "|" — ripgrep los busca todos en una sola pasada
    // con -i cubriendo el casing (trailing[\s_-]*stop matchea trailingStop, TRAILING_STOP, etc.)
    const ripgrepPattern = rawTerms.map(t => buildRipgrepPattern(t)).join('|');
    console.log(`[unifiedGrepSearch] patrón ripgrep construido: "${ripgrepPattern}" (desde: [${rawTerms.join(', ')}])`);
    send('action', { text: `🔬 Paso 2 — ripgrep local: \`${ripgrepPattern}\`` });

    // When excludeTestPaths is active, add ripgrep glob exclusions so test
    // directories are skipped at the OS level — faster and more thorough than
    // post-filtering (avoids hitting the 20-result cap with test-only files).
    const testExcludeGlobs: string[] = options?.excludeTestPaths
      ? [
          '--glob', '!**/*.test.ts', '--glob', '!**/*.test.js',
          '--glob', '!**/*.spec.ts', '--glob', '!**/*.spec.js',
          '--glob', '!**/__tests__/**', '--glob', '!**/tests/**',
          '--glob', '!**/mocks/**',    '--glob', '!**/fixtures/**',
        ]
      : [];

    const rgResults = await rgSearch(ripgrepPattern, repo, testExcludeGlobs);
    if (rgResults.length > 0) {
      send('action', { text: `✅ Paso 2 — ${rgResults.length} resultado(s) vía ripgrep local` });
      return rgResults.map(r => ({ path: r.path, line: r.line, text: r.text }));
    }
    send('action', { text: `⬜ Paso 2 — sin resultados en ripgrep` });
    return [];
  }

  // ── 3. Fallback: GitHub Code Search API (repo no clonado aún) ─────────────
  send('action', { text: `☁️ Paso 2 — repo no clonado → GitHub Code Search API` });
  const seen = new Set<string>();
  const rawResults: { path: string; fragment: string }[] = [];
  console.log(`[unifiedGrepSearch] fallback GitHub API para "${pattern}"`);
  for (const rawTerm of rawTerms) {
    if (rawResults.length >= 10) break;
    const cleaned = cleanForGitHubSearch(rawTerm);
    const termsToTry = generateSearchVariants(cleaned);
    console.log(`[unifiedGrepSearch] término "${rawTerm}" → ${termsToTry.length} sub-búsqueda(s) vía generateSearchVariants: [${termsToTry.join(', ')}]`);
    send('action', { text: `🔀 "${rawTerm}" → variantes: [${termsToTry.join(', ')}]` });
    let foundWithVariant = false;
    for (const term of termsToTry) {
      if (rawResults.length >= 10) break;
      try {
        const results = await searchCodeInRepo(term, repo);
        for (const r of results.slice(0, 10)) {
          if (!seen.has(r.path)) {
            seen.add(r.path);
            rawResults.push({ path: r.path, fragment: r.fragments[0] ?? '' });
          }
        }
        if (results.length > 0) {
          send('action', { text: `✅ GitHub encontró ${results.length} resultado(s) con "${term}"` });
          foundWithVariant = true;
          break;
        }
      } catch (e: any) {
        if (e.message === 'GITHUB_RATE_LIMIT') throw e;
        console.warn(`[unifiedGrepSearch] término "${term}" falló:`, e.message);
      }
      if (termsToTry.length > 1) await new Promise(r => setTimeout(r, 600));
    }
    if (!foundWithVariant) {
      console.log(`[unifiedGrepSearch] sin resultados para "${rawTerm}" (variantes probadas: ${termsToTry.join(', ')})`);
      send('action', { text: `⬜ Sin resultados para "${rawTerm}" (probadas: ${termsToTry.join(', ')})` });
    }
    if (rawTerms.length > 1) await new Promise(r => setTimeout(r, 600));
  }
  if (rawResults.length === 0) return [];

  // Resolve line numbers + extraer sección con contexto (top 5, paralelo)
  const toReturn = rawResults.slice(0, 10);
  const resolved = await Promise.all(
    toReturn.map(async ({ path, fragment }, idx) => {
      if (!fragment) return { path } as GrepMatch;
      if (idx < 5) {
        try {
          const fileContent = await getFileContent(path, repo);
          // Encontrar la línea más representativa del fragmento
          const fragLine = fragment.split('\n').find(l => l.trim().length > 8) ?? fragment.slice(0, 60);
          const charIdx = fileContent.indexOf(fragLine.trim());
          if (charIdx !== -1) {
            const lineNum = fileContent.slice(0, charIdx).split('\n').length;
            // Extraer sección con contexto en lugar de devolver sólo el fragmento raw
            const section = smartReadSection(fileContent, lineNum, 20);
            console.log(`[unifiedGrepSearch] ${path}:${lineNum} → sección L${section?.startLine ?? '?'}-L${section?.endLine ?? '?'}`);
            return {
              path,
              line: lineNum,
              lineApprox: true,
              text: section ? section.excerpt : fragment.replace(/\n/g, ' ').slice(0, 200),
            } as GrepMatch;
          }
        } catch (e: any) {
          console.warn(`[unifiedGrepSearch] no se pudo resolver línea para ${path}:`, e.message);
        }
      }
      // Para resultados sin resolución de línea: devolver fragmento limpio
      return { path, text: fragment.replace(/\n/g, ' ').slice(0, 200) } as GrepMatch;
    })
  );
  return resolved;
}

async function executeChatTool(
  name: string,
  input: Record<string, any>,
  repo: string,
  send: (event: string, data: Record<string, unknown>) => void,
  sessionId: string,
): Promise<string> {
  if (name === 'list_files') {
    return await listFilesFiltered(repo, input.path);
  }
  if (name === 'read_file') {
    // Targeted range read — bypass smart cache, always serve the exact lines requested
    if (input.start_line) {
      const raw = await getFileContent(input.path, repo);
      const lines = raw.split('\n');
      send('action', { text: `📖 Leyendo ${input.path} líneas ${input.start_line}–${input.end_line ?? lines.length}` });
      return lines.slice(input.start_line - 1, input.end_line ?? lines.length).join('\n');
    }
    // Full read — apply smart decision (cached / diff / skeleton / full)
    const { result, decision } = await smartReadFile(input.path, repo, sessionId, send);
    // For diff/skeleton responses, return as-is — they are already compressed
    if (decision === 'diff' || decision === 'skeleton') return result;
    // For full content, apply existing 8 000-char truncation to keep prompt sizes bounded
    const CHAR_LIMIT = 8000;
    if (result.length <= CHAR_LIMIT) return result;
    const lines = result.split('\n');
    let chars = 0;
    let cutLine = 0;
    for (let i = 0; i < lines.length; i++) {
      chars += lines[i].length + 1;
      if (chars > CHAR_LIMIT) { cutLine = i; break; }
    }
    const remaining = lines.length - cutLine;
    return lines.slice(0, cutLine).join('\n') +
      `\n// ... (${remaining} líneas más — usá start_line/end_line para leer una sección específica)`;
  }
  if (name === 'grep_code') {
    send('action', { text: `🔎 Buscando "${input.pattern}"` });
    const rawTerms = input.pattern.split('|').map((t: string) => t.trim()).filter(Boolean);
    console.log(`[grep_code] patrón recibido: "${input.pattern}" → ${rawTerms.length} término(s) pipe-separado(s): [${rawTerms.join(', ')}]`);
    let matches: GrepMatch[];
    try {
      matches = await unifiedGrepSearch(input.pattern, repo, send);
    } catch (e: any) {
      if (e.message === 'GITHUB_RATE_LIMIT') {
        return `Error: GitHub code search rate limit alcanzado (10 req/min). Esperá ~1 min y reintentá, o usá read_file directamente en los archivos sospechosos.`;
      }
      throw e;
    }
    if (matches.length === 0) {
      if (isCloned(repo)) {
        return `Sin resultados para "${input.pattern}" en el clon local. El término puede no existir literalmente — revisá variantes o usá read_file en los archivos más probables.`;
      }
      return `Sin resultados vía GitHub code search para "${input.pattern}". Causas posibles: delay de indexación de GitHub, rate limit silencioso, o caracteres especiales en el patrón (${input.pattern}). Si el término existe, usá read_file directamente en los archivos donde lo esperás encontrar, en vez de reintentar grep_code con el mismo término.`;
    }
    return matches.map(m => {
      if (m.symbolType) return `${m.path} — línea ${m.line}: [${m.symbolType}] "${m.text}"`;
      if (m.line) return `${m.path} — línea ${m.lineApprox ? '~' : ''}${m.line}: "${m.text}"`;
      return `${m.path} — "${m.text}"`;
    }).join('\n');
  }
  if (name === 'propose_patch') {
    send('patch_proposal', {
      path: input.path,
      old_str: input.old_str,
      new_str: input.new_str,
      reasoning: input.reasoning,
    });
    return 'Patch propuesto al usuario — esperando aprobación. No lo des por aplicado.';
  }
  return `Tool desconocida: ${name}`;
}

// ── runChatTurn ───────────────────────────────────────────────────────────────

// System prompt for Haiku exploration tier — smart domain-aware search strategy
const HAIKU_SEARCH_SYSTEM = `Eres un asistente de exploración y síntesis de código. \
Tu objetivo principal es responder la pregunta del usuario de forma completa y eficiente.

━━━ PASO 0 (OBLIGATORIO — hacerlo ANTES de cualquier tool call) ━━━
Revisá si el contexto de la conversación ya contiene evidencia que responda la pregunta:
  • Si hay una sección "EVIDENCIA CONFIRMADA (DEEP mode)" o "EVIDENCIA VERIFICADA (DEEP mode)":
    esas citas de archivo:línea son lecturas reales del código fuente — HECHOS, no suposiciones.

    REGLA DE SÍNTESIS — si el fragmento cierra con \`};\` (función completa):
      → El cuerpo de la función está completo. NUNCA lo releas con el mismo rango ni con uno más amplio.
      → Sintetizá desde ese fragmento como base principal.

    EXCEPCIÓN PERMITIDA — lectura puntual para símbolo sin definición visible:
      Si una variable o símbolo que aparece en el fragmento NO tiene definición visible
      ni en la evidencia DEEP ni en el contexto ya cargado (ej: \`sa\`, \`sb\`, \`noAgot\`,
      \`stDirArr\` sin descripción previa), Haiku DEBE hacer UNA lectura puntual para
      confirmar su significado real antes de mencionarlo en la respuesta:
        · UN grep_code con el nombre exacto del símbolo
        · seguido de UN read_file de MÁXIMO 15 líneas alrededor del resultado
      PROHIBIDO: inventar el significado de una variable sin haberla buscado en el código.
      PROHIBIDO: omitirla en la respuesta sin haber intentado esa lectura puntual primero.
      PROHIBIDO: usar esta excepción para re-leer el rango de la función ya entregada,
        o para ampliar el contexto más allá de 15 líneas por símbolo.
      LÍMITE: máximo 2 lecturas puntuales por respuesta (2 símbolos desconocidos).
        Si quedan más sin resolver, mencioná que no se pudo confirmar su definición.

    → Si la evidencia cubre la pregunta completamente: sintetizá directo, sin ninguna tool call.
    → Si cubre parcialmente por algo en un símbolo ya citado: NO repitas la búsqueda sobre él.

  • Si hay "INVESTIGACIÓN PREVIA (FAST mode)" o "HALLAZGO PREVIO":
    usalo como punto de partida. Solo buscá de nuevo si necesitás más detalle que el que hay.
Si la evidencia existente responde la pregunta completamente, pasá directo a la síntesis (ver ROL).

━━━ PROCESO DE BÚSQUEDA (solo si el Paso 0 no alcanzó) ━━━

1. MIRÁ LA ESTRUCTURA PRIMERO: usá list_files en las carpetas raíz relevantes antes de leer contenido. \
Los nombres de carpeta/archivo te dicen dónde vivirá la lógica (ej: "lib/", "routes/", "services/" para \
backend; "components/", "pages/" para UI; "utils/", "helpers/" para funciones compartidas).

2. GENERÁ VARIANTES DE DOMINIO ANTES DE BUSCAR — a partir del término de la pregunta, generá 3-5 variantes \
basadas en convenciones reales de código, NO en el término literal:
   - camelCase (ej: "trailing stop" → trailingStop)
   - CONSTANT_CASE (ej: TRAILING_STOP_ENABLED)
   - snake_case (ej: trailing_stop)
   - Jerga del dominio si aplica (en trading: callbackRatio, rangeRate, movingPlan; en auth: token, session, jwt; \
en pagos: charge, invoice, webhook)
   - Sinónimos funcionales cortos (ej: "stop dinámico", "SL móvil")

3. PRIMERA PASADA — mandá TODAS las variantes en UN SOLO llamado a grep_code usando el separador "|": \
pattern: "trailingStop|TRAILING_STOP|trailing_stop|callbackRatio". NO busques una, esperes el resultado, \
y recién ahí pienses la siguiente. Todas las variantes van juntas en la primera llamada.
   NOTA: grep_code ya consulta automáticamente el índice de símbolos del repo antes de buscar. Si el \
término es un nombre de función/clase exacto que ya fue indexado, vas a obtener el archivo y línea exacta \
de inmediato sin pasos intermedios. Mandá el nombre exacto (camelCase) como primera variante en el pipe.

4. SEGUNDA PASADA (solo si la primera no encontró nada): revisá los nombres de archivo reales que listaste \
en el paso 1, generá nuevas variantes informadas por esos nombres reales, y hacé UNA segunda búsqueda con \
las variantes más probables dado lo que existe en el repo.

5. Si después de estas dos pasadas no encontraste nada, terminá tu respuesta con el texto EXACTO: \
"BÚSQUEDA_SIN_RESULTADOS". No rellenes con conocimiento general que no venga del código real.

REGLA CRÍTICA — read_file después de grep_code:
Cuando grep_code devuelva un resultado con "línea ~N", tu siguiente read_file DEBE apuntar \
directamente a esa zona: start_line: N-20, end_line: N+150 — UNA sola llamada. \
NUNCA leas el archivo en bloques secuenciales adivinando dónde está la función \
(ej: 1-100, 100-200, 200-300...). Si la función es más larga que ese rango, ampliá \
end_line en esa misma llamada (ej. N+300), no con una segunda llamada incremental.

Si grep_code NO incluye número de línea (búsqueda conceptual sin match exacto): \
hacé UNA sola llamada a read_file con start_line: 1, end_line: 300 para ver la \
estructura general del archivo, luego UNA segunda llamada dirigida a la sección \
relevante que identifiques de esa estructura. No más de dos llamadas por archivo.

━━━ ROL DE HAIKU — síntesis y límites ━━━
Una vez que tenés el código relevante (sea de evidencia previa o de tu búsqueda), \
tu tarea es responder la pregunta con una síntesis completa:
  ✓ PERMITIDO: explicar qué hace el código, cómo funciona, cuáles son sus condiciones,
    describir la causa raíz de un comportamiento ("el motivo es que la condición X evalúa
    primero Y antes que Z"), identificar por qué algo sucede.
  ✓ PERMITIDO: si para resolver el problema habría que cambiar algo, decilo en prosa:
    "Para resolver esto habría que ajustar la condición en [archivo], decime si querés
    que lo evalúe" — pero NO escribas el cambio vos.
  ✗ PROHIBIDO: escribir old_str/new_str, usar propose_patch, o redactar el código del fix.
    Eso es exclusivamente tarea de Sonnet cuando el usuario pide explícitamente un cambio.
  ✗ PROHIBIDO: inferir o afirmar lo que no leíste literalmente en el código.

No inferás lo que no leíste. Citá fragmentos exactos para respaldar tus afirmaciones.

Al sintetizar: usá los nombres técnicos de trading exactos (**FVG**, **EMA**, **SuperTrend**, \
**RSI**, **ADX**, **ATR**, **Score**, etc.) — nunca los parafrasees con lenguaje genérico. \
Aplicá **negrita** a cada término técnico y valor numérico clave (**EMA10**, **Score ≥ 60**, \
**FVG**, **3 velas**, etc.) cada vez que aparecen en la respuesta.

━━━ NOTA DE DOMINIO — variables de trading frecuentes ━━━
En repos de trading (Signal OS, Ahorar, etc.), las abreviaturas de variables tienen convenciones fijas:
  • \`st\`, \`stDir\`, \`stDirArr\` → dirección del indicador **SuperTrend** (NO Parabolic SAR).
    SAR y SuperTrend son indicadores distintos — nunca intercambies sus nombres.
  • \`sa\`, \`sb\` → **Score alcista** y **Score bajista** (índice numérico de momentum/dirección).
    NUNCA asocies \`sa\`/\`sb\` con "SAR (Parabolic)" ni con ningún indicador SAR — son scores, no SAR.
  • \`fvgBull\`, \`fvgBear\` → **FVG** (Fair Value Gap) alcista / bajista.
    Nombralo siempre como **FVG**. PROHIBIDO parafrasear como "ruptura de máximos", "brecha de precio"
    u otra descripción genérica — el nombre técnico correcto es **FVG** y debe aparecer así.
  • \`noAgot\` → sin agotamiento de momentum (condición booleana)
  • \`ema\`, \`emaFast\`, \`emaSlow\` → **EMA** (Exponential Moving Average)
  • \`rsi\`, \`rsiVal\` → **RSI**
  • \`adx\`, \`adxVal\` → **ADX**
  • \`atr\`, \`atrVal\` → **ATR**
Cuando identifiques un indicador, usá siempre el nombre técnico completo de trading, no lo parafrasees.

REGLA ANTI-CONFUSIÓN — variables de 2-3 letras:
Nombres cortos (\`sa\`, \`sb\`, \`st\`, \`rr\`, \`hl\`, \`sl\`, \`tp\`, etc.) tienen ALTO RIESGO de
confundirse con acrónimos de trading (SAR, SMA, EMA, RSI…) solo por parecido visual.
NUNCA deduzcas el significado de una variable corta por similitud de nombre.
Si no está en la tabla de arriba ni en la evidencia DEEP → hacé la lectura puntual
(grep_code + read_file ≤15 líneas) antes de nombrarla. Si tampoco hay definición, escribí:
"no pude confirmar qué representa \`[var]\` en este contexto — no la renombro".`;

// Tools available for Sonnet synthesis turn — no search tools, only read + patch
// Sonnet only gets propose_patch — it must not re-investigate with search tools.
// Haiku already gathered all context; Sonnet's job is to write the patch.
const SONNET_SYNTHESIS_TOOLS = CHAT_TOOLS.filter(t => t.name === 'propose_patch');

async function runHaikuTier(
  messages: any[],
  repo: string,
  send: (event: string, data: Record<string, unknown>) => void,
  sessionId: string,
  maxSteps = 12,
  allowPatch = true,
): Promise<{ resolved: boolean; messages: any[]; foundFiles: boolean }> {
  send('action', { text: '⚡ Haiku 4.5 — exploración inteligente del codebase' });
  send('model_active', { model: 'Haiku 4.5', tier: 'balanced' });

  let foundFiles = false;

  for (let step = 0; step < maxSteps; step++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        system: [{ type: 'text', text: HAIKU_SEARCH_SYSTEM, cache_control: { type: 'ephemeral' } }],
        tools: (allowPatch ? CHAT_TOOLS : CHAT_TOOLS.filter(t => t.name !== 'propose_patch')).map((t, i, arr) =>
          i === arr.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t
        ),
        messages,
      }),
    });

    const data = await res.json() as { type?: string; error?: { message: string }; content: any[] };
    if (!res.ok || data.type === 'error') {
      send('action', { text: `❌ Error de API: ${data.error?.message ?? `HTTP ${res.status}`}` });
      return { resolved: false, messages, foundFiles: false };
    }
    messages.push({ role: 'assistant', content: data.content });

    const textBlocks = data.content.filter((b: any) => b.type === 'text');
    for (const t of textBlocks) {
      send('chat_message', { text: t.text });
    }

    const toolUses = data.content.filter((b: any) => b.type === 'tool_use');
    if (toolUses.length === 0) {
      // Check if Haiku signalled no results via the sentinel text
      const allText = textBlocks.map((b: any) => b.text as string).join('\n');
      if (allText.includes('BÚSQUEDA_SIN_RESULTADOS')) {
        return { resolved: false, messages, foundFiles: false };
      }
      return { resolved: true, messages, foundFiles };
    }

    const toolResults: any[] = [];
    for (const tool of toolUses) {
      const resultText = await executeChatTool(tool.name, tool.input, repo, send, sessionId);
      toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: resultText });
      // Track whether any tool call returned real content (not an error or empty result)
      if (
        (tool.name === 'grep_code' || tool.name === 'read_file' || tool.name === 'list_files') &&
        !resultText.startsWith('Sin resultados') &&
        !resultText.startsWith('Error:') &&
        resultText.trim().length > 50
      ) {
        foundFiles = true;
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }

  send('action', { text: '🧠 Haiku alcanzó el límite de pasos de exploración' });
  return { resolved: false, messages, foundFiles };
}

async function runChatTurn(
  sessionId: string,
  userMessage: string,
  repo: string,
  send: (event: string, data: Record<string, unknown>) => void,
  maxToolSteps = 20,
  findingId?: string,
): Promise<void> {
  const history = await loadChatHistory(sessionId);
  const complexity = classifyComplexity(userMessage);

  // Cargar hallazgo de FAST si viene con findingId
  let fastFindingContext = '';
  let fastFinding: any = null; // hoisted para inyectar en cacheHint (Groq triage)
  if (findingId) {
    fastFinding = await loadInvestigationFinding(findingId, repo).catch(() => null);
    if (fastFinding) {
      const findingFilesSummary = fastFinding.files.map((f: any) => f.path.split('/').pop()).join(', ');
      const findingFilesWithRanges = fastFinding.files.map((f: any) => {
        const rangeStr = f.lineRanges?.length
          ? ` (líneas ${f.lineRanges.map((r: any) => `${r.start}-${r.end}`).join(', ')})`
          : '';
        return `${f.path}${rangeStr}`;
      }).join(', ');
      const isDeepEvidence = (fastFinding.evidence?.length ?? 0) > 0;
      send('action', { text: `📎 ${isDeepEvidence ? 'Evidencia DEEP' : 'Hallazgo FAST'} cargado — archivos priorizados: ${findingFilesSummary}` });
      fastFindingContext = isDeepEvidence
        ? `\n\nEVIDENCIA CONFIRMADA (DEEP mode — lectura real del código fuente con citas file:línea exactas). Tratá cada fragmento citado como hecho verificado: NO lo cuestiones, NO lo reinterpretes, NO pidas confirmación adicional. Solo ampliá la búsqueda si hay huecos explícitos en la evidencia (ej: cita un símbolo pero no muestra el flujo que lo llama, o la pregunta cubre algo que la evidencia no tiene):\n${fastFinding.diagnosis}\nArchivos con evidencia: ${findingFilesWithRanges}`
        : `\n\nINVESTIGACIÓN PREVIA (FAST mode, confianza ${fastFinding.confidence.toUpperCase()}) — usa esto como punto de partida, no repitas la exploración desde cero salvo que necesites más detalle:\n${fastFinding.diagnosis}\nArchivos identificados: ${findingFilesWithRanges}`;
    }
  }

  // Preload cached agent context (populated by QuarkAgent deep analysis runs)
  const cachedCtx = await loadAgentContext().catch(() => null);
  let seedContext = '';
  let cacheHint = '';
  if (cachedCtx && cachedCtx.repo === repo) {
    const cacheAge = Date.now() - (cachedCtx.savedAt ?? 0);
    if (cacheAge < 30 * 60 * 1000 && cachedCtx.preloadedFiles?.length > 0) {
      const filePaths = cachedCtx.preloadedFiles.map((f: any) => f.path).join('\n');
      cacheHint = cachedCtx.summary
        ? `RESUMEN de lo ya investigado en este repo recientemente:\n${cachedCtx.summary}\n\nSi esto responde la pregunta, úsalo directo. Si necesitás más detalle o el resumen no alcanza, responde NEEDS_TOOLS.`
        : '';
      seedContext = `\n\nCONTEXTO YA INVESTIGADO RECIENTEMENTE (por otra herramienta de este mismo sistema, hace menos de 30 min) — revisa si es relevante para esta pregunta antes de buscar de nuevo con grep_code:\n${filePaths}\n\nSi es relevante, usa read_file directamente en esos paths en vez de grep_code desde cero.`;
    }
  }

  // Cargar resúmenes compartidos (de Agent, War Room, etc.) y concatenar al cacheHint
  const sharedSummaries = await loadRecentContextSummaries(repo);
  const sharedHint = sharedSummaries.length > 0
    ? `\n\nCONTEXTO ADICIONAL de otras herramientas de este sistema (Quark Agent, War Room) sobre este mismo repo, investigado recientemente:\n${sharedSummaries.map(s => `[${s.origin}] ${s.summary}`).join('\n')}`
    : '';
  cacheHint = cacheHint + sharedHint;

  // Inyectar hallazgo en cacheHint para que Groq pueda responder basándose en la investigación
  // previa sin necesitar tools — no altera qué camino toma classifyComplexity, solo mejora
  // la capacidad de respuesta de Groq cuando ya hay contexto real del repo disponible.
  if (fastFinding) {
    const findingFilesWithRangesHint = fastFinding.files.map((f: any) => {
      const rangeStr = f.lineRanges?.length
        ? ` (líneas ${f.lineRanges.map((r: any) => `${r.start}-${r.end}`).join(', ')})`
        : '';
      return `${f.path}${rangeStr}`;
    }).join(', ');
    const isDeepEvidenceHint = (fastFinding.evidence?.length ?? 0) > 0;
    const findingHint = isDeepEvidenceHint
      ? `EVIDENCIA VERIFICADA (DEEP mode — lectura real del código fuente):\n${fastFinding.diagnosis.slice(0, 800)}\nArchivos con citas exactas: ${findingFilesWithRangesHint}\nEsta evidencia es HECHO CONFIRMADO — no la cuestiones, no agregues "probablemente" ni pidas verificación adicional. Si responde la pregunta, úsala directamente sin invocar herramientas de búsqueda.`
      : `HALLAZGO PREVIO DE FAST MODE (confianza ${fastFinding.confidence.toUpperCase()}, investigación real del repo):\n${fastFinding.diagnosis.slice(0, 500)}\nArchivos identificados: ${findingFilesWithRangesHint}\nSi este hallazgo responde la pregunta directamente, úsalo sin pedir herramientas.`;
    cacheHint = findingHint + (cacheHint ? '\n\n' + cacheHint : '');
  }

  // messages is initialized here so both paths (simple escalation + complex) share it
  const messages: any[] = [
    ...history,
    { role: 'user', content: userMessage + fastFindingContext + seedContext },
  ];

  // ── Simple path: Groq triage (text-only, no tools) ───────────────────────────
  if (complexity === 'simple') {
    send('action', { text: '⚡ Modo rápido — Groq' });
    send('model_active', { model: 'Groq (Llama 3.3 70B)', tier: 'fast' });
    const groqAnswer = await callGroqAgent(userMessage, buildTriagePrompt(cacheHint), fastFinding ? 768 : 512);

    if (!groqAnswer.trim().startsWith('NEEDS_TOOLS:')) {
      send('chat_message', { text: groqAnswer });
      messages.push({ role: 'assistant', content: [{ type: 'text', text: groqAnswer }] });
      await saveChatHistory(sessionId, messages);
      // Guardar resumen de la respuesta de Groq en contexto compartido
      const groqSharedSummary = await summarizeForSharedContext(groqAnswer);
      if (groqSharedSummary) {
        await saveContextSummary(repo, groqSharedSummary, 'chat').catch(() => {});
      }
      return;
    }

    const groqReason = groqAnswer.replace('NEEDS_TOOLS:', '').trim();
    send('action', { text: `🧠 Groq necesita explorar el codebase (${groqReason}) — Haiku 4.5 investigando` });
    // All NEEDS_TOOLS cases — both medium and high effort — go through the Haiku
    // exploration phase below. Haiku does the search; Sonnet only synthesises.
  }

  // ── Haiku exploration phase (ALL paths that need code inspection) ─────────────
  // Classify intent first so we can:
  //   'explain'  → Haiku handles everything end-to-end (search + final answer)
  //   'generate' → Haiku searches/reads, then Sonnet writes the patch
  const intent = classifyIntent(userMessage);
  {
    // Haiku NEVER gets propose_patch — that tool is exclusively for Sonnet.
    // BUG 0 fix: allowPatch was accidentally set to `intent === 'explain'` (true for
    // informational queries), which let Haiku generate patches for read-only questions.
    // Now it is always false: Haiku only searches and reads, Sonnet proposes patches.
    const haikuResult = await runHaikuTier(
      messages, repo, send, sessionId,
      12,                          // maxSteps
      false,                       // allowPatch: ALWAYS false — Haiku never proposes patches
    );
    if (haikuResult.resolved) {
      await saveChatHistory(sessionId, haikuResult.messages);
      // Override any stale LOW-CONFIDENCE label from a preceding DEEP/FAST call.
      // Haiku resolved the question with live code reads — the result is real.
      send('confidence', {
        level: 'medium',
        reason: 'CHAT — Haiku 4.5 exploró y respondió con lectura directa del código fuente',
        suggestedAction: 'none',
      });
      return;
    }
    if (!haikuResult.foundFiles) {
      // Two full search passes found nothing — don't escalate to Sonnet;
      // ask the user for more precise context instead.
      const noResultMsg =
        'No encontré referencias a esto en el codebase después de buscar con variantes de nombres ' +
        '(camelCase, snake_case, CONSTANT_CASE y jerga del dominio).\n\n' +
        'Para que pueda ayudarte mejor, indicame:\n' +
        '- El nombre exacto del archivo o carpeta donde lo esperás encontrar, o\n' +
        '- El nombre de la función o variable tal como aparece en el código.';
      send('chat_message', { text: noResultMsg });
      haikuResult.messages.push({ role: 'assistant', content: [{ type: 'text', text: noResultMsg }] });
      await saveChatHistory(sessionId, haikuResult.messages);
      return;
    }

    if (intent === 'explain') {
      // Explain/investigate queries: Haiku is authoritative. It found files but hit
      // the step limit before producing a final text answer — save and return.
      // The intermediate messages (streamed during exploration) are already visible
      // to the user; Sonnet must NOT be invoked for explanation queries.
      await saveChatHistory(sessionId, haikuResult.messages);
      return;
    }

    // intent === 'generate': Haiku explored and found the relevant files.
    // Hand off to Sonnet with a code-generation-only instruction.
    // Sonnet receives ONLY propose_patch — no search, no read_file re-exploration.
    messages.push({
      role: 'user',
      content: '[Haiku 4.5 ya exploró el codebase y encontró los archivos relevantes (ver mensajes anteriores). ' +
        'Tu tarea es ÚNICAMENTE generar el patch de código requerido usando propose_patch. ' +
        'NO uses grep_code, list_files ni read_file — todo el contexto ya está cargado en la conversación. ' +
        'Basate en los fragmentos de código que Haiku ya leyó y proponé el cambio concreto con propose_patch.]',
    });
  }

  // ── Sonnet patch-generation phase ────────────────────────────────────────────
  // Only reached for 'generate' intent. Sonnet writes the patch; it cannot search.
  // SONNET_SYNTHESIS_TOOLS = [propose_patch] only — no read_file, no grep_code.

  const systemPrompt = `Eres QUARK, un asistente de código que actúa como ingeniero senior. \
Haiku 4.5 ya investigó el codebase y el contexto relevante está en el historial de esta conversación.

TAREA: generá el patch de código solicitado usando propose_patch. No hagas otra cosa.

RAZONAMIENTO PASO A PASO (obligatorio antes de proponer cualquier patch):
1. ¿Cuál es la causa raíz exacta del problema? Citá la línea/condición literal del contexto.
2. ¿Cuál es el mínimo cambio que la resuelve?
3. ¿Existe old_str que coincida literalmente en el fragmento de código ya leído?
Si no encontraste el símbolo o función buscada, decilo explícitamente y sugerí qué buscar a continuación.

REGLAS:
- Antes de proponer un patch, verificá que el old_str que usarás en propose_patch exista literalmente \
en el fragmento de código ya leído por Haiku — no inventes old_str que no aparezca en la conversación.
- Proponé un patch mínimo que resuelva la CAUSA RAÍZ, no solo el síntoma.
- Si el problema depende de un flujo de control (loops, funciones encadenadas), seguí la cadena \
hasta el final antes de escribir el fix.
- REGLA DE ANCLAJE: en el campo "reasoning" de propose_patch, citá el fragmento exacto del código \
que justifica el cambio — no solo el nombre del archivo.
- Sé directo y concreto. Usá propose_patch en un solo turno.

RESTRICCIÓN: NO uses grep_code, list_files ni read_file — el contexto ya está completo en el historial.`;

  send('model_active', { model: 'Sonnet 5', tier: 'deep' });
  // maxSynthesisSteps: enough for at most 1 targeted read_file + final synthesis reply
  const maxSynthesisSteps = 3;
  for (let step = 0; step < maxSynthesisSteps; step++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 16000,
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: classifyEffort(userMessage) },
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        tools: SONNET_SYNTHESIS_TOOLS.map((t, i) =>
          i === SONNET_SYNTHESIS_TOOLS.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t
        ),
        messages,
      }),
    });

    const data = await res.json() as { type?: string; error?: { message: string }; content: any[] };
    if (!res.ok || data.type === 'error') {
      throw new Error(`Anthropic API error ${res.status}: ${data.error?.message ?? JSON.stringify(data)}`);
    }
    const thinkingBlocks = data.content.filter((b: any) => b.type === 'thinking');
    for (const tb of thinkingBlocks) {
      if (tb.thinking?.trim()) {
        send('action', { text: `🧠 ${tb.thinking.trim()}` });
      }
    }

    // data.content is pushed intact — thinking blocks must not be filtered or
    // reconstructed before being stored, or Anthropic returns 400.
    messages.push({ role: 'assistant', content: data.content });

    const textBlocks = data.content.filter((b: any) => b.type === 'text');
    for (const t of textBlocks) {
      send('chat_message', { text: t.text });
    }

    const toolUses = data.content.filter((b: any) => b.type === 'tool_use');
    if (toolUses.length === 0) {
      // Sonnet produced the final answer — save and share the summary
      const claudeText = textBlocks.map((b: any) => b.text).join('\n');
      if (claudeText.trim()) {
        const claudeSharedSummary = await summarizeForSharedContext(claudeText);
        if (claudeSharedSummary) {
          await saveContextSummary(repo, claudeSharedSummary, 'chat').catch(() => {});
        }
      }
      break;
    }

    const toolResults: any[] = [];
    for (const tool of toolUses) {
      const resultText = await executeChatTool(tool.name, tool.input, repo, send, sessionId);
      toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: resultText });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  await saveChatHistory(sessionId, messages);
}

router.post('/chat', async (req, res) => {
  const { message, repo: bodyRepo, sessionId, findingId } = req.body as {
    message?: string; repo?: string; sessionId?: string; findingId?: string;
  };
  const repo = bodyRepo ?? process.env.GITHUB_REPO;
  console.log('[CHAT] incoming →', { message, repo, sessionId });
  if (!message || !repo || !sessionId) {
    console.log('[CHAT] 400 — campo faltante:', { message: !!message, repo: !!repo, sessionId: !!sessionId });
    res.status(400).json({ error: 'message, repo and sessionId are required' });
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
    await runChatTurn(sessionId, message, repo, send, 20, findingId);
    send('done', {});
  } catch (err) {
    const stack = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error('[CHAT] error en runChatTurn:', stack);
    send('error', { text: stack });
  }
  res.end();
});

export default router;
