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

// ── FAST session history (namespace separado de CHAT para no mezclar) ────────
const FAST_SESSION_NS = 'quark-fast-session';

async function loadFastHistory(sessionId: string): Promise<any[]> {
  try {
    const r = await pool.query<{ content: string }>(
      `SELECT content FROM memory_entries WHERE key = $1 AND namespace = $2 LIMIT 1`,
      [`fast-${sessionId}`, FAST_SESSION_NS],
    );
    return r.rows[0]?.content ? JSON.parse(r.rows[0].content) : [];
  } catch {
    return [];
  }
}

async function saveFastHistory(sessionId: string, messages: any[]): Promise<void> {
  await pool.query(
    `INSERT INTO memory_entries (key, content, namespace)
     VALUES ($1, $2, $3)
     ON CONFLICT (key, namespace) DO UPDATE SET content = EXCLUDED.content, timestamp = NOW()`,
    [`fast-${sessionId}`, JSON.stringify(messages.slice(-6)), FAST_SESSION_NS], // últimos 3 turnos
  );
}

/** Devuelve true si al menos un keyword del turno actual coincide con keywords del turno anterior. */
function hasFastTopicOverlap(current: string[], previous: string[]): boolean {
  if (!current.length || !previous.length) return false;
  const prevSet = new Set(previous.map(k => k.toLowerCase()));
  return current.some(k => prevSet.has(k.toLowerCase()));
}

// ── DEEP session: persistir última evidencia para pedidos de "ver más" ────────
const DEEP_SESSION_NS = 'quark-deep-session';

interface DeepSessionEntry { path: string; startLine: number; endLine: number; }

async function loadDeepSession(sessionId: string): Promise<DeepSessionEntry | null> {
  try {
    const r = await pool.query<{ content: string }>(
      `SELECT content FROM memory_entries WHERE key = $1 AND namespace = $2 LIMIT 1`,
      [`deep-${sessionId}`, DEEP_SESSION_NS],
    );
    return r.rows[0]?.content ? JSON.parse(r.rows[0].content) as DeepSessionEntry : null;
  } catch { return null; }
}

async function saveDeepSession(sessionId: string, entry: DeepSessionEntry): Promise<void> {
  await pool.query(
    `INSERT INTO memory_entries (key, content, namespace)
     VALUES ($1, $2, $3)
     ON CONFLICT (key, namespace) DO UPDATE SET content = EXCLUDED.content, timestamp = NOW()`,
    [`deep-${sessionId}`, JSON.stringify(entry), DEEP_SESSION_NS],
  );
}

/**
 * Detecta si el prompt es un pedido de continuación de DEEP (ver más líneas, seguir desde ahí).
 * Devuelve las líneas explícitas si las hay, o solo isContinuation=true para "siguiente bloque".
 */
function isDeepContinuation(prompt: string): { isContinuation: boolean; fromLine?: number; toLine?: number } {
  const msg = prompt.trim();
  // Rango explícito: "líneas 1150 a 1200", "desde 1150 hasta 1200", "1150-1200"
  const rangeMatch =
    msg.match(/l[íi]neas?\s+(\d+)\s*(?:a|al|-|hasta)\s*(\d+)/i) ??
    msg.match(/(?:desde|from)\s+(?:l[íi]nea\s+)?(\d+)\s+(?:a|al|hasta|to)\s+(?:l[íi]nea\s+)?(\d+)/i) ??
    msg.match(/\b(\d{3,})\s*[-–]\s*(\d{3,})\b/);
  if (rangeMatch) {
    return { isContinuation: true, fromLine: parseInt(rangeMatch[1]), toLine: parseInt(rangeMatch[2]) };
  }
  // Frases de continuación sin rango explícito
  const CONT = [
    /\b(mostr[aá](me)?|muestra(me)?|ver)\s+(m[aá]s|el?\s+resto|m[aá]s\s+abajo|siguiente\s+parte|bloque\s+siguiente)/i,
    /\b(segu[ií](s|d)?(\s+desde\s+ah[íi])?|continu[aá](\s+desde\s+ah[íi])?|m[aá]s\s+abajo|sigue\s+desde\s+ah[íi])\b/i,
    /\bver\s+m[aá]s\s+contexto\b/i,
    /\bm[aá]s\s+(contexto|c[oó]digo|l[íi]neas?)\b/i,
    /\b(next|more|continue|keep going)\s*(lines?|context|below)?\b/i,
  ];
  if (CONT.some(p => p.test(msg))) return { isContinuation: true };
  return { isContinuation: false };
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

/**
 * Converts stored Anthropic-format chat history to the flat {role, content: string}
 * array that Groq (OpenAI-compatible) expects.
 *
 * Rules:
 *  - assistant turns: keep only `type:"text"` blocks, drop `type:"tool_use"` blocks.
 *  - user turns:      keep only `type:"text"` blocks, drop `type:"tool_result"` blocks.
 *  - Turns that become empty after filtering (pure tool turns) are skipped entirely.
 *  - Adjacent messages of the same role are merged (defensive; shouldn't occur normally).
 *  - Capped to the last `maxExchanges` user+assistant pairs (default 8) and at most
 *    MAX_HISTORY_CHARS total characters to stay well within Groq's context window.
 */
function groqHistoryFromMessages(
  history: any[],
  maxExchanges = 8,
): { role: string; content: string }[] {
  const MAX_HISTORY_CHARS = 20_000;

  // Step 1: convert each stored message to a plain {role, content} object.
  const flat: { role: string; content: string }[] = [];
  for (const msg of history) {
    const role: string = msg.role;
    if (role !== 'user' && role !== 'assistant') continue;

    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content.trim();
    } else if (Array.isArray(msg.content)) {
      text = (msg.content as any[])
        .filter((b: any) => b.type === 'text' && typeof b.text === 'string')
        .map((b: any) => (b.text as string).trim())
        .filter(Boolean)
        .join('\n');
    }

    if (!text) continue; // pure tool turn — nothing useful for Groq

    // Merge with previous if same role (shouldn't happen in practice, but be safe).
    if (flat.length > 0 && flat[flat.length - 1].role === role) {
      flat[flat.length - 1].content += '\n' + text;
    } else {
      flat.push({ role, content: text });
    }
  }

  // Step 2: keep at most the last maxExchanges*2 messages (each exchange = user + assistant).
  const sliced = flat.slice(-(maxExchanges * 2));

  // Step 3: walk backwards and accumulate until we hit the char cap.
  let totalChars = 0;
  const capped: { role: string; content: string }[] = [];
  for (let i = sliced.length - 1; i >= 0; i--) {
    totalChars += sliced[i].content.length;
    if (totalChars > MAX_HISTORY_CHARS) break;
    capped.unshift(sliced[i]);
  }

  return capped;
}

async function callGroqAgent(
  prompt: string,
  system: string,
  maxTokens = 4096,
  historyMessages?: { role: string; content: string }[],
): Promise<string> {
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
            ...(historyMessages ?? []),
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

// ── Clasificación fusionada FAST: charla vs búsqueda técnica ─────────────────
// Una sola llamada a Groq con historial de sesión. Reemplaza el ciclo
// isTrivialMessage → classifyIntentWithAI para mensajes conversacionales en
// el router /generate (FAST). DEEP mode y runChatTurn no se tocan.

type FastClassification =
  | { type: 'chat'; answer: string }
  | { type: 'search'; terms: string[] };

/**
 * Filtra términos de clasificación que no aparecen ni en el mensaje actual
 * ni en el historial de sesión — descarta fugas de prompt del clasificador.
 */
function filterGroundedTerms(terms: string[], currentPrompt: string, history: any[]): string[] {
  const historyText = history
    .map((m: any) => typeof m.content === 'string' ? m.content : '')
    .join(' ')
    .toLowerCase();
  const promptLower = currentPrompt.toLowerCase();
  return terms.filter(t => {
    const tLower = t.toLowerCase();
    return promptLower.includes(tLower) || historyText.includes(tLower);
  });
}

async function classifyAndRespondFast(
  prompt: string,
  fastHistory: any[],
): Promise<FastClassification> {
  const keys = getGroqKeys();

  // Historial reciente en formato legible (últimos 3 turnos = 6 mensajes)
  const histStr = fastHistory.slice(-6)
    .map((m: any) => `${m.role === 'user' ? 'Usuario' : 'Asistente'}: ${
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    }`)
    .join('\n');

  // Fallback sin keys: comportamiento anterior para no romper el flujo
  if (keys.length === 0) {
    if (isTrivialMessage(prompt)) {
      return { type: 'chat', answer: '¡Hola! ¿En qué puedo ayudarte con el código?' };
    }
    return { type: 'search', terms: extractSearchKeywords(prompt) };
  }

  const systemPrompt = `Sos QUARK en modo FAST. Analizás el mensaje del usuario en el
contexto de la conversación reciente y decidís en un solo paso:

(a) Es CHARLA GENUINA — saludo, agradecimiento, pregunta puramente social o meta sobre
    vos mismo como asistente (ej: "¿cómo estás?", "¿puedes mantener una conversación
    coherente?", "¿en qué me podés ayudar en general?", "gracias", "genial"), SIN
    ninguna referencia a código, señales, indicadores, funciones, archivos o comportamiento
    del proyecto.
    → Respondé directo, breve y natural, en el campo "answer". NUNCA menciones
      herramientas, búsquedas ni código en esta respuesta.

(b) Es una PREGUNTA TÉCNICA sobre el repo — pide entender, diagnosticar o ubicar
    código real, incluyendo continuaciones técnicas como "¿por qué?" después de una
    respuesta sobre código.
    → Extraé 1-4 identificadores técnicos (camelCase/CONSTANT_CASE/snake_case) que
      probablemente aparecen en el código relacionado, en el campo "terms".

REGLA OBLIGATORIA — TÉRMINOS DE DOMINIO DEL PROYECTO (sin excepción):
Si el mensaje menciona un término técnico de trading, un identificador de señal con
formato letra+número (cualquier letra seguida de un dígito, ej. una señal etiquetada
con una letra y un número), un indicador técnico de mercado, un nombre que suene a
función/variable de código, o cualquier concepto específico de este proyecto de
trading — SIEMPRE es (b), NUNCA (a), sin importar qué tan conversacional suene la
pregunta ("¿cómo funciona X?", "¿qué es X?", "explícame X").

IMPORTANTE: esta regla describe un PATRÓN a reconocer en el MENSAJE DEL USUARIO, no una
lista de valores a repetir. Nunca copies ningún término de esta instrucción hacia el
campo "terms" de tu respuesta — los términos de salida deben extraerse EXCLUSIVAMENTE
del texto real que escribió el usuario (y del historial de sesión si es follow-up). Si
el mensaje del usuario no contiene ningún identificador técnico explícito (ej. "por qué"
sin más contexto), dejá que el término de continuación se resuelva por el historial de
sesión provisto — no inventes ni completes con ningún término que no haya aparecido
literalmente en el mensaje o en el historial.

PROHIBIDO ABSOLUTO — ANTI-ALUCINACIÓN:
Nunca respondas en el campo "answer" (rama chat) ninguna afirmación sobre CÓMO
funciona algo del proyecto, qué hace una señal, qué significa una función, o cualquier
dato técnico específico de este repo. Si no estás seguro de si el mensaje es charla o
pregunta técnica, elegí SIEMPRE (b) — es preferible buscar de más que inventar una
respuesta que suene correcta pero no venga del código real. Una mala clasificación hacia
(b) solo cuesta una búsqueda sin resultados; una mala clasificación hacia (a) puede
producir información falsa presentada como si fuera un hecho verificado.

HISTORIAL RECIENTE DE LA SESIÓN:
${histStr || '(sin historial previo)'}

Respondé ÚNICAMENTE con este JSON, sin markdown ni texto adicional:
{"type": "chat", "answer": "..."}
o
{"type": "search", "terms": ["...", "..."]}`;

  // Regex de dominio — defensa programática independiente del prompt
  const DOMAIN_TERMS_RE = /\b(se[ñn]al|signal|S[1-7]|FVG|imbalance|CHOCH|BOS|EMA|SMA|RSI|MACD|ADX|ATR|SuperTrend|SAR|Score|RVOL|trailing|circuit\s*breaker|streak|screener|scanner|bias)\b/i;

  try {
    const raw = await callGroqAgent(prompt, systemPrompt, 300);
    const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(cleaned) as FastClassification;

    if (parsed.type === 'chat' && typeof parsed.answer === 'string') {
      // Capa de seguridad: si el clasificador dijo "chat" pero el mensaje
      // contiene vocabulario de dominio, no confiar — forzar search.
      if (DOMAIN_TERMS_RE.test(prompt)) {
        console.warn('[classifyAndRespondFast] override: clasificado como chat pero contiene término de dominio, forzando search');
        return { type: 'search', terms: extractSearchKeywords(prompt) };
      }
      return parsed;
    }
    if (parsed.type === 'search' && Array.isArray(parsed.terms) && parsed.terms.length > 0) {
      return parsed;
    }
    throw new Error('shape inesperado');
  } catch {
    // Ante fallo de parseo/red: asumir técnico y dejar que el pipeline decida
    return { type: 'search', terms: extractSearchKeywords(prompt) };
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
  },
  {
    name: "deep_search",
    description: "Ejecuta el pipeline completo de DEEP en una sola llamada: symbol_index + extracción de función completa (readEnclosingFunction) + multi-hop caller/callee + anotación de patrones de trading. Usá esta herramienta como PRIMERA OPCIÓN para investigar código nuevo — reemplaza el ciclo grep_code → read_file → grep_code por una sola llamada consolidada. Pasá los identificadores técnicos en camelCase/CONSTANT_CASE separados por '|'. Resultado: fragmentos anotados con citas file:línea exactas, en el mismo formato que la evidencia DEEP.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Identificadores técnicos a buscar, separados por '|'. Ejemplos: 'trailingStop|TRAILING_STOP_ENABLED|callbackRatio' o 'checkS6Bull|fvgBull'. Generá variantes camelCase, CONSTANT_CASE y snake_case antes de llamar."
        }
      },
      required: ["query"]
    }
  },
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
  let { prompt: rawPrompt, repo: bodyRepo, branch = 'main', projectName, deepMode, findingId, sessionId } = req.body as {
    prompt?: string; repo?: string; branch?: string; projectName?: string; deepMode?: boolean; findingId?: string; sessionId?: string;
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
    // ── Clasificación fusionada FAST: charla vs búsqueda técnica ─────────────
    // Una sola llamada a Groq (con historial) reemplaza el ciclo
    // isTrivialMessage → classifyIntentWithAI para mensajes conversacionales.
    // Solo en FAST mode (!deepMode); DEEP tiene su propio pipeline.
    let _fastClassification: FastClassification | null = null;
    let _fastHistoryForClassify: any[] = [];

    if (!deepMode) {
      _fastHistoryForClassify = sessionId ? await loadFastHistory(sessionId) : [];
      const classification = await classifyAndRespondFast(prompt, _fastHistoryForClassify);
      _fastClassification = classification;

      if (classification.type === 'chat') {
        send('action', { text: classification.answer });
        send('done', { files: [], commitMessage: '', mainComponent: '', mainContent: '', repo, branch });

        // Persistir el turno para que preguntas técnicas futuras tengan contexto.
        // keywords: [] en turnos de charla — hasFastTopicOverlap no genera falso positivo
        // con un array vacío (devuelve false), pero el shape queda consistente.
        if (sessionId) {
          const updated = [
            ..._fastHistoryForClassify,
            { role: 'user', content: prompt, keywords: [] },
            { role: 'assistant', content: classification.answer },  // fragment omitido — no hubo lectura de código
          ];
          await saveFastHistory(sessionId, updated).catch(() => {});
        }

        await new Promise(r => setTimeout(r, 100));
        res.end();
        return;
      }
      // classification.type === 'search' — continúa; términos disponibles abajo
    }

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

        // Reusar términos e historial ya computados por classifyAndRespondFast
        // (evita llamadas duplicadas a extractKeywordsForSearch y loadFastHistory).
        const fastKeywords = (_fastClassification?.type === 'search' && _fastClassification.terms.length > 0)
          ? _fastClassification.terms
          : await extractKeywordsForSearch(prompt, repo);
        const fastPattern = fastKeywords.length > 0
          ? fastKeywords.join('|')
          : prompt.split(/\s+/).filter(w => w.length > 4).slice(0, 3).join('|');

        // ── FAST session continuity ──────────────────────────────────────────
        // Reusar historial cargado por classifyAndRespondFast (namespace FAST).
        const fastHistory: any[] = _fastHistoryForClassify;
        const _lastFastUser = fastHistory.slice().reverse().find((m: any) => m.role === 'user');
        const _lastFastAss  = fastHistory.slice().reverse().find((m: any) => m.role === 'assistant');
        const _isFollowUp   = !!sessionId &&
          hasFastTopicOverlap(fastKeywords, _lastFastUser?.keywords ?? []) &&
          !!_lastFastAss?.fragment;

        if (_isFollowUp) {
          // FAST FOLLOW-UP PATH — mismo tema detectado, evaluar si el fragmento alcanza.
          send('action', { text: '⚡ FAST — pregunta de seguimiento, evaluando contexto ya leído...' });

          const cachedFragment = _lastFastAss!.fragment as string;
          const fragmentCovers = !isFragmentInsufficient(cachedFragment, fastKeywords);

          // Prompt compartido entre ambas ramas — incluye REGLA DE CONTINUIDAD (Cambio 4)
          const fuSystemPrompt =
            `Eres un experto analista de código de trading respondiendo en FAST mode (pregunta de seguimiento).

REGLA DE CONTINUIDAD — obligatoria:
Esta es una pregunta de SEGUIMIENTO sobre algo que ya se explicó en el turno anterior.
Tu respuesta DEBE arrancar reconociendo esa continuidad de forma natural (ej. "Retomando la función placeTrailingStop..." o "Sobre eso que preguntás..."), y debe responder PUNTUALMENTE la pregunta de seguimiento — NO repitas la explicación general completa que ya diste. Si la pregunta es "¿por qué?", identificá a qué afirmación específica del turno anterior se refiere y explicá la razón concreta de esa afirmación, citando el fragmento que la sustenta.

REGLA DE VOCABULARIO — obligatoria:
Usá los términos técnicos de trading tal como los usa un trader profesional, en inglés cuando corresponda: \
**FVG**, **EMA**, **SMA**, **RSI**, **ADX**, **ATR**, **SuperTrend**, **VWAP**, **RVOL**, **Score**, etc. \
NUNCA los parafrasees con descripciones genéricas.

REGLA DE FORMATO — sin excepciones:
- Escribí en párrafos de prosa conectada (NO bullets sueltos, NO listas).
- Aplicá **negrita** a cada término técnico de trading y a cada valor numérico clave.
- PROHIBIDO: bloques de código con triple backtick, líneas de código sueltas, expresiones con operadores crudos.
- Máximo 3 párrafos cortos (2-3 oraciones cada uno).

ESTRUCTURA:
Párrafo 1 — respuesta directa a la pregunta de seguimiento, referenciando lo ya discutido.
Párrafo 2 — detalle adicional con valores y condiciones concretos en **negrita**.
Párrafo 3 — contexto o restricciones relevantes (omitir si no agrega nada nuevo).

REGLA ANTI-ALUCINACIÓN: Solo afirmá lo que está en el historial o el fragmento de código provisto. \
Si no alcanza para responder, decilo en una oración y sugerí DEEP mode.`;

          if (fragmentCovers) {
            // ── Camino principal: fragmento cacheado cubre la pregunta ──────────
            const histStr = fastHistory.slice(-6)
              .map((m: any) => `${m.role === 'user' ? 'Usuario' : 'Asistente'}: ${m.content}`)
              .join('\n');
            const followUpCombined =
              `Historial reciente de la sesión:\n${histStr}\n\n` +
              `Fragmento de código (mismo contexto del turno anterior):\n${cachedFragment}`;

            try {
              const fuAnalysis = await generateWithFallback(
                `El usuario hace una pregunta de seguimiento: "${prompt}"\n\n${followUpCombined}`,
                fuSystemPrompt,
              );

              const fuLines = fuAnalysis.split('\n').map((l: string) => l.trim()).filter(Boolean);
              for (const line of fuLines) {
                send('action', { text: `💡 ${line}` });
              }

              const updatedFastHistory = [
                ...fastHistory,
                { role: 'user',      content: prompt,     keywords: fastKeywords },
                { role: 'assistant', content: fuAnalysis, fragment: cachedFragment, path: _lastFastUser?.path },
              ];
              await saveFastHistory(sessionId!, updatedFastHistory).catch(() => {});
            } catch {
              send('action', { text: '⚠️ Análisis no disponible — intenta reformular la pregunta' });
            }
          } else {
            // ── Fallback: fragmento cacheado insuficiente — buscar archivo adicional ──
            send('action', { text: '🔍 El contexto ya leído no cubre esta pregunta — buscando en archivos adicionales...' });
            const alreadyReadPath = _lastFastUser?.path ?? (_lastFastAss as any)?.path;
            try {
              // Filtrar términos que no aparecen en el mensaje ni en el historial —
              // descarta cualquier fuga de prompt del clasificador (ej. S6 colándose en
              // una sesión sobre trailingstop por ser ejemplo en las instrucciones).
              const groundedTerms = filterGroundedTerms(fastKeywords, prompt, fastHistory);
              const fuPattern = (groundedTerms.length > 0 ? groundedTerms : fastKeywords).join('|');
              const { matches: fuMatches } = await searchWithTestFallback(fuPattern, repo, send);
              const fuNewMatch = fuMatches.find(
                m => m.path !== alreadyReadPath && !isTestMatch(m.path, m.text ?? ''),
              );

              if (fuNewMatch) {
                send('action', { text: `📍 Fragmento adicional: ${fuNewMatch.path}${fuNewMatch.line ? `:${fuNewMatch.line}` : ''}` });
                const fuContent = await getFileContent(fuNewMatch.path, repo);
                const fuSection = fuNewMatch.line
                  ? (readEnclosingFunction(fuContent, fuNewMatch.line) ?? smartReadSection(fuContent, fuNewMatch.line, 60))
                  : smartReadSection(fuContent, fuNewMatch.text ?? '', 60);

                const combinedFollowUpContext = fuSection
                  ? `Fragmento ya conocido — ${alreadyReadPath}:\n${cachedFragment}\n\n` +
                    `Fragmento adicional (nueva búsqueda) — ${fuNewMatch.path} (líneas ${fuSection.startLine}-${fuSection.endLine}):\n${fuSection.excerpt}`
                  : `Fragmento ya conocido — ${alreadyReadPath}:\n${cachedFragment}`;

                const fuAnalysis = await generateWithFallback(
                  `El usuario hace una pregunta de seguimiento: "${prompt}"\n\n${combinedFollowUpContext}`,
                  fuSystemPrompt,
                );

                const fuLines = fuAnalysis.split('\n').map((l: string) => l.trim()).filter(Boolean);
                for (const line of fuLines) {
                  send('action', { text: `💡 ${line}` });
                }

                const updatedFastHistory = [
                  ...fastHistory,
                  { role: 'user',      content: prompt,     keywords: fastKeywords },
                  { role: 'assistant', content: fuAnalysis, fragment: combinedFollowUpContext, path: fuNewMatch.path },
                ];
                await saveFastHistory(sessionId!, updatedFastHistory).catch(() => {});
              } else {
                send('action', { text: '💡 Lo que ya vimos no cubre esa parte específica, y no encontré otro archivo relacionado. Reformulá con más detalle o probá DEEP mode para una búsqueda más extensiva.' });
              }
            } catch (fuErr) {
              console.warn('[agent/fu-fallback] búsqueda adicional fallida:', fuErr instanceof Error ? fuErr.message : fuErr);
              send('action', { text: '⚠️ Búsqueda adicional fallida — reformulá la pregunta o probá DEEP mode' });
            }
          }

          send('done', { files: [], commitMessage: '', mainComponent: _lastFastUser?.path ?? '', mainContent: '', repo, branch });
          await new Promise(r => setTimeout(r, 100));
          res.end();
          return;
        }
        // ─────────────────────────────────────────────────────────────────────

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

        // ── FAST fallback hop (único salto condicional) ──────────────────────
        // Si la heurística detecta que el fragmento inicial es insuficiente
        // (declaración de tipo, firma sin cuerpo, muy corto, o keyword solo en 1 línea),
        // hacemos UNA búsqueda adicional con el mismo patrón, descartando el archivo
        // ya leído. El resultado se combina con el fragmento inicial en una sola llamada
        // de síntesis — no es un loop.
        let fallbackSectionText = '';
        let fallbackPath        = '';
        let fallbackStart       = 0;
        let fallbackEnd         = 0;

        if (sectionText && isFragmentInsufficient(sectionText, fastKeywords)) {
          send('action', { text: '🔍 Fragmento inicial incompleto — buscando implementación adicional...' });
          try {
            const { matches: fbMatches } = await searchWithTestFallback(fastPattern, repo, send);
            // Descartar el archivo ya leído y elegir el primer resultado de producción nuevo
            const fbBest = fbMatches.find(
              m => m.path !== readPath && !isTestMatch(m.path, m.text ?? ''),
            );
            if (fbBest) {
              send('action', { text: `📍 Fragmento adicional: ${fbBest.path}${fbBest.line ? `:${fbBest.line}` : ''}` });
              const fbContent = await getFileContent(fbBest.path, repo);
              const fbSection = fbBest.line
                ? (readEnclosingFunction(fbContent, fbBest.line) ?? smartReadSection(fbContent, fbBest.line, 60))
                : smartReadSection(fbContent, fbBest.text ?? '', 60);
              if (fbSection) {
                fallbackSectionText = fbSection.excerpt;
                fallbackPath        = fbBest.path;
                fallbackStart       = fbSection.startLine;
                fallbackEnd         = fbSection.endLine;
              }
            }
          } catch (fbErr) {
            console.warn('[agent/fast-fallback] búsqueda adicional fallida:', fbErr instanceof Error ? fbErr.message : fbErr);
          }
        }

        // Contexto combinado: fragmento inicial + fragmento de respaldo (si existe)
        const combinedContext = fallbackSectionText
          ? `Fragmento principal — ${best.path} (líneas ${sectionStart}-${sectionEnd}):\n${sectionText}\n\n` +
            `Fragmento adicional — ${fallbackPath} (líneas ${fallbackStart}-${fallbackEnd}):\n${fallbackSectionText}`
          : `Fragmento del código en ${best.path} (líneas ${sectionStart}-${sectionEnd}):\n${sectionText}`;

        try {
          const fastAnalysis = await generateWithFallback(
            `El usuario pregunta: "${prompt}"\n\n${combinedContext}`,
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

REGLA DE DOS FRAGMENTOS — cuando se proveen "Fragmento principal" y "Fragmento adicional":
Sintetizá usando ambos. Si se complementan, integralos en la respuesta. \
Si el fragmento principal es solo una declaración de tipo y el adicional muestra la implementación, \
priorizá el adicional para explicar el comportamiento real. No menciones explícitamente que hubo dos búsquedas.

REGLA ANTI-ALUCINACIÓN: Solo afirmá lo que está explícitamente en los fragmentos. \
Si aun con ambos fragmentos no alcanza para responder del todo, decilo en una oración y sugerí DEEP mode.

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

          // Guardar turno en historial de sesión FAST (para follow-ups futuros)
          if (sessionId) {
            const updatedFastHistory = [
              ...fastHistory,
              { role: 'user',      content: prompt,       keywords: fastKeywords },
              { role: 'assistant', content: fastAnalysis,  fragment: combinedContext, path: best.path },
            ];
            await saveFastHistory(sessionId, updatedFastHistory).catch(() => {});
          }
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

      // ── DEEP session continuity — "ver más líneas" / continuación ────────────
      // Si el prompt es un pedido de continuación y hay evidencia previa en sesión,
      // leer directamente el archivo ya identificado sin rehacer el pipeline completo.
      {
        const deepPrev = sessionId ? await loadDeepSession(sessionId) : null;
        const deepCont = isDeepContinuation(prompt);

        if (deepCont.isContinuation && deepPrev) {
          send('action', { text: `📂 DEEP — continuación detectada, leyendo ${deepPrev.path}...` });
          let continuationOk = false;
          try {
            const fullContent = await getFileContent(deepPrev.path, repo);
            const fileLines   = fullContent.split('\n');
            const totalLines  = fileLines.length;

            // Rango: explícito en el prompt o siguiente bloque a partir del fin anterior
            let fromLine = deepCont.fromLine ?? (deepPrev.endLine + 1);
            let toLine   = deepCont.toLine   ?? Math.min(fromLine + 60, totalLines);
            fromLine = Math.max(1, Math.min(fromLine, totalLines));
            toLine   = Math.max(fromLine, Math.min(toLine, totalLines));

            const excerpt = fileLines
              .slice(fromLine - 1, toLine)
              .map((l, i) => `${fromLine + i}: ${l}`)
              .join('\n');

            const citationHeader = `${deepPrev.path}:${fromLine}\n${excerpt}`;
            send('action', { text: `📍 ${deepPrev.path}:${fromLine}-${toLine}` });

            // Actualizar sesión con el nuevo rango para encadenamiento
            if (sessionId) {
              await saveDeepSession(sessionId, { path: deepPrev.path, startLine: fromLine, endLine: toLine }).catch(() => {});
            }

            send('confidence', {
              level: 'high',
              reason: `DEEP mode — cita directa ${deepPrev.path}:${fromLine}-${toLine} (continuación de sesión, sin búsqueda)`,
              suggestedAction: 'chat',
              files: [deepPrev.path],
              diagnosis: citationHeader,
            });
            continuationOk = true;
          } catch {
            send('action', { text: `⚠️ No se pudo leer el archivo — relanzando búsqueda completa...` });
          }

          if (continuationOk) {
            send('done', { files: [], commitMessage: '', mainComponent: deepPrev.path, mainContent: '', repo, branch });
            await new Promise(r => setTimeout(r, 100));
            res.end();
            return;
          }
          // Si falló la lectura directa, cae al pipeline completo
        }
      }
      // ─────────────────────────────────────────────────────────────────────────

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

      // Extract fragments + multi-hop — delegated to shared pipeline so the
      // deep_search tool in Haiku can reuse the exact same logic.
      const deepEvidence = await runDeepSearchPipeline(
        deepMatches,
        deepKeywords.length > 0 ? deepKeywords : deepPattern.split('|').map(t => t.trim()).filter(Boolean),
        repo,
        send,
      );

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

      // Guardar evidencia primaria en sesión DEEP para pedidos de continuación futuros
      if (sessionId && deepEvidence.length > 0) {
        const primary = deepEvidence[0];
        await saveDeepSession(sessionId, {
          path:      primary.path,
          startLine: primary.line,
          endLine:   (primary as any).endLine ?? primary.line + 40,
        }).catch(() => {});
      }

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

// Detecta mensajes puramente sociales/triviales: saludos, agradecimientos,
// confirmaciones vacías, charla genérica. Estos nunca deben disparar NEEDS_TOOLS
// ni escalar a DEEP/Haiku — se responden con un prompt conversacional minimalista.
function isTrivialMessage(message: string): boolean {
  const msg = message.trim();
  // Mensajes muy cortos sin términos técnicos (sin CamelCase, sin acrónimos, sin extensiones)
  if (msg.length < 20 && !/[A-Z]{2,}|[a-z][A-Z]|\.\w{2,4}\b/.test(msg)) {
    // Confirmar que tampoco contiene palabras de dominio técnico
    if (!/\b(error|bug|falla|función|código|archivo|clase|variable|api|endpoint|módulo|import|export)\b/i.test(msg)) {
      return true;
    }
  }
  const TRIVIAL_PATTERNS = [
    // Saludos
    /^(hola|buenas|buen\s?(d[ií]a|tarde|noche)|hey|hi|hello|saludos|qu[eé]\s?tal|c[oó]mo\s?(est[aá]s|va[ns]?|and[aá]s?))[\s!.,?¡¿]*$/i,
    // Agradecimientos y confirmaciones positivas
    /^(gracias|thank(s| you)|ok|okay|okey|perfecto|genial|bien|buenísimo|excelente|entendido|claro|dale|listo|re-?bien|de\s?nada|por\s?nada|con\s?gusto)[\s!.,]*$/i,
    // Confirmaciones simples
    /^(s[ií]|no|tal\s?vez|quiz[aá]s|puede\s?ser|obvio|obvs|claro\s?que\s?s[ií])[\s!.,]*$/i,
    // Cierres de conversación
    /^(eso\s?es\s?todo|nada\s?m[aá]s|por\s?ahora\s?(es\s?todo|nada\s?m[aá]s)|fue\s?todo|chau|cha[ou]|adios|adiós|bye)[\s!.,]*$/i,
    // Expresiones de acuerdo o ánimo
    /^(re\s?bien|muy\s?bien|super|súper|ok\s?ent[eé]nd[ií]|perfecto\s*gracias|gracias\s*perfecto)[\s!.,]*$/i,
  ];
  return TRIVIAL_PATTERNS.some(p => p.test(msg));
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

// ── Tool-result compression ───────────────────────────────────────────────────
// Tool results from closed turns (all except the most recent one) accumulate
// unboundedly across multi-step sessions: a single read_file can be 10 KB, and
// 5 turns × 4 tools = 20 full tool_result blocks re-sent on every API call.
// These functions compress those stale blocks to ~60-char summaries while
// leaving all conversational text (user/assistant messages) completely intact.
//
// Only the LAST user message with tool_result content is kept uncompressed —
// that is the freshest evidence Haiku/Sonnet just gathered and still needs
// verbatim. Everything older is already "used" and can be summarized.
const TOOL_RESULT_COMPRESS_THRESHOLD = 500; // chars — below this, keep as-is

function summarizeToolResult(
  content: string,
  toolInfo?: { name: string; input: Record<string, unknown> },
): string {
  const lines = content.split('\n');
  const lc = lines.length;
  const cc = content.length;
  switch (toolInfo?.name) {
    case 'read_file': {
      const fp =
        (toolInfo.input?.file_path as string) ??
        (toolInfo.input?.path as string) ??
        '?';
      return `[read_file: ~${lc} líneas de ${fp} — comprimido]`;
    }
    case 'grep_code':
    case 'search_code': {
      const pat =
        (toolInfo.input?.pattern as string) ??
        (toolInfo.input?.query as string) ??
        '?';
      const matchCount = lines.filter(l => /^[^:]+:\d+:/.test(l)).length;
      return `[grep_code: ~${matchCount} coincidencias para "${pat}" — comprimido]`;
    }
    case 'list_files':
    case 'list_directory': {
      const dir =
        (toolInfo.input?.path as string) ??
        (toolInfo.input?.directory as string) ??
        '?';
      return `[list_files: ${lc} entradas en ${dir} — comprimido]`;
    }
    default:
      return `[tool_result: ~${cc} chars, ${lc} líneas — comprimido]`;
  }
}

// Returns a shallow-copy of messages with old tool_result blocks compressed.
// Does NOT mutate the original array — the caller's in-memory state stays intact.
function compressOldToolResults(messages: any[]): any[] {
  // Build tool_use_id → {name, input} from all assistant messages
  const toolUseMap = new Map<string, { name: string; input: Record<string, unknown> }>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block.type === 'tool_use') {
          toolUseMap.set(block.id as string, {
            name: block.name as string,
            input: (block.input as Record<string, unknown>) ?? {},
          });
        }
      }
    }
  }

  // Find the index of the LAST user message whose content is a tool_result array.
  // This is the most recent closed turn — keep it uncompressed.
  let lastToolResultIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg.role === 'user' &&
      Array.isArray(msg.content) &&
      (msg.content as any[]).some((b: any) => b.type === 'tool_result')
    ) {
      lastToolResultIdx = i;
      break;
    }
  }

  // Nothing old to compress (0 or 1 tool_result messages total)
  if (lastToolResultIdx <= 0) return messages;

  let compressedChars = 0;
  const result = messages.map((msg, idx) => {
    // Keep most-recent tool_result message and all non-tool-result messages intact
    if (
      idx === lastToolResultIdx ||
      msg.role !== 'user' ||
      !Array.isArray(msg.content) ||
      !(msg.content as any[]).some((b: any) => b.type === 'tool_result')
    ) {
      return msg;
    }

    const compressedContent = (msg.content as any[]).map((block: any) => {
      if (
        block.type !== 'tool_result' ||
        typeof block.content !== 'string' ||
        block.content.length <= TOOL_RESULT_COMPRESS_THRESHOLD
      ) {
        return block;
      }
      compressedChars += block.content.length;
      return {
        ...block,
        content: summarizeToolResult(
          block.content as string,
          toolUseMap.get(block.tool_use_id as string),
        ),
      };
    });

    return { ...msg, content: compressedContent };
  });

  if (compressedChars > 2000) {
    console.log(`[compressOldToolResults] −${compressedChars} chars de tool_results de turnos pasados`);
  }

  return result;
}

function buildTriagePrompt(cacheHint: string): string {
  return `Responde de forma breve y directa, usando SOLO tu conocimiento general — no tienes acceso a herramientas ni al código real del repo.
${cacheHint}
PRIMERA PRIORIDAD — MENSAJES SOCIALES Y CONVERSACIONALES: si el mensaje es un saludo (Hola, Buenas, Hey…), agradecimiento (Gracias, Perfecto, Genial…), confirmación vacía (Ok, Entendido, Dale, Sí, No…), pregunta de cortesía (¿Cómo estás?…) o cualquier otro mensaje sin pregunta técnica real — respondé de forma conversacional, breve y natural. NUNCA retornés "NEEDS_TOOLS" para mensajes puramente sociales. Esta regla tiene prioridad ABSOLUTA sobre todas las demás reglas de este prompt, incluyendo las de trading y dominio.
SOBRE EL CONTEXTO ADICIONAL: si aparece una sección "RESUMEN" o "CONTEXTO ADICIONAL" arriba, ese contenido proviene de una inspección real del código fuente de este mismo repo, hecha por este sistema hace menos de 30 minutos — no es una suposición ni una fuente externa incierta. Tratá esos datos como hechos verificados: usá los nombres exactos que aparecen ahí, no los parafrasees, y no agregues disclaimers como "probablemente", "podría ser" o "esto puede variar" sobre información que ya está confirmada.
REGLA OBLIGATORIA — TÉRMINOS DE TRADING Y DOMINIO:
Si la pregunta menciona cualquier término de dominio de este proyecto — incluyendo pero no limitado a: FVG, imbalance, CHOCH, BOS, EMA, SMA, RSI, MACD, ADX, ATR, SuperTrend, SAR, Score, RVOL, señal, trailing, stop, activación, condición de entrada, o cualquier COMPARACIÓN entre estos conceptos (ej: "diferencia entre X e Y", "cómo funciona X vs Y", "cambiar X por Y") — debés responder ÚNICAMENTE con "NEEDS_TOOLS: " seguido de una razón breve, SALVO que la respuesta exacta a esa pregunta específica ya esté transcripta literalmente en el cacheHint o historial arriba (no basta con que el término aparezca — debe estar la respuesta real).
NUNCA completes con tu conocimiento genérico de trading/finanzas para preguntas sobre estos términos — el comportamiento de FVG, imbalance, EMA, Score, etc. en ESTE proyecto es específico del código real, no una definición estándar. Usar una definición genérica cuando el proyecto puede tener una implementación distinta es un error crítico.
Ejemplos que SIEMPRE resultan en NEEDS_TOOLS (aunque la pregunta parezca conceptual):
- "¿Cuál es la diferencia entre FVG e imbalance?" → NEEDS_TOOLS: necesito leer el código para ver cómo este proyecto los distingue
- "¿Cómo funciona el EMA aquí?" → NEEDS_TOOLS: depende de la implementación específica del repo
- "¿Qué es el Score en este bot?" → NEEDS_TOOLS: salvo que el cacheHint lo explique con detalle
- "Explicame el SuperTrend vs SAR" → NEEDS_TOOLS: comparación de implementaciones específicas
IMPORTANTE: si la pregunta es sobre algo ESPECÍFICO de este proyecto (nombres de agentes/componentes propios, funciones particulares, arquitectura específica de este repo) y NO tenés ese dato exacto en el contexto de arriba, NO completes con conocimiento genérico de IA/programación — responde ÚNICAMENTE con "NEEDS_TOOLS: " seguido de una razón breve.
Si la pregunta es genuinamente genérica (conceptos estándar de programación, definiciones de libro de texto que NO dependan de la implementación de este proyecto) SÍ podés responder normal, sin ese prefijo.
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

// Tracks which sessions have previously escalated to the Haiku tier.
// Used to implement session continuity: follow-up turns in a session that already
// used Haiku skip classifyComplexity and go directly to Haiku, preventing
// domain-specific follow-up questions from being incorrectly classified as "simple"
// and falling back to Groq (which lacks trading-domain knowledge).
const SESSION_HAIKU_USED = new Map<string, number>(); // sessionId → lastUsedAt timestamp

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

// ── FAST mode: heurística de fragmento insuficiente ───────────────────────────
// Pure check — sin llamada a modelo. Retorna true cuando el fragmento extraído
// parece insuficiente para responder la pregunta:
//   1. Muy corto (< 8 líneas de contenido real).
//   2. Declaración pura de tipo/interfaz sin cuerpo de función.
//   3. Firma de función sin bloque de apertura (estilo .d.ts).
//   4. Las keywords originales aparecen en ≤ 1 línea (hit fuera de la implementación).
function isFragmentInsufficient(sectionText: string, originalKeywords: string[]): boolean {
  // Strip line-number prefixes («123: code») to get raw source
  const raw = sectionText.replace(/^\d+:\s*/mg, '').trim();
  const allLines   = raw.split('\n');
  const contentLines = allLines.filter(l => l.trim().length > 0);

  // 1. Demasiado corto
  if (contentLines.length < 8) return true;

  // 2. Declaración de tipo/interfaz sin cuerpo de función
  const codeLines  = contentLines.filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l));
  const firstCode  = codeLines[0] ?? '';
  const isTypeDecl = /^\s*(export\s+)?(interface|type)\s+\w/.test(firstCode);
  // «cuerpo de función» = flecha con apertura de bloque, palabra clave function, o
  // asignación de función: const foo = (async) (...) { / (...): ReturnType {
  const hasFuncBody =
    /\bfunction\s+\w|\)\s*=>\s*\{|async\s+function/.test(raw) ||
    /=\s*(async\s*)?\([^)]*\)\s*(?::\s*[\w<>[\], |]+\s*)?\{/.test(raw);
  if (isTypeDecl && !hasFuncBody) return true;

  // 3. Firma de función sin bloque de apertura (declaration-only)
  const hasFuncSignature =
    /\bfunction\s+\w+\s*\(|const\s+\w+\s*=\s*(async\s*)?\(/.test(raw);
  const hasBodyBrace = /\)\s*(?::\s*[\w<>[\]|, ]+\s*)?\{/.test(raw);
  if (hasFuncSignature && !hasBodyBrace) return true;

  // 4. Las keywords de búsqueda aparecen en ≤ 1 línea del fragmento
  //    (ripgrep localizó un call site aislado, no la implementación real)
  if (originalKeywords.length > 0) {
    const escaped = originalKeywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const kwRe    = new RegExp(`\\b(${escaped.join('|')})\\b`, 'i');
    const kwLines = contentLines.filter(l => kwRe.test(l));
    if (kwLines.length <= 1) return true;
  }

  return false;
}

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
    // 5. PascalCase identifiers with Test/Mock/Debug/Stub as an EMBEDDED capitalized word
    //    (not just a prefix). Catches: TrailingStopTestResult, CheckSignalMockData,
    //    OrderDebugHelper, etc. — but NOT placeTrailingStop (starts lowercase) or
    //    TrailingStop (no embedded test word).
    //    Applied to every PascalCase token found in matchText so it works on both bare
    //    symbol names (fuzzy index lookup) and full matched lines (ripgrep output).
    if (/\b[A-Z][a-zA-Z]*(?:Test|Mock|Debug|Stub)(?:[A-Z][a-zA-Z]*)?\b/.test(matchText)) return true;
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

  // Build accurate test-function line ranges for production files that had
  // text-based test anchors (i.e. isTestMatch fired on the function NAME, not
  // just the file path). We read each such file once and use readEnclosingFunction
  // to get the EXACT start/end of each test function — this lets the retry filter
  // matches that fall inside a test function body in a mixed production file,
  // which --glob path exclusions cannot do (they operate at file granularity).
  //
  // Falls back to a ±120-line proximity window if brace-matching fails or the
  // file cannot be read — conservative enough to avoid false-exclusions.
  const FALLBACK_RADIUS = 120;
  const anchorsByFile = new Map<string, number[]>(); // file → declaration lines
  for (const m of test) {
    if (!m.line) continue;
    if (isTestMatch('', m.text)) { // '' path → fires only on text-based heuristics
      const anchors = anchorsByFile.get(m.path) ?? [];
      anchors.push(m.line);
      anchorsByFile.set(m.path, anchors);
    }
  }

  // Resolve exact function ranges by reading each anchored file once (parallel).
  const testRangesByFile = new Map<string, Array<{ start: number; end: number }>>();
  await Promise.allSettled(
    [...anchorsByFile.entries()].map(async ([filePath, anchorLines]) => {
      try {
        const content = await getFileContent(filePath, repo);
        const ranges: Array<{ start: number; end: number }> = [];
        for (const anchor of anchorLines) {
          const section = readEnclosingFunction(content, anchor);
          if (section) {
            ranges.push({ start: section.startLine, end: section.endLine });
            send('action', { text: `🔎 Rango test resuelto: ${filePath}:${section.startLine}-${section.endLine}` });
          } else {
            ranges.push({ start: anchor, end: anchor + FALLBACK_RADIUS });
          }
        }
        testRangesByFile.set(filePath, ranges);
      } catch {
        // File unreadable — fall back to proximity window from anchor lines
        const ranges = anchorLines.map(a => ({ start: a, end: a + FALLBACK_RADIUS }));
        testRangesByFile.set(filePath, ranges);
      }
    }),
  );

  // All first-pass results are test/dev — retry with ripgrep glob exclusions
  // so test directories are skipped at the OS level (faster, avoids cap issues).
  send('action', { text: '🔄 Solo resultados de test — reintentando con exclusión de rutas de test...' });
  const retry = await unifiedGrepSearch(pattern, repo, send, { excludeTestPaths: true });

  const retryProd = retry.filter(m => {
    // Check 1: file path + matched line text (catches test files and test declarations)
    if (isTestMatch(m.path, m.text)) return false;
    // Check 2: line-level — discard matches that fall inside a resolved test function
    //   range (exact boundaries from readEnclosingFunction, or fallback ±window).
    //   This handles lines inside the body of testFoo() that don't look like test code
    //   by themselves (e.g. `placeTrailingStop(order)` inside testTrailingStopCoexistence).
    if (m.line) {
      const ranges = testRangesByFile.get(m.path);
      const hit = ranges?.find(r => m.line! >= r.start && m.line! <= r.end);
      if (hit) {
        console.log(`[searchWithTestFallback] retry ${m.path}:${m.line} dentro de función test [${hit.start}-${hit.end}], descartado`);
        return false;
      }
    }
    return true;
  });

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

      // word[i]!? OP (?word[i-N]  — tolerates TS non-null assertion and optional open-paren
      const OFFSET_CMP_FORWARD = /\b\w+\s*\[\s*(\w+)\s*\]!?\s*[><=!]{1,3}\s*\(?\s*\w+\s*\[\s*\1\s*-\s*\d+\s*\]/;
      // word[i-N]!? OP (?word[i]  — same tolerances for reverse form
      const OFFSET_CMP_REVERSE = /\b\w+\s*\[\s*(\w+)\s*-\s*\d+\s*\]!?\s*[><=!]{1,3}\s*\(?\s*\w+\s*\[\s*\1\s*\]/;
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

  // Dedup: distintos alias del query (trailingStop, TRAILING_STOP, trailing_stop)
  // pueden resolver al mismo símbolo real. Sin esto, runDeepSearchPipeline procesa
  // el mismo fragmento N veces — una por cada alias que matcheó el mismo símbolo.
  if (symbolMatches.length > 1) {
    const seenSymbols = new Map<string, { term: string; sym: SymbolMatch }>();
    for (const m of symbolMatches) {
      const key = `${m.sym.filePath}:${m.sym.lineNumber}`;
      if (!seenSymbols.has(key)) seenSymbols.set(key, m);
    }
    const deduped = [...seenSymbols.values()];
    if (deduped.length < symbolMatches.length) {
      console.log(`[unifiedGrepSearch] dedup: ${symbolMatches.length} → ${deduped.length} símbolo(s) único(s)`);
    }
    symbolMatches.length = 0;
    symbolMatches.push(...deduped);
  }

  if (symbolMatches.length > 0) {
    // Fix 2: partition production vs test BEFORE sorting by length.
    // Without this, TrailingStopTestResult (longer name) beats placeTrailingStop
    // because the length sort runs first and picks the wrong winner.
    // isTestMatch covers: test file paths, camelCase prefixes (existing rules),
    // AND PascalCase embedded words like TrailingStop*Test*Result (new rule 5).
    const isTestCandidate = (m: { term: string; sym: SymbolMatch }) =>
      isTestMatch(m.sym.filePath) || isTestMatch('', m.term);
    // Desempate dentro de cada grupo: funciones primero, luego longitud.
    // Racional: la pregunta del usuario suele buscar el comportamiento (función),
    // no la config que lo activa (constante/variable). Longitud sigue siendo el
    // desempate final entre símbolos del mismo tipo (ej. dos funciones).
    const SYMBOL_TYPE_PRIORITY: Record<string, number> = {
      function: 0,
      method:   1,
      class:    2,
      interface: 3,
      type:     4,
      constant: 5,
      variable: 6,
    };
    const typeRank = (sym: SymbolMatch) => SYMBOL_TYPE_PRIORITY[sym.symbolType ?? ''] ?? 99;
    const byTypeAndLength = (
      a: { term: string; sym: SymbolMatch },
      b: { term: string; sym: SymbolMatch },
    ) => {
      const typeDiff = typeRank(a.sym) - typeRank(b.sym);
      if (typeDiff !== 0) return typeDiff;
      return b.term.length - a.term.length; // length tiebreaker within same type
    };
    const prodCandidates = symbolMatches.filter(m => !isTestCandidate(m)).sort(byTypeAndLength);
    const testCandidates = symbolMatches.filter(m =>  isTestCandidate(m)).sort(byTypeAndLength);
    // Production-first; when excludeTestPaths is active, drop test candidates entirely.
    const ranked = options?.excludeTestPaths
      ? prodCandidates
      : [...prodCandidates, ...testCandidates];

    if (ranked.length > 0) {
      // Fix 3: return up to 3 candidates instead of collapsing to the single best.
      // This gives searchWithTestFallback real data to partition on the first pass,
      // so it doesn't have to rely solely on the retry to surface production results.
      const TOP_N = 3;
      const top = ranked.slice(0, TOP_N);
      send('action', { text: `⚡ Símbolo(s) en índice: ${top.map(m => `${m.sym.filePath.split('/').pop()}:${m.sym.lineNumber} ("${m.term}")`).join(' | ')}` });
      return top.map(m => ({ path: m.sym.filePath, line: m.sym.lineNumber, text: m.term, symbolType: m.sym.symbolType }));
    }
    // All symbol_index hits were test paths and excludeTestPaths is active
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

// ── runDeepSearchPipeline ─────────────────────────────────────────────────────
// Shared between the DEEP route handler and the deep_search tool exposed to Haiku.
// Accepts pre-ranked GrepMatch results and a list of query terms (already expanded
// by the caller), extracts full enclosing-function fragments with BUG-2 validation,
// annotates trading patterns, and follows up to maxHops call-chain hops.
async function runDeepSearchPipeline(
  matches: GrepMatch[],
  queryTerms: string[],
  repo: string,
  send: (event: string, data: Record<string, unknown>) => void,
  maxHops = 2,
  showRawPreview = true,
): Promise<{ path: string; line: number; endLine: number; fragment: string }[]> {
  // Extract literal fragments — no AI, no interpretation
  const deepEvidence: { path: string; line: number; endLine: number; fragment: string }[] = [];
  for (const match of matches.slice(0, 5)) {
    try {
      const fc = await getFileContent(match.path, repo);
      let section = match.line
        ? (readEnclosingFunction(fc, match.line) ?? smartReadSection(fc, match.line, 60))
        : (match.text ? smartReadSection(fc, match.text, 60) : null);
      if (!section) continue;

      const symbolTerms = queryTerms.length > 0 ? queryTerms : [];
      let symbolFound = symbolTerms.some(t => t.length > 2 && section!.excerpt.toLowerCase().includes(t.toLowerCase()));

      if (!symbolFound && match.line) {
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

      const { annotatedFragment, notes: patternNotes } = annotateTradingPatterns(
        section.excerpt, section.startLine, match.path,
      );
      for (const note of patternNotes) send('action', { text: `🔍 ${note}` });
      deepEvidence.push({ path: match.path, line: section.startLine, endLine: section.endLine, fragment: annotatedFragment });
      if (showRawPreview) {
        send('action', { text: `📌 ${match.path}:${section.startLine}-${section.endLine}` });
        const preview = section.excerpt.split('\n').slice(0, 20);
        for (const fl of preview) send('action', { text: fl });
      } else {
        send('action', { text: `📌 Evidencia leída — ${match.path}` });
      }
    } catch { /* skip unfetchable files */ }
  }

  // ── Multi-hop: follow call chains up to maxHops extra steps ──────────────────
  {
    const CALL_RE = /\b(?:await\s+)?([a-zA-Z_][a-zA-Z0-9_]{3,})\s*\(/g;
    const BUILTINS = new Set([
      'if','for','while','switch','return','const','let','var','new','typeof',
      'instanceof','async','await','function','class','import','export','default',
      'throw','catch','try','super','this','void','null','true','false','undefined',
      'console','Math','Object','Array','Promise','JSON','parseInt','parseFloat',
      'String','Number','Boolean','Date','Set','Map','Error','Symbol','fetch',
      'setTimeout','setInterval','clearTimeout','clearInterval','require',
    ]);
    const relevanceSet = new Set<string>(queryTerms.map(t => t.toLowerCase()));
    const triedSymbols = new Set<string>(relevanceSet);

    const MIN_OVERLAP = 4;
    const isRelevant = (symLower: string): boolean => {
      for (const kw of relevanceSet) {
        if (kw.length < MIN_OVERLAP || symLower.length < MIN_OVERLAP) continue;
        const shorter = kw.length <= symLower.length ? kw : symLower;
        const longer  = kw.length <= symLower.length ? symLower : kw;
        for (let l = shorter.length; l >= MIN_OVERLAP; l--) {
          if (longer.includes(shorter.slice(0, l))) return true;
        }
      }
      return false;
    };

    const stripLineComments = (src: string): string =>
      src.split('\n').map(line => {
        const withoutLineNum = line.replace(/^(\s*)(\d+:\s*)/, '$1');
        const trimmed = withoutLineNum.replace(/^\s*/, '');
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return '';
        const inlineIdx = withoutLineNum.indexOf('//');
        if (inlineIdx < 0) return line;
        const prefixLen = line.length - withoutLineNum.length;
        return line.slice(0, prefixLen + inlineIdx);
      }).join('\n');

    const DEF_SYM_RE = /(?:^|\n)\s*(?:\d+:\s*)?(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_][a-zA-Z0-9_]{3,})\s*\(|(?:^|\n)\s*(?:\d+:\s*)?(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_][a-zA-Z0-9_]{3,})\s*=/;

    let hopStart = 0;
    for (let hop = 0; hop < maxHops; hop++) {
      const scanSlice = deepEvidence.slice(hopStart);
      hopStart = deepEvidence.length;

      const candidates = new Map<string, number>();
      for (const ev of scanSlice) {
        const defM = ev.fragment.match(DEF_SYM_RE);
        const evDefSymLower = defM ? (defM[1] ?? defM[2] ?? '').toLowerCase() : '';
        const codeOnly = stripLineComments(ev.fragment);
        CALL_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = CALL_RE.exec(codeOnly)) !== null) {
          const sym = m[1];
          const symLower = sym.toLowerCase();
          if (BUILTINS.has(sym) || triedSymbols.has(symLower)) continue;
          if (evDefSymLower && symLower === evDefSymLower) continue;
          if (isRelevant(symLower)) {
            candidates.set(sym, (candidates.get(sym) ?? 0) + 1);
          }
        }
      }

      if (candidates.size === 0) {
        // Strategy 2: caller search
        let callerFound = false;
        for (const ev of scanSlice) {
          const defM = ev.fragment.match(
            /(?:^|\n)\s*(?:\d+:\s*)?(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_][a-zA-Z0-9_]{3,})\s*\(|(?:^|\n)\s*(?:\d+:\s*)?(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_][a-zA-Z0-9_]{3,})\s*=/
          );
          const defSym = defM ? (defM[1] ?? defM[2]) : null;
          if (!defSym) continue;
          const defSymLower = defSym.toLowerCase();
          if (triedSymbols.has(defSymLower)) continue;
          triedSymbols.add(defSymLower);

          send('action', { text: `🔗 Salto ${hop + 1} (call site de "${defSym}")…` });
          try {
            const callerRaw = await rgSearch(`\\b${defSym}\\s*\\(`, repo);
            const callerProd = callerRaw.filter(h =>
              !isTestMatch(h.path, h.text) &&
              !(h.path === ev.path && h.line >= ev.line && h.line <= ev.endLine)
            );
            const callerMatch = callerProd[0];
            if (!callerMatch?.line) continue;

            const fc = await getFileContent(callerMatch.path, repo);
            let section = readEnclosingFunction(fc, callerMatch.line)
              ?? smartReadSection(fc, callerMatch.line, 60);
            if (!section) continue;

            if (!section.excerpt.toLowerCase().includes(defSymLower)) {
              const fallback = smartReadSection(fc, callerMatch.line, 50);
              if (!fallback || !fallback.excerpt.toLowerCase().includes(defSymLower)) {
                send('action', { text: `⚠️ Salto ${hop + 1}: call site de "${defSym}" no confirmado en fragmento, descartado` });
                continue;
              }
              section = fallback;
            }

            relevanceSet.add(defSymLower);
            const { annotatedFragment, notes: hopNotes } = annotateTradingPatterns(
              section.excerpt, section.startLine, callerMatch.path,
            );
            for (const note of hopNotes) send('action', { text: `🔍 ${note}` });
            deepEvidence.push({ path: callerMatch.path, line: section.startLine, endLine: section.endLine, fragment: annotatedFragment });
            if (showRawPreview) {
              send('action', { text: `📌 [hop ${hop + 1}↑] ${callerMatch.path}:${section.startLine}-${section.endLine}` });
              const preview = section.excerpt.split('\n').slice(0, 20);
              for (const fl of preview) send('action', { text: fl });
            } else {
              send('action', { text: `📌 Evidencia leída [hop ${hop + 1}↑] — ${callerMatch.path}` });
            }
            callerFound = true;
            break;
          } catch { /* skip if file unreadable */ }
        }
        if (!callerFound) break;
        continue;
      }

      const [bestSym] = [...candidates.entries()].sort((a, b) => b[1] - a[1])[0];
      const bestSymLower = bestSym.toLowerCase();
      triedSymbols.add(bestSymLower);

      send('action', { text: `🔗 Salto ${hop + 1}: buscando "${bestSym}"…` });
      try {
        const hopMatches = await unifiedGrepSearch(bestSym, repo, send);
        const prodMatches = hopMatches.filter(h => !isTestMatch(h.path, h.text));
        const bestMatch = (prodMatches.length > 0 ? prodMatches : hopMatches)[0];
        if (!bestMatch) continue;

        const fc = await getFileContent(bestMatch.path, repo);
        let section = bestMatch.line
          ? (readEnclosingFunction(fc, bestMatch.line) ?? smartReadSection(fc, bestMatch.line, 60))
          : null;
        if (!section) continue;

        if (!section.excerpt.toLowerCase().includes(bestSymLower)) {
          const fallback = bestMatch.line ? smartReadSection(fc, bestMatch.line, 50) : null;
          if (!fallback || !fallback.excerpt.toLowerCase().includes(bestSymLower)) {
            send('action', { text: `⚠️ Salto ${hop + 1}: "${bestSym}" no confirmado en fragmento, descartado` });
            continue;
          }
          section = fallback;
        }

        relevanceSet.add(bestSymLower);
        const { annotatedFragment, notes: hopNotes } = annotateTradingPatterns(
          section.excerpt, section.startLine, bestMatch.path,
        );
        for (const note of hopNotes) send('action', { text: `🔍 ${note}` });
        deepEvidence.push({ path: bestMatch.path, line: section.startLine, endLine: section.endLine, fragment: annotatedFragment });
        if (showRawPreview) {
          send('action', { text: `📌 [hop ${hop + 1}] ${bestMatch.path}:${section.startLine}-${section.endLine}` });
          const preview = section.excerpt.split('\n').slice(0, 20);
          for (const fl of preview) send('action', { text: fl });
        } else {
          send('action', { text: `📌 Evidencia leída [hop ${hop + 1}] — ${bestMatch.path}` });
        }
      } catch { /* skip if file unreadable */ }
    }
  }
  // ── end multi-hop ─────────────────────────────────────────────────────────────

  return deepEvidence;
}

// ── deep_search / DEEP pre-fetch helpers ─────────────────────────────────────

/**
 * Returns true when deep_search evidence is too thin to be useful:
 * - 0 fragments extracted, OR
 * - ≤2 fragments and none of them contain a real implementation body
 *   (only type/interface declarations like `adx: number` in an interface).
 * Detects implementation by looking for control flow, arrow function bodies,
 * logical operators, or array-method calls — all absent from pure type declarations.
 */
function isEvidenceSparse(evidence: { fragment: string }[]): boolean {
  if (evidence.length === 0) return true;
  if (evidence.length > 2) return false;
  const hasImplementation = (fragment: string): boolean =>
    /\b(if|for|while|switch|return\s+\w|await\s+\w|new\s+\w)\b/.test(fragment) ||
    /=>\s*\{/.test(fragment) ||
    /[|&]{2}/.test(fragment) ||
    /\.(map|filter|reduce|forEach|find|some|every)\s*\(/.test(fragment);
  return evidence.every(e => !hasImplementation(e.fragment));
}

/**
 * Extracts technical search keywords from a natural-language user message for
 * use in the Groq→DEEP pre-fetch path. Picks:
 * - Uppercase acronyms 2–6 chars (ADX, EMA, FVG, CHOCH, RSI, RVOL, …)
 * - camelCase/PascalCase identifiers (trailingStop, calcScore, …)
 * Returns at most 4 terms.
 */
function extractKeywordsFromMessage(message: string): string[] {
  const acronyms = message.match(/\b[A-Z]{2,6}\b/g) ?? [];
  const camel    = message.match(/\b[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]+\b/g) ?? [];
  return [...new Set([...acronyms, ...camel])].slice(0, 4);
}

/**
 * Given the original query terms (e.g. ["ADX"]), generates alternative
 * search terms for the internal deep_search retry pass:
 * - Common function prefixes: calculateAdx, computeAdx, getAdx, …
 * - CONSTANT_CASE: ADX_PERIOD, ADX_VALUE
 * - Common value/signal suffixes for short acronyms: adxValue, adxSignal
 * Returns at most 6 new terms (does not include the originals).
 */
function reformulateQueryTerms(originalTerms: string[]): string[] {
  const PREFIXES = ['calculate', 'compute', 'get', 'build', 'run', 'update', 'check', 'process'];
  const added = new Set<string>();
  for (const term of originalTerms) {
    const lo  = term.toLowerCase();
    const cap = lo.charAt(0).toUpperCase() + lo.slice(1);
    for (const prefix of PREFIXES) added.add(`${prefix}${cap}`);
    added.add(term.toUpperCase());
    if (term.length <= 5) {
      added.add(`${lo}Value`);
      added.add(`${lo}Signal`);
      added.add(`${lo}Period`);
    }
  }
  const origSet = new Set(originalTerms.map(t => t.toLowerCase()));
  return [...added].filter(t => !origSet.has(t.toLowerCase())).slice(0, 6);
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
    let allTest = false;
    try {
      ({ matches, allTest } = await searchWithTestFallback(input.pattern, repo, send));
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
    const lines = matches.map(m => {
      if (m.symbolType) return `${m.path} — línea ${m.line}: [${m.symbolType}] "${m.text}"`;
      if (m.line) return `${m.path} — línea ${m.lineApprox ? '~' : ''}${m.line}: "${m.text}"`;
      return `${m.path} — "${m.text}"`;
    });
    // Warn Haiku when every result is test/dev code — it should surface this to
    // the user rather than treating test symbols as production implementations.
    if (allTest) {
      lines.push(`\n⚠️ Todos los resultados encontrados corresponden a archivos o funciones de test/dev. No se encontró implementación de producción para "${input.pattern}". Indicale al usuario que solo existe evidencia de test.`);
    }
    return lines.join('\n');
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
  if (name === 'deep_search') {
    const query: string = input.query ?? '';
    if (!query.trim()) return 'deep_search: query vacío — pasá al menos un identificador técnico.';
    // Emit a dedicated event so the UI can render a distinct "DEEP active" badge.
    send('deep_search', { query });
    const queryTerms = query.split('|').map((t: string) => t.trim()).filter(Boolean);

    // Shared search+extract helper — used for both attempt 1 and internal retry.
    type DeepEvidence = { path: string; line: number; endLine: number; fragment: string };
    const deepAttempt = async (
      q: string,
      terms: string[],
    ): Promise<{ matches: GrepMatch[]; evidence: DeepEvidence[] }> => {
      const result = await searchWithTestFallback(q, repo, send);
      if (result.matches.length === 0) return { matches: [], evidence: [] };
      const prod   = result.matches.filter(m => !isTestMatch(m.path, m.text));
      const ranked = prod.length > 0 ? prod : result.matches;
      if (prod.length === 0) {
        send('action', { text: '⚠️ deep_search — solo resultados de test/dev. Ampliando a todos los matches.' });
      }
      return { matches: ranked, evidence: await runDeepSearchPipeline(ranked, terms, repo, send, 2, false) };
    };

    // ── Attempt 1 ────────────────────────────────────────────────────────────
    let matches: GrepMatch[] = [];
    let evidence: DeepEvidence[] = [];
    try {
      ({ matches, evidence } = await deepAttempt(query, queryTerms));
    } catch (e: any) {
      if (e.message === 'GITHUB_RATE_LIMIT') {
        return `deep_search: rate limit de GitHub. Esperá ~1 min y reintentá, o usá grep_code directamente.`;
      }
      throw e;
    }

    // ── Attempt 2 — internal retry when evidence is sparse ───────────────────
    // If attempt 1 returned 0 fragments or only type/interface declarations
    // (no real implementation body, e.g. `adx: number` in an interface), retry
    // with reformulated query terms before returning control to Haiku.
    // This keeps the retry on the cheap Gemini/DEEP path instead of forcing
    // Haiku to iterate its own grep_code/read_file loop with Claude.
    if (isEvidenceSparse(evidence)) {
      const retryTerms = reformulateQueryTerms(queryTerms);
      if (retryTerms.length > 0) {
        const retryQuery = retryTerms.join('|');
        send('action', { text: `🔄 deep_search — evidencia escasa (${evidence.length} fragmento(s)), reintentando con variantes: ${retryTerms.slice(0, 3).join(', ')}…` });
        send('deep_search', { query: retryQuery });
        try {
          const a2 = await deepAttempt(retryQuery, [...queryTerms, ...retryTerms]);
          if (a2.evidence.length > evidence.length) {
            evidence = a2.evidence;
            if (matches.length === 0) matches = a2.matches;
          } else if (matches.length === 0) {
            matches = a2.matches; // retain for the error message even if BUG-2 still fails
          }
        } catch { /* non-fatal — proceed with attempt 1 results */ }
      }
    }

    // ── Final result ──────────────────────────────────────────────────────────
    if (matches.length === 0) {
      return `deep_search: sin resultados para "${query}". Reformulá con el nombre exacto de la función o variable (camelCase), o probá con grep_code para variantes alternativas.`;
    }
    if (evidence.length === 0) {
      return `deep_search: ${matches.length} match(es) encontrado(s) pero ningún fragmento superó la validación BUG-2 (símbolo no aparece en el fragmento extraído). Intentá con grep_code + read_file más específicos.`;
    }
    const summary = evidence.map(e => `${e.path}:${e.line}\n${e.fragment}`).join('\n\n---\n\n');
    send('action', { text: `✅ deep_search — ${evidence.length} fragmento(s) extraído(s)` });
    return summary;
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

  • Si hay "CONTEXTO YA INVESTIGADO RECIENTEMENTE":
    son paths reales de archivos explorados hace menos de 30 min en este mismo repo.
    Tratálos con la misma prioridad que la evidencia de DEEP/FAST:
    → Si los archivos listados cubren la pregunta: usá read_file directo sobre esos paths, sin grep_code.
    → Si cubren parcialmente: leé solo los archivos relevantes del listado y evitá re-buscar lo ya encontrado.
    → PROHIBIDO ignorar este bloque y lanzar grep_code desde cero cuando los paths ya están disponibles.

Si la evidencia existente responde la pregunta completamente, pasá directo a la síntesis (ver ROL).

━━━ PROCESO DE BÚSQUEDA (solo si el Paso 0 no alcanzó) ━━━

HERRAMIENTA PRIMARIA — usá deep_search para cualquier investigación nueva de código:
  deep_search(query: "sym1|sym2|sym3") ejecuta en una sola llamada: symbol_index + extracción \
  de función completa + multi-hop caller/callee + anotación de patrones. \
  Reemplaza el ciclo grep_code → read_file → grep_code → ... por UNA sola llamada consolidada. \
  El resultado llega en el mismo formato que la evidencia DEEP — aplica el PASO 0 directamente.

VARIANTES DE DOMINIO — generá 3-5 antes de llamar a deep_search, NO buscás el término literal:
   - camelCase (ej: "trailing stop" → trailingStop)
   - CONSTANT_CASE (ej: TRAILING_STOP_ENABLED)
   - snake_case (ej: trailing_stop)
   - Jerga del dominio si aplica (en trading: callbackRatio, rangeRate, movingPlan)
   - Sinónimos funcionales cortos (ej: "SL móvil")
  Pasalas todas juntas: deep_search(query: "trailingStop|TRAILING_STOP|trailing_stop|callbackRatio")

HERRAMIENTAS DE FALLBACK — grep_code + read_file solo para:
  - Confirmar que un old_str existe literalmente antes de propose_patch
  - Leer un símbolo relacionado muy puntual que deep_search no cubrió (≤ 15 líneas con read_file)
  - Búsquedas de texto libre (comentarios, strings, no identificadores de código)
  - Listar estructura de directorios (list_files) cuando no sabés en qué archivo buscar

REGLA CRÍTICA — si usás read_file como fallback después de grep_code:
Cuando grep_code devuelva "línea ~N", apuntá directo: start_line: N-20, end_line: N+150 — \
UNA sola llamada. NUNCA leas en bloques secuenciales (1-100, 100-200…). \
Si la función es más larga, ampliá end_line en esa misma llamada.

Si deep_search + fallbacks no encontraron nada, terminá con el texto EXACTO: \
"BÚSQUEDA_SIN_RESULTADOS". No rellenes con conocimiento general que no venga del código real.

━━━ ROL DE HAIKU — síntesis y límites ━━━
Una vez que tenés el código relevante (sea de evidencia previa o de tu búsqueda), \
tu tarea es responder con la información MÁS VALIOSA, de forma COMPRIMIDA — no un reporte exhaustivo.

FORMATO POR DEFECTO — obligatorio salvo que el usuario pida explícitamente más detalle:
  - Máximo 4-5 líneas de prosa conectada en UN SOLO PÁRRAFO. Sin excepciones.
  - PROHIBIDO: preámbulos ("Perfecto, tengo la implementación...", "Voy a sintetizar..."). \
    Arrancá directo con la respuesta.
  - PROHIBIDO: headers (##, **Título**), listas numeradas, bullets, separadores (---), \
    diagramas ASCII. Es UN PÁRRAFO de prosa, no un reporte con secciones.
  - CERO bloques de código.
  - Máximo 2 citas file:línea en total (las 2 más importantes) — NO cites cada afirmación. \
    Nombralas en prosa entre paréntesis, ej: "(autonomousAgent.ts:879)".
  - Cubrí solo lo esencial: qué hace y el dato numérico o condición más importante que lo activa. \
    Omití el flujo paso a paso, los casos límite y el detalle secundario — eso es para el modo expandido.
  - Al final, agregá SIEMPRE esta línea exacta: \
    "💬 Pedime 'más detalle' si querés el desglose completo con código y ejemplos."

EXPANSIÓN — solo si el usuario pide explícitamente más detalle, más contexto, código, \
ejemplos, o dice algo como "explicá más", "dame el detalle", "mostrame el código":
  - Ahí SÍ podés dar la respuesta extendida: secciones, bloques de código, tablas, ejemplos numéricos.
  - Usá el código y los fragmentos que YA tenés en el historial de esta conversación — \
    NO vuelvas a llamar grep_code ni read_file para esto, la evidencia ya está disponible arriba.
  - Si el historial no alcanza para el nivel de detalle pedido, ahí sí podés usar las tools \
    de búsqueda normalmente.

  ✓ PERMITIDO: explicar qué hace el código, cómo funciona, cuáles son sus condiciones,
    describir la causa raíz de un comportamiento, identificar por qué algo sucede.
  ✓ PERMITIDO: si para resolver el problema habría que cambiar algo, decirlo en prosa
    y ofrecer evaluarlo — pero NO escribir el cambio.
  ✗ PROHIBIDO: escribir old_str/new_str, usar propose_patch, o redactar el código del fix.
    Eso es exclusivamente tarea de Sonnet cuando el usuario pide explícitamente un cambio.
  ✗ PROHIBIDO: inferir o afirmar lo que no leíste literalmente en el código.

No inferás lo que no leíste. Citá fragmentos exactos (breves) para respaldar tus afirmaciones, \
incluso en el modo comprimido.

Al sintetizar: usá los nombres técnicos de trading exactos (**FVG**, **EMA**, **SuperTrend**, \
**RSI**, **ADX**, **ATR**, **Score**, etc.) — nunca los parafrasees con lenguaje genérico. \
Aplicá **negrita** a cada término técnico y valor numérico clave.

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
"no pude confirmar qué representa \`[var]\` en este contexto — no la renombro".

━━━ CONOCIMIENTO DE DOMINIO — conceptos de trading técnico ━━━
Este bloque describe conceptos de mercado en general — no afirma nada sobre la implementación \
concreta del repo. Para cualquier afirmación sobre el código real, siempre citá la evidencia leída.

INDICADORES DE TENDENCIA:
  • **EMA** (Exponential Moving Average): media móvil que pondera más las velas recientes. \
    Reacciona más rápido que la SMA a cambios de precio. Se usa para filtrar dirección de tendencia \
    y para cruces de señal (ej: EMA rápida cruza EMA lenta → cambio de momentum).
  • **SMA** (Simple Moving Average): promedio aritmético de N velas. Más lenta que EMA, \
    menos susceptible a ruido, más usada como soporte/resistencia dinámico.
  • **SuperTrend**: indicador de seguimiento de tendencia basado en bandas de ATR alrededor \
    del precio. Devuelve una dirección binaria (alcista/bajista) y un nivel de stop dinámico. \
    IMPORTANTE: NO es SAR (Parabolic Stop and Reverse) — son indicadores distintos con lógica \
    diferente. SuperTrend usa ATR; SAR usa aceleración acumulada. Nunca intercambies sus nombres.
  • **ADX** (Average Directional Index): mide la FUERZA de la tendencia, NO su dirección. \
    Rango 0-100. Convención habitual: < 20 = mercado en rango/lateral; > 25 = tendencia presente; \
    > 40 = tendencia fuerte. Se usa como filtro: solo tomar señales cuando ADX > umbral.

OSCILADORES:
  • **RSI** (Relative Strength Index): oscilador de momentum 0-100. Convención habitual: \
    > 70 = sobrecomprado; < 30 = sobrevendido. Se usa para detectar agotamiento de movimiento \
    y divergencias. Un RSI alto en tendencia alcista no es señal de venta automática — contexto importa.
  • **MACD** (Moving Average Convergence Divergence): diferencia entre dos EMAs (rápida y lenta), \
    más una línea de señal (EMA del MACD). Cruces de MACD sobre su señal → cambios de momentum. \
    El histograma mide la distancia entre MACD y señal.

PATRONES DE ESTRUCTURA DE PRECIO:
  • **FVG** (Fair Value Gap): formación de 3 velas donde hay un gap entre el máximo de la vela \
    [i-2] y el mínimo de la vela [i] (alcista), o entre el mínimo de [i-2] y el máximo de [i] \
    (bajista). Indica que el precio se movió tan rápido que dejó una zona sin operar — el mercado \
    tiende a volver a "llenar" ese gap. Es una formación ESTRUCTURAL y ESPECÍFICA: requiere \
    exactamente esa relación entre velas [i], [i-1] e [i-2].
  • **Imbalance**: concepto más AMPLIO que FVG. Cubre cualquier zona donde la oferta/demanda fue \
    unilateral: puede incluir FVGs, mechas largas de vela única, zonas de alto volumen sin rotación, \
    o cualquier área donde el precio no halló contraparte. \
    DIFERENCIA CLAVE FVG vs. Imbalance: FVG es un subconjunto estricto de imbalance — toda FVG \
    es un imbalance, pero no todo imbalance es una FVG. Reemplazar FVG por imbalance en una señal \
    amplía los casos detectados (más sensibilidad) pero pierde la especificidad estructural de la \
    formación de 3 velas — lo que puede aumentar falsos positivos en mercados ruidosos.
  • **BOS** (Break of Structure): el precio rompe un máximo/mínimo de swing previo EN LA DIRECCIÓN \
    de la tendencia actual. Señal de CONTINUACIÓN — confirma que la tendencia sigue vigente.
  • **CHOCH** (Change of Character): el precio rompe el último máximo/mínimo de swing en DIRECCIÓN \
    OPUESTA a la tendencia. Primera señal de posible REVERSIÓN — no confirma el cambio, pero \
    advierte que el momentum puede estar agotándose. Suele preceder a un BOS en la nueva dirección.
  • DISTINCIÓN BOS vs. CHOCH: BOS ocurre con la tendencia (confirmación); CHOCH ocurre contra \
    ella (alerta de reversión). En código, la diferencia suele estar en si el swing roto es \
    alcista o bajista respecto del contexto de tendencia actual.

VOLATILIDAD:
  • **ATR** (Average True Range): promedio del rango verdadero de N velas (max de: high-low, \
    |high-close anterior|, |low-close anterior|). Mide volatilidad en términos absolutos de precio. \
    Usos típicos: sizing de stops (ej: stop = entrada − 2×ATR), ancho de bandas (SuperTrend), \
    y sizing de posición (riesgo fijo / ATR = tamaño de lote). Un ATR alto indica mercado volátil; \
    un ATR bajo indica compresión — precaución antes de breakouts.

REGLA DE USO: este conocimiento te permite discutir tradeoffs cuando el usuario propone cambios \
de lógica (ej: "¿conviene reemplazar FVG por imbalance?"). Podés opinar con criterio sobre \
qué gana y qué pierde el sistema — pero SIEMPRE aclarando que estás hablando del concepto de \
mercado general, y que cualquier impacto concreto en el código requiere ver la implementación real.`;

const GROQ_SINGLE_FRAGMENT_SYSTEM = `Sos un asistente que explica código de trading a partir de UN fragmento ya confirmado como evidencia real (lectura literal del código fuente, con cita file:línea).

REGLAS:
- Sintetizá en máximo 6-8 líneas de prosa conectada, sin bullets ni bloques de código.
- Usá los nombres técnicos de trading exactos (FVG, EMA, SuperTrend, RSI, ADX, ATR, Score, etc.) — nunca los parafrasees.
- Citá el archivo:línea entre paréntesis para respaldar afirmaciones puntuales, sin pegar el código.
- No inventes nada que no esté literalmente en el fragmento.
- Si el fragmento no alcanza para responder la pregunta completa, decilo en una oración.
- Terminá siempre con esta línea exacta: "💬 Pedime 'más detalle' si querés el desglose completo con código y ejemplos."

VARIABLES DE DOMINIO — convenciones fijas en repos de trading (Signal OS, Ahorar, etc.):
  • \`st\`, \`stDir\`, \`stDirArr\` → dirección del indicador SuperTrend (NO Parabolic SAR — son indicadores distintos, nunca los intercambies).
  • \`sa\`, \`sb\` → Score alcista y Score bajista (índice numérico de momentum/dirección). NUNCA los asocies con "SAR" — son scores.
  • \`fvgBull\`, \`fvgBear\` → FVG (Fair Value Gap) alcista / bajista. Nombralo siempre como FVG, nunca parafrasees.
  • \`noAgot\` → sin agotamiento de momentum (booleano).
  • \`ema\`, \`emaFast\`, \`emaSlow\` → EMA. \`rsi\`/\`rsiVal\` → RSI. \`adx\`/\`adxVal\` → ADX. \`atr\`/\`atrVal\` → ATR.

REGLA ANTI-CONFUSIÓN — variables cortas (\`sa\`, \`sb\`, \`st\`, \`rr\`, \`sl\`, \`tp\`, etc.) tienen alto riesgo de confundirse con acrónimos de trading por parecido visual.
Si una variable corta NO está en la tabla de arriba ni tiene definición visible en el fragmento, escribí exactamente: "no pude confirmar qué representa \`[var]\` en este fragmento — no la renombro."
PROHIBIDO deducir su significado por similitud de nombre.

REGLA DE INCERTIDUMBRE — si el fragmento cubre parcialmente la pregunta (ej: muestra el uso de una variable pero no su cálculo), mencioná explícitamente qué parte quedó sin confirmar antes de la línea de cierre. No omitas la incertidumbre ni completes con conocimiento general.`;

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
        tools: (allowPatch ? CHAT_TOOLS : CHAT_TOOLS.filter(t => t.name !== 'propose_patch' && t.name !== 'apply_patch')).map((t, i, arr) =>
          i === arr.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t
        ),
        // Compress stale tool_result blocks from past turns before sending —
        // keeps the current turn's results intact (last tool_result message).
        messages: compressOldToolResults(messages),
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
  forceGroq = false,
): Promise<void> {
  const history = await loadChatHistory(sessionId);

  // Routing decision — three cases in priority order:
  //
  // 1. forceGroq=true (user pressed "Modo rápido"): force Groq unconditionally.
  //    classifyComplexity is NOT consulted; complexity is pinned to 'simple' so the
  //    Groq triage path runs. If Groq still returns NEEDS_TOOLS, Haiku escalates as
  //    usual — this is intentional and documented UX.
  //
  // 2. Session continuity: if this session previously invoked Haiku (SESSION_HAIKU_USED),
  //    skip classifyComplexity and route directly to Haiku. This prevents domain-specific
  //    follow-up questions (e.g. "diferencia entre FVG e imbalance" after Haiku explained
  //    S6) from being mis-classified as 'simple' and falling back to Groq, which lacks
  //    the repo-specific trading domain context.
  //
  // 3. First message in a new session: run classifyComplexity normally.
  const complexity: 'simple' | 'complex' = forceGroq
    ? 'simple'
    : SESSION_HAIKU_USED.has(sessionId)
      ? 'complex'
      : classifyComplexity(userMessage);

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
    const groqHistory = groqHistoryFromMessages(history);

    // ── Rama trivial: saludo / agradecimiento / charla genérica ─────────────────
    // Detectada antes de llamar al triage de dominio para evitar que un saludo
    // active NEEDS_TOOLS por "falta de contexto del repo". Se responde con Groq
    // pero usando un prompt conversacional minimalista — sin ninguna regla de
    // escalado, sin DEEP, sin Haiku. El usuario no ve ningún action event.
    if (isTrivialMessage(userMessage)) {
      const trivialPrompt = `Sos un asistente de programación. El usuario te está hablando de forma informal o social. Respondé de manera breve, natural y conversacional — sin mencionar herramientas, código ni búsquedas. Si te saludan, saludá de vuelta. Si te agradecen, respondé amablemente.`;
      const trivialAnswer = await callGroqAgent(userMessage, trivialPrompt, 256, groqHistory);
      send('chat_message', { text: trivialAnswer });
      messages.push({ role: 'assistant', content: [{ type: 'text', text: trivialAnswer }] });
      await saveChatHistory(sessionId, messages);
      return;
    }

    send('action', { text: '⚡ Modo rápido — Groq' });
    send('model_active', { model: 'Groq (Llama 3.3 70B)', tier: 'fast' });
    // Convert the stored session history (Anthropic format) to the flat {role, content}
    // array Groq expects — stripping all tool_use / tool_result blocks so Groq only
    // sees the conversational text thread, not the raw code-search internals.
    // `cacheHint` (DEEP evidence, shared summaries) stays in the system prompt as
    // complementary context on top of the real turn history.
    const groqAnswer = await callGroqAgent(
      userMessage,
      buildTriagePrompt(cacheHint),
      fastFinding ? 768 : 512,
      groqHistory,
    );

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
    send('action', { text: `🧠 Groq → ${groqReason.slice(0, 80)} — ejecutando DEEP pre-fetch` });

    // ── DEEP pre-fetch: gather evidence before handing off to Haiku ──────────
    // Extract technical keywords from the user's message and run the DEEP
    // search pipeline (Gemini/cheap) directly — before Haiku (Claude/expensive)
    // gets involved. If evidence is found, it is injected into the messages as
    // "EVIDENCIA VERIFICADA (DEEP mode)" so Haiku's PASO 0 picks it up and
    // synthesizes without re-searching, saving a full Claude exploration loop.
    // This path is non-fatal: any error or empty result falls through to Haiku.
    {
      const baseKws = extractKeywordsFromMessage(userMessage);
      if (baseKws.length > 0) {
        const allKws   = [...baseKws, ...reformulateQueryTerms(baseKws)];
        const deepQ    = allKws.join('|');
        send('deep_search', { query: deepQ });
        send('action', { text: `🔍 DEEP pre-fetch — keywords: ${baseKws.join(', ')}` });
        try {
          const preResult = await searchWithTestFallback(deepQ, repo, send);
          if (preResult.matches.length > 0) {
            const preProd   = preResult.matches.filter(m => !isTestMatch(m.path, m.text));
            const preRanked = preProd.length > 0 ? preProd : preResult.matches;
            const preEv     = await runDeepSearchPipeline(preRanked, allKws, repo, send, 2, false);
            if (preEv.length > 0) {
              const evidenceSummary = preEv.map(e => `${e.path}:${e.line}\n${e.fragment}`).join('\n\n---\n\n');

              // Enrutamiento Groq vs Haiku: 1 fragmento autocontenido + intención de
              // EXPLICACIÓN (no generación de código) → Groq interpreta directo, sin Haiku.
              // 2+ fragmentos (requieren cruzarse) o intención de GENERAR código → sigue a Haiku.
              if (preEv.length === 1 && classifyIntent(userMessage) === 'explain') {
                send('action', { text: '⚡ 1 fragmento autocontenido — Groq interpreta directo (sin Haiku)' });
                try {
                  const groqSynthesis = await callGroqAgent(
                    `Pregunta: "${userMessage}"\n\nEvidencia confirmada (DEEP mode):\n${evidenceSummary}`,
                    GROQ_SINGLE_FRAGMENT_SYSTEM,
                    512,
                  );
                  send('chat_message', { text: groqSynthesis });
                  // Persist the exact file path(s) from preEv in a structured tag so
                  // subsequent Haiku turns can call read_file with the full path instead
                  // of trying to reconstruct it from free-text conversational output.
                  // The tag is stored in DB history only — the user sees only groqSynthesis.
                  const _evPaths = preEv.map(e => e.path).join('\n');
                  const _assistantWithPaths =
                    groqSynthesis + `\n\n<evidence_files>\n${_evPaths}\n</evidence_files>`;
                  messages.push({ role: 'assistant', content: [{ type: 'text', text: _assistantWithPaths }] });
                  await saveChatHistory(sessionId, messages);
                  send('confidence', {
                    level: 'medium',
                    reason: 'CHAT — Groq interpretó 1 fragmento autocontenido de evidencia DEEP',
                    suggestedAction: 'none',
                  });
                  return;
                } catch {
                  send('action', { text: '⚠️ Groq synthesis falló — escalando a Haiku' });
                  // cae al flujo normal (inyecta evidencia y sigue a Haiku)
                }
              }

              const deepCtx =
                `\n\nEVIDENCIA VERIFICADA (DEEP mode — disparado por Groq pre-escalación, ` +
                `lectura real del código fuente). Si esta evidencia responde la pregunta original ` +
                `por completo, sintetizá desde aquí (PASO 0) sin volver a buscar los mismos símbolos:\n` +
                evidenceSummary;
              // Append to the last user message so Haiku's PASO 0 detects it immediately
              const lastMsg = messages[messages.length - 1];
              if (typeof lastMsg?.content === 'string') lastMsg.content += deepCtx;
              send('action', { text: `✅ DEEP pre-fetch — ${preEv.length} fragmento(s) listos para síntesis` });
            } else {
              send('action', { text: `⚠️ DEEP pre-fetch — matches sin fragmentos válidos, Haiku investigará` });
            }
          } else {
            send('action', { text: `⚠️ DEEP pre-fetch — sin resultados para "${baseKws.join('|')}", Haiku investigará` });
          }
        } catch { /* non-fatal — fall through to Haiku as normal */ }
      }
    }
    // All NEEDS_TOOLS cases fall through to the Haiku exploration phase.
    // If DEEP pre-fetch injected evidence, Haiku's PASO 0 uses it directly.
  }

  // ── Haiku exploration phase (ALL paths that need code inspection) ─────────────
  // Classify intent first so we can:
  //   'explain'  → Haiku handles everything end-to-end (search + final answer)
  //   'generate' → Haiku searches/reads, then Sonnet writes the patch
  const intent = classifyIntent(userMessage);
  {
    // Mark this session as having used Haiku so subsequent turns skip classifyComplexity
    // and route directly here, preserving domain context for follow-up questions.
    SESSION_HAIKU_USED.set(sessionId, Date.now());

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
        // Compress stale tool_result blocks from past turns before sending.
        messages: compressOldToolResults(messages),
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

  // Persist compressed history — stale tool_result blocks don't need to be
  // reloaded verbatim in future sessions; summaries are sufficient context.
  await saveChatHistory(sessionId, compressOldToolResults(messages));
}

// ── GET /chat/history/:sessionId ─────────────────────────────────────────────
// Devuelve el historial de la sesión como [{role, text}] para que el frontend
// pueda rehidratar el componente de CHAT al volver a la pestaña.
// Solo se retornan turnos user/assistant — los mensajes de action son eventos
// de UI efímeros y no se almacenan en el backend.
router.get('/chat/history/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  if (!sessionId) { res.status(400).json({ error: 'sessionId required' }); return; }
  try {
    const raw = await loadChatHistory(sessionId);
    // raw entries use the AI SDK format: { role, content: string | Array<{type,text}> }
    const messages = raw
      .filter((m: any) => m.role === 'user' || m.role === 'assistant')
      .map((m: any) => {
        const text = typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
            : String(m.content ?? '');
        return { role: m.role as 'user' | 'assistant', text };
      })
      .filter((m: any) => m.text.trim().length > 0);
    res.json({ messages });
  } catch (err) {
    console.error('[CHAT/history] error:', err);
    res.status(500).json({ error: 'Failed to load history' });
  }
});

router.post('/chat', async (req, res) => {
  const { message, repo: bodyRepo, sessionId, findingId, forceGroq } = req.body as {
    message?: string; repo?: string; sessionId?: string; findingId?: string; forceGroq?: boolean;
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
    await runChatTurn(sessionId, message, repo, send, 20, findingId, forceGroq ?? false);
    send('done', {});
  } catch (err) {
    const stack = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error('[CHAT] error en runChatTurn:', stack);
    send('error', { text: stack });
  }
  res.end();
});

export default router;
