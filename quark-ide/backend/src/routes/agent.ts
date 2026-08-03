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

// ── Archivos críticos por repo — changelog automático ────────────────────────
/**
 * Archivos críticos por repo — cambios en estos disparan auto-resumen de changelog
 * para guardar en repo_knowledge con concept='SYSTEM_CHANGELOG'.
 * Extensible por repo — agregar más rutas según necesidad.
 */
const CRITICAL_FILES_BY_REPO: Record<string, string[]> = {
  'Ahorar': [
    'artifacts/api-server/src/lib/autonomousAgent.ts',
    'artifacts/api-server/src/lib/botEngine.ts',
    'artifacts/api-server/src/lib/signal-indicators.ts',
    'src/lib/tradingLogic.ts',
  ],
  // Agregar más repos conforme sea necesario
};

/**
 * Detecta cambios en archivos críticos desde el último commit y genera un resumen
 * de changelog estructurado. Se llama cada vez que Quark detecta un nuevo deploy/push.
 * Costo: un diff local (git) + una llamada a Groq si hay cambios (síntesis).
 */
export async function generateChangelogSummary(repo: string): Promise<void> {
  const criticalFiles = CRITICAL_FILES_BY_REPO[repo];
  if (!criticalFiles || criticalFiles.length === 0) {
    console.log(`[changelog] repo "${repo}" no tiene archivos críticos configurados`);
    return;
  }

  try {
    let combinedDiff = '';
    for (const filePath of criticalFiles) {
      try {
        const stdout = execSync(
          `git diff HEAD~1 HEAD -- "${filePath}" | head -100`,
          { cwd: process.env.REPO_PATH || '.', encoding: 'utf8' },
        );
        if (stdout.trim().length > 0) {
          combinedDiff += `\n=== ${filePath} ===\n${stdout}`;
        }
      } catch {
        // Archivo no cambió o no existe en ese commit
      }
    }

    if (!combinedDiff.trim()) {
      console.log(`[changelog] no hay cambios en archivos críticos para "${repo}"`);
      return;
    }

    let commitMessage = '(commit message no disponible)';
    try {
      commitMessage = execSync('git log -1 --pretty=%B', {
        cwd: process.env.REPO_PATH || '.',
        encoding: 'utf8',
      }).trim();
    } catch { /* ignore */ }

    const changelogPrompt = `Dado el diff de cambios recientes y el commit message, genera un resumen MUY CONCISO (máx 2-3 líneas cortas) de:
1. Qué función(es) cambiaron
2. Cambio de comportamiento (de X a Y) si es evidente
3. Motivo si el commit message lo explica

DIFF:
\`\`\`
${combinedDiff.substring(0, 2000)}
\`\`\`

COMMIT MESSAGE:
${commitMessage}

Responde SOLO con el resumen (sin preamble), en formato: "archivo.ts: cambio (motivo)".`;

    const summary = await callGroqAgent(
      changelogPrompt,
      'Eres un asistente que resume cambios de código de forma muy concisa y técnica.',
      200,
      [],
    );

    if (summary && summary.trim().length > 0) {
      await saveRepoKnowledge(
        repo,
        'SYSTEM_CHANGELOG',
        summary,
        criticalFiles
          .filter(f => combinedDiff.includes(f))
          .map(f => ({ path: f, startLine: 0, endLine: 0 })),
        'high',
      );
      console.log(`[changelog] "${repo}" — resumen guardado en repo_knowledge`);
    }
  } catch (err) {
    console.warn(
      `[changelog] generación falló para "${repo}":`,
      err instanceof Error ? err.message : err,
    );
  }
}

// ── Estado de investigación por sesión ───────────────────────────────────────
/**
 * Estado de investigación en la sesión actual — detecta multi-turn sobre el
 * mismo concepto para guardar automáticamente como INVESTIGATION_* cuando sea
 * investigación profunda, no búsqueda trivial.
 */
interface InvestigationState {
  topicTerms: Set<string>; // keywords principales (ej. "trailing", "trailingstop")
  turnCount: number;       // cuántas preguntas en la sesión
  turnHistory: Array<{ term: string; timestamp: number }>; // historial de términos
  shouldSave: boolean;     // marcado manualmente con /save o auto-detectado
}

let sessionInvestigationState: InvestigationState = {
  topicTerms: new Set(),
  turnCount: 0,
  turnHistory: [],
  shouldSave: false,
};

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

/**
 * Detección de follow-up más robusta que hasFastTopicOverlap. Combina tres señales:
 *   1. Overlap directo de keywords entre el turno actual y el anterior (comportamiento original).
 *   2. El término técnico del mensaje actual YA aparece literalmente dentro del fragmento
 *      de código que se cacheó en el turno anterior — esto cubre el caso real de bug:
 *      "¿por qué usa el ATR ahí?" después de leer una función que menciona `atr` en su
 *      cuerpo, aunque "ATR" nunca haya sido una keyword de búsqueda del turno anterior.
 *   3. Pregunta corta puramente referencial ("¿por qué?", "¿y eso?", "explicá más") sin
 *      ningún identificador técnico propio — casi siempre se refiere a lo recién discutido.
 */
function isLikelyFollowUp(
  currentTerms: string[],
  userMessage: string,
  lastUser: { keywords?: string[] } | undefined,
  lastAss: { fragment?: string } | undefined,
): boolean {
  if (!lastAss?.fragment) return false;

  // Señal 1 — overlap directo de keywords (comportamiento original, se mantiene)
  if (hasFastTopicOverlap(currentTerms, lastUser?.keywords ?? [])) return true;

  // Señal 2 — el término nuevo ya aparece en el fragmento cacheado
  const fragmentLower = lastAss.fragment.toLowerCase();
  if (currentTerms.some(t => t.length > 2 && fragmentLower.includes(t.toLowerCase()))) {
    return true;
  }

  // Señal 3 — pregunta corta puramente referencial, sin anclaje técnico propio
  const REFERENTIAL_RE = /\b(por qu[eé]|para qu[eé]|y (eso|ah[ií])|ah[ií]|c[oó]mo (es|funciona) eso|explic[aá] m[aá]s|m[aá]s detalle|qu[eé] significa eso)\b/i;
  const hasNoStrongAnchor = currentTerms.length === 0 || currentTerms.every(t => t.length <= 3);
  if (userMessage.trim().length < 60 && REFERENTIAL_RE.test(userMessage) && hasNoStrongAnchor) {
    return true;
  }

  return false;
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
  temperature?: number,
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
          ...(temperature !== undefined ? { temperature } : {}),
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
      const msg = (err as Error).message;
      const promptLen = prompt.length + system.length;
      console.warn(`[agent] Groq key failed (prompt: ~${promptLen} chars): ${msg}`);
    }
  }
  throw new Error(`All Groq keys failed — prompt total: ~${prompt.length + system.length} chars`)
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

// ── Keyword extraction helpers ────────────────────────────────────────────────

const KEYWORD_STOPWORDS = new Set([
  'mostrame', 'muestra', 'muéstrame', 'busca', 'buscá', 'buscar', 'explica', 'explicá',
  'completo', 'resumir', 'interpretar', 'donde', 'dónde', 'como', 'cómo',
  'codigo', 'código', 'archivo', 'funcion', 'función', 'valor', 'analiza', 'analizar',
  'dentro', 'afuera', 'mostrar', 'define', 'definir', 'retorna', 'retornar',
  'devuelve', 'devolver', 'todos', 'todas', 'entre', 'para', 'este', 'esta',
  'desde', 'hasta', 'que', 'qué', 'cual', 'cuál', 'porque', 'porqué',
  // Sustantivos genéricos de dominio UI — nombres de variable/prop comunísimos en
  // cualquier componente de frontend (historyLoading, savedSession, etc.). Sin esto,
  // una pregunta sobre una función de BACKEND que use estas palabras en lenguaje
  // natural ("historial de sesión") termina buscando también en componentes React
  // no relacionados, contaminando la evidencia con matches de dominio equivocado.
  'sesión', 'sesion', 'historial', 'mensaje', 'mensajes', 'usuario', 'usuarios',
  'pantalla', 'botón', 'boton',
]);

/**
 * Fallback local ÚNICO para extracción de keywords. Reemplaza las 3
 * implementaciones divergentes (CHAT ruta rápida, DEEP pre-fetch, toggle DEEP).
 * Orden de prioridad: CAPS_SNAKE_CASE → camelCase → snake_case →
 * identificadores cortos letra+dígito (S1, S6) → palabras largas no-instrucción.
 */
function localKeywordFallback(prompt: string, max = 4): string[] {
  const words = prompt.split(/\s+/);
  const isCapsSnake = (w: string) => /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(w);
  const isCamel     = (w: string) => /^[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]+$/.test(w);
  const isSnake     = (w: string) => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(w);
  const isShortId   = (w: string) => /^[A-Za-z]\d{1,2}$/.test(w); // S1, S6, T2...
  // Acrónimos cortos (SL, TP, RR, EMA, RSI, ATR, ADX...) — 2-5 letras mayúsculas.
  // Sin esto, w.length > 4 los descarta y el término más denso y más
  // importante del dominio de trading queda invisible para cualquier
  // chequeo de grounding aguas abajo.
  const isAcronym   = (w: string) => /^[A-Z]{2,5}$/.test(w.replace(/[?.,;:!]+$/, ''));

  const ranked = [
    ...words.filter(isCapsSnake),
    ...words.filter(isCamel),
    ...words.filter(isSnake),
    ...words.filter(isShortId),
    ...words.filter(isAcronym),
    ...words.filter(w =>
      w.length > 4 &&
      !KEYWORD_STOPWORDS.has(w.toLowerCase()) &&
      !isCapsSnake(w) && !isCamel(w) && !isSnake(w) && !isShortId(w) && !isAcronym(w)
    ),
  ];
  return [...new Set(ranked)].slice(0, max);
}

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
  // Default a 'read' — solo es 'modify' si hay una señal EXPLÍCITA de generación/
  // modificación en el texto (GEN_KEYWORDS). Sin esa señal, cualquier pregunta
  // factual o ambigua (que no matchea ningún verbo conocido) cae en 'read', que
  // es el camino seguro y grounded contra el índice de símbolos.
  const hasGen = GEN_KEYWORDS.test(prompt);
  return !hasGen;
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
    if (cleaned.includes('modify') && !GEN_KEYWORDS.test(prompt)) {
      console.warn(`[classifyIntentWithAI] Groq dijo "modify" pero no hay verbo explícito de generación en el mensaje — forzando "read" (prompt: "${prompt.slice(0, 60)}")`);
      return 'read';
    }
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
  repo: string,
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
      // coincide con un símbolo real del repo, no confiar — forzar search.
      // Repo-agnóstico: usa el índice real de símbolos, no una lista fija.
      const grounding = await isGroundedInRepoSymbols(prompt, repo);
      if (grounding.grounded) {
        console.warn(`[classifyAndRespondFast] override: clasificado como chat pero "${grounding.matchedTerm}" coincide con símbolo real "${grounding.matchedSymbol}", forzando search`);
        return { type: 'search', terms: extractSearchKeywords(prompt) };
      }
      return parsed;
    }
    if (parsed.type === 'search' && Array.isArray(parsed.terms) && parsed.terms.length > 0) {
      // Validar que los términos parezcan identificadores de código reales, no frases
      // en lenguaje natural que Groq devolvió a pesar de la instrucción del prompt de
      // extraer camelCase/CONSTANT_CASE/snake_case. Un identificador real NUNCA contiene
      // espacios — "historial de sesión" llegando como un solo término (en vez de, por
      // ejemplo, sessionHistory) es la señal inequívoca de que Groq no siguió la regla.
      const validTerms = parsed.terms.filter(t =>
        typeof t === 'string' &&
        !/\s/.test(t.trim()) &&
        t.trim().length >= 2 &&
        !KEYWORD_STOPWORDS.has(t.trim().toLowerCase())
      );
      if (validTerms.length > 0) {
        return { type: 'search', terms: validTerms };
      }
      console.warn(`[classifyAndRespondFast] Groq devolvió términos no válidos como identificadores: [${parsed.terms.join(', ')}] — usando fallback local`);
      return { type: 'search', terms: extractSearchKeywords(prompt) };
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

/**
 * Descompone la pregunta del usuario en 2-4 sub-preguntas concretas de búsqueda,
 * usando Groq (barato). Se ejecuta ANTES de la primera búsqueda real, en vez de
 * dejar que Haiku descubra reactivamente qué buscar paso a paso — reduce rondas
 * de deep_search y por lo tanto tokens de Claude en preguntas multi-concepto.
 *
 * Si la pregunta ya es simple (un solo concepto), devuelve un array de UN solo
 * elemento — no fuerza descomposición innecesaria en preguntas de lookup directo.
 * Ante cualquier fallo (sin keys, error de red, JSON inválido), devuelve []
 * y el llamador debe caer al comportamiento anterior (búsqueda única con el
 * mensaje completo) sin romper el flujo.
 */
async function planSearchSteps(userMessage: string, historyStr: string): Promise<string[]> {
  const keys = getGroqKeys();
  if (keys.length === 0) return [];

  const systemPrompt = `Sos un planificador de búsqueda de código. Dada la pregunta del usuario, descomponela en 2 a 4 sub-preguntas concretas e independientes que, si se responden todas, permiten responder la pregunta original por completo.

REGLAS:
- Cada sub-pregunta debe apuntar a UNA pieza de código concreta a buscar (una función, una condición, un flujo específico).
- Si la pregunta ya es simple y apunta a un solo concepto/función, devolvé un array de UN solo elemento igual a la pregunta original — no fuerces descomposición innecesaria.
- No repitas la pregunta original tal cual en cada sub-pregunta — cada una debe ser más específica y accionable para una búsqueda de código real.
- Devolvé SOLO un JSON array de strings, sin explicación, sin markdown, sin backticks.

Ejemplo de pregunta compleja:
"¿Cómo se relacionan el circuit breaker con el trailing stop y qué pasa si ambos se activan al mismo tiempo?"
Respuesta esperada:
["dónde y cómo se verifica el circuit breaker antes de abrir una posición", "dónde se coloca y ajusta el trailing stop en una posición abierta", "qué pasa si el circuit breaker se activa mientras hay un trailing stop ya colocado — hay alguna interacción explícita entre ambos en el código"]

Ejemplo de pregunta simple:
"¿Cómo funciona la señal S1?"
Respuesta esperada:
["cómo funciona la señal S1"]`;

  try {
    const raw = await callGroqAgent(
      `Pregunta: "${userMessage}"\n\nHistorial reciente: ${historyStr || '(sin historial)'}`,
      systemPrompt,
      300,
    );
    const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(cleaned) as unknown;
    if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string') && parsed.length > 0) {
      return parsed.slice(0, 4);
    }
  } catch (err) {
    console.warn('[planSearchSteps] fallo, continuando sin plan:', err instanceof Error ? err.message : err);
  }
  return [];
}

// Tabla estructurada de traducciones de dominio — cada entrada define sus
// triggers literales (regex) para poder VERIFICAR que el trigger realmente
// está en el prompt del usuario antes de aceptar la traducción, en vez de
// confiar en que Groq respetó la instrucción "solo si menciona exactamente".
interface DomainTranslation {
  term: string;
  triggers: RegExp[];
  displayTriggers: string; // texto legible para el prompt de Groq
}

const SIGNAL_OS_TRANSLATIONS: DomainTranslation[] = [
  { term: 'checkS1Bull',        triggers: [/\bRVOL\b/i, /\bse[ñn]al\s*S1\b/i],                          displayTriggers: '"RVOL" o "señal S1"' },
  { term: 'checkS2',            triggers: [/\bSMC\b/i, /\bsmart\s*money\b/i, /\bse[ñn]al\s*S2\b/i],       displayTriggers: '"señal S2" o "SMC" o "smart money"' },
  { term: 'checkS3Bull',        triggers: [/\balineaci[oó]n\b/i, /\bEMA\b/i, /\bse[ñn]al\s*S3\b/i],       displayTriggers: '"señal S3" o "alineación" o "EMA"' },
  { term: 'checkS4',            triggers: [/\bse[ñn]al\s*S4\b/i],                                         displayTriggers: '"señal S4"' },
  { term: 'checkS5ImpulsBull',  triggers: [/\bimpulso\b/i, /\bearly\b/i, /\bse[ñn]al\s*S5\b/i],           displayTriggers: '"señal S5" o "impulso" o "early"' },
  { term: 'checkS6Bull',        triggers: [/\bFVG\b/i, /\bfair\s*value\s*gap\b/i, /\bse[ñn]al\s*S6\b/i],  displayTriggers: '"señal S6" o "FVG" o "fair value gap"' },
  { term: 'trailingStop',       triggers: [/\btrailing\b/i, /\bstop\s*m[oó]vil\b/i],                     displayTriggers: '"trailing" o "stop móvil" o "trailing stop"' },
  { term: 'moving_plan',        triggers: [/\btrailing\b/i, /\bstop\s*m[oó]vil\b/i],                     displayTriggers: '"trailing" o "stop móvil" o "trailing stop"' },
  { term: 'rangeRate',          triggers: [/\btrailing\b/i, /\bstop\s*m[oó]vil\b/i],                     displayTriggers: '"trailing" o "stop móvil" o "trailing stop"' },
  { term: 'effectiveSlPct',     triggers: [/\bstop\s*loss\b/i, /\bSL\b/i, /\bstop\s*fijo\b/i, /\bpartial\s*TP\s*\/?\s*SL\b/i], displayTriggers: '"stop loss" o "SL" o "stop fijo" o "Partial TP/SL" (SIN mencionar "trailing")' },
  { term: 'slPrice',            triggers: [/\bstop\s*loss\b/i, /\bSL\b/i, /\bstop\s*fijo\b/i, /\bpartial\s*TP\s*\/?\s*SL\b/i], displayTriggers: '"stop loss" o "SL" o "stop fijo" o "Partial TP/SL" (SIN mencionar "trailing")' },
  { term: 'circuitBreaker',     triggers: [/\bstreak\b/i, /\bracha\b/i, /\bp[eé]rdidas?\s*consecutivas?\b/i], displayTriggers: '"streak" o "racha" o "pérdidas consecutivas"' },
];

/** Devuelve true si el repo pertenece al dominio Signal OS (Ahorar).
 *  Centraliza la regla para que tanto extractKeywordsForSearch como el
 *  FAST READ PATH usen la misma detección sin duplicar la expresión. */
function isSignalOS(repo: string): boolean {
  return /ahorar/i.test(repo);
}

/** Verifica que al menos uno de los triggers literales de una traducción de
 *  dominio aparezca de verdad en el prompt del usuario — evita que Groq
 *  devuelva una traducción por parecido semántico sin el trigger real.
 *  También acepta el término cuando el propio identificador canónico aparece
 *  literalmente en el prompt (ej. el usuario escribe "circuitBreaker" directamente). */
function isDomainTermGrounded(term: string, prompt: string): boolean {
  const entry = SIGNAL_OS_TRANSLATIONS.find(t => t.term === term);
  if (!entry) return true; // no es un término mapeado — no aplica este chequeo
  // Aceptar si el identificador canónico aparece literalmente en el prompt
  const canonicalRe = new RegExp(`\\b${term}\\b`);
  if (canonicalRe.test(prompt)) return true;
  return entry.triggers.some(re => re.test(prompt));
}

/** Calcula, de forma puramente determinística (sin IA), qué términos de
 *  SIGNAL_OS_TRANSLATIONS tienen su trigger literal presente en el prompt.
 *  Se usa para FORZAR estas traducciones incluso cuando Groq no las propone
 *  — el grounding existente solo puede filtrar lo que Groq devuelve, no
 *  agregar lo que Groq omitió. */
function getForcedDomainMatches(prompt: string, repo: string): string[] {
  if (!isSignalOS(repo)) return [];
  return SIGNAL_OS_TRANSLATIONS
    .filter(t => t.triggers.some(re => re.test(prompt)))
    .map(t => t.term);
}

async function extractKeywordsForSearch(
  prompt: string,
  repo: string = '',
  send: (event: string, data: Record<string, unknown>) => void = () => {},
): Promise<string[]> {
  const keys = getGroqKeys();
  if (keys.length === 0) {
    console.warn(`[extractKeywordsForSearch] sin Groq keys — intentando memoria/semántica — query: "${prompt.slice(0, 80)}"`);
    const fallbackTerms = await fallbackToMemoryOrSemantic(prompt, repo, send);
    const forced = getForcedDomainMatches(prompt, repo);
    return [...new Set([...fallbackTerms, ...forced])];
  }

  const systemPrompt = `Extraé los identificadores técnicos y nombres propios del prompt del usuario para buscar en GitHub Code Search.
REGLAS:
- Extraé exactamente los términos técnicos, nombres de funciones, clases o variables que aparecen en el prompt.
- No agregues términos de contexto genérico que no estén mencionados en el prompt.
- Ignorá verbos imperativos y sustantivos genéricos de programación salvo que sean parte de un identificador compuesto.
- Si el prompt contiene un concepto en lenguaje natural sin nombre técnico claro, usá las palabras más específicas del prompt tal como están.
- Devolvé un JSON array de máximo 4 strings.
- Respondé SOLO el array JSON, sin explicación, sin backticks.`;

  for (const key of keys) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8_000);
      const res = await fetch(GROQ_URL, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: GROQ_MODEL,
          max_tokens: 60,
          temperature: 0,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
        }),
      }).finally(() => clearTimeout(timer));

      if (res.status === 429) {
        console.warn(`[extractKeywordsForSearch] key rate-limited (429) — probando siguiente key`);
        continue;
      }
      if (!res.ok) {
        console.warn(`[extractKeywordsForSearch] HTTP ${res.status} con esta key — probando siguiente`);
        continue;
      }
      const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const raw = json.choices?.[0]?.message?.content ?? '[]';
      const parsed = JSON.parse(raw.trim()) as unknown;
      if (Array.isArray(parsed) && parsed.every((t) => typeof t === 'string')) {
        // Reparación repo-agnóstica: para cada término devuelto por Groq, buscar
        // si coincide (fuzzy) con un símbolo real del repo. Si hay match, usar
        // el nombre canónico real en vez del término crudo — reemplaza la
        // necesidad de una tabla de traducciones por repo.
        const realSymbolNames = await getRepoSymbolNames(repo);
        const repairedTerms = (parsed as string[]).map(t => {
          if (realSymbolNames.length === 0) return t;
          const fuzzyMatches = findRealSymbolMatches(t, realSymbolNames, 1);
          if (fuzzyMatches.length > 0 && fuzzyMatches[0] !== t) {
            console.log(`[extractKeywordsForSearch] "${t}" → símbolo real "${fuzzyMatches[0]}"`);
            return fuzzyMatches[0];
          }
          return t;
        });
        const dedupedTerms = [...new Set(repairedTerms)];
        const forcedMatches = getForcedDomainMatches(prompt, repo);
        const finalTerms = [...new Set([...dedupedTerms, ...forcedMatches])];
        if (forcedMatches.length > 0) {
          console.log(`[extractKeywordsForSearch] forzando traducciones de dominio no propuestas por Groq: [${forcedMatches.join(', ')}]`);
        }
        console.log(`[agent] AI keywords (post-repair + forced): [${finalTerms.join(', ')}]`);
        return finalTerms;
      }
      console.warn(`[extractKeywordsForSearch] respuesta no es array JSON válido ("${raw.slice(0, 60)}") — probando siguiente key`);
    } catch (err) {
      console.warn(`[extractKeywordsForSearch] key falló: ${err instanceof Error ? err.message : String(err)} — probando siguiente`);
    }
  }

  console.warn(`[extractKeywordsForSearch] todas las keys fallaron — intentando memoria/semántica — query: "${prompt.slice(0, 80)}"`);
  const fallbackTerms = await fallbackToMemoryOrSemantic(prompt, repo, send);
  const forced = getForcedDomainMatches(prompt, repo);
  return [...new Set([...fallbackTerms, ...forced])];
}

/**
 * Fallback de 3 pasos cuando Groq no produce keywords grounded:
 *  1. Memoria aprendida (repo_knowledge) — sin releer ni razonar.
 *  2. Resolución semántica nueva — lee skeletons reales y confirma el símbolo.
 *  3. localKeywordFallback — último recurso, sin acceso al código.
 */
async function fallbackToMemoryOrSemantic(
  prompt: string,
  repo: string,
  send: (event: string, data: Record<string, unknown>) => void,
): Promise<string[]> {
  if (repo) {
    // Paso 2 — memoria aprendida
    const candidateKws = localKeywordFallback(prompt, 4);
    const cached = await loadRepoKnowledgeVerified(repo, candidateKws, prompt);
    if (cached) {
      console.log(`[extractKeywordsForSearch] resuelto desde repo_knowledge: "${cached.concept}"`);
      return [cached.concept];
    }

    // Paso 3 — resolución semántica por lectura real del repo
    const resolved = await resolveConceptSemantically(prompt, repo, send);
    if (resolved) {
      console.log(`[extractKeywordsForSearch] resuelto semánticamente: [${resolved.symbols.join(', ')}]`);
      return resolved.symbols;
    }
  }

  // Paso 4 — último recurso
  console.warn(`[extractKeywordsForSearch] FALLBACK LOCAL — query: "${prompt.slice(0, 80)}"`);
  return localKeywordFallback(prompt);
}

/**
 * Resolución semántica repo-agnóstica: lee skeletons de los archivos más
 * relevantes del repo, le pide al modelo que identifique el símbolo que
 * corresponde al concepto de la pregunta, confirma que el símbolo existe
 * de verdad en el índice local, y guarda el resultado en repo_knowledge
 * para servir las próximas consultas sobre el mismo concepto sin releer.
 */
async function resolveConceptSemantically(
  userQuery: string,
  repo: string,
  send: (event: string, data: Record<string, unknown>) => void,
): Promise<{ symbols: string[]; fragment: string; sourceFile: string } | null> {
  // 1. Candidatos: reutilizar listFilesFiltered (ya prioriza server/lib/routes/services)
  const filePaths = await listFilesFiltered(repo);
  const topPaths = filePaths.split('\n').filter(Boolean).slice(0, 12);

  // 2. Skeletons: reutilizar generateStructuralSkeleton, ya usado en el DEEP READ path
  const skeletonParts: string[] = [];
  await Promise.allSettled(topPaths.map(async (fp) => {
    try {
      const fc = await getFileContent(fp, repo);
      const sk = generateStructuralSkeleton(fc, fp);
      if (sk && sk !== fc) {
        skeletonParts.push(`--- ${fp} ---\n${sk.split('\n').slice(0, 25).join('\n')}`);
      }
    } catch { /* skip */ }
  }));
  if (skeletonParts.length === 0) return null;

  // 3. Preguntarle al modelo qué símbolo corresponde — SIN mencionarle nombres de otros
  //    repos ni ninguna tabla. Solo el esqueleto real de ESTE repo.
  send('action', { text: '🧭 Sin match directo — leyendo estructura del repo para razonar...' });
  const raw = await generateWithFallbackDeep(
    `PREGUNTA DEL USUARIO: ${userQuery}\n\nESQUELETO DE ARCHIVOS DE ESTE REPO:\n${skeletonParts.join('\n\n')}`,
    `Sos un ingeniero leyendo este repo por primera vez, sin ninguna tabla de traducciones
previa. Identificá qué función/constante/variable del esqueleto corresponde al concepto
de la pregunta, basándote ÚNICAMENTE en los nombres y la estructura visible en ESTE
esqueleto — no en convenciones de otros proyectos que puedas conocer.
Respondé SOLO con JSON: {"path": "archivo.ts", "candidateSymbols": ["symA", "symB"]}
Si no hay ningún candidato razonable, respondé {"path": null, "candidateSymbols": []}.`,
  );

  let parsed: { path: string | null; candidateSymbols: string[] };
  try {
    parsed = JSON.parse(raw.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, ''));
  } catch { return null; }
  if (!parsed.path || parsed.candidateSymbols.length === 0) return null;

  // 4. Confirmar contra el índice real — el candidato debe EXISTIR de verdad,
  //    no basta con que el modelo lo haya propuesto.
  for (const symName of parsed.candidateSymbols) {
    const sym = await lookupSymbol(symName, repo);
    if (sym) {
      const fc = await getFileContent(sym.filePath, repo);
      const section = readEnclosingFunction(fc, sym.lineNumber) ?? smartReadSection(fc, sym.lineNumber, 40);
      if (!section) continue;

      send('action', { text: `✅ Concepto resuelto por lectura real: "${userQuery.slice(0, 40)}" → ${symName} (${sym.filePath}:${sym.lineNumber})` });

      // 5. Guardar en repo_knowledge — la próxima vez este mismo repo lo sirve directo,
      //    sin volver a leer ni razonar. Esto es "la traducción queda en contexto",
      //    generalizado a memoria persistente entre sesiones.
      const concept = conceptSlug(localKeywordFallback(userQuery, 1)[0] ?? userQuery.slice(0, 20));
      await saveRepoKnowledge(repo, concept, section.excerpt, [{ path: sym.filePath, startLine: section.startLine, endLine: section.endLine }], 'medium');

      return { symbols: [symName], fragment: section.excerpt, sourceFile: sym.filePath };
    }
  }
  return null; // ningún candidato propuesto existe de verdad — no inventar
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
      const classification = await classifyAndRespondFast(prompt, _fastHistoryForClassify, repo);
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
        const fastKeywordsRaw = (_fastClassification?.type === 'search' && _fastClassification.terms.length > 0)
          ? _fastClassification.terms
          : await extractKeywordsForSearch(prompt, repo);
        // Aplicar el mismo grounding de dominio que extractKeywordsForSearch,
        // incluso cuando los términos vinieron de classifyAndRespondFast —
        // evita que FAST mode omita las traducciones (trailing→trailingStop,
        // stop loss→effectiveSlPct/slPrice) que sí aplica extractKeywordsForSearch.
        const fastDomainMatches = isSignalOS(repo)
          ? SIGNAL_OS_TRANSLATIONS.filter(t => t.triggers.some(re => re.test(prompt))).map(t => t.term)
          : [];
        const fastKeywords = [...new Set([...fastKeywordsRaw, ...fastDomainMatches])];
        const fastPattern = fastKeywords.length > 0
          ? fastKeywords.join('|')
          : prompt.split(/\s+/).filter(w => w.length > 4).slice(0, 3).join('|');

        // ── FAST session continuity ──────────────────────────────────────────
        // Reusar historial cargado por classifyAndRespondFast (namespace FAST).
        const fastHistory: any[] = _fastHistoryForClassify;
        const _lastFastUser = fastHistory.slice().reverse().find((m: any) => m.role === 'user');
        const _lastFastAss  = fastHistory.slice().reverse().find((m: any) => m.role === 'assistant');
        const _isFollowUp   = !!sessionId &&
          isLikelyFollowUp(fastKeywords, prompt, _lastFastUser, _lastFastAss);

        if (_isFollowUp) {
          // FAST FOLLOW-UP PATH — mismo tema detectado, evaluar si el fragmento alcanza.
          send('action', { text: '⚡ FAST — pregunta de seguimiento, evaluando contexto ya leído...' });

          const cachedFragment = _lastFastAss!.fragment as string;
          // Grounding: además de "no es insuficiente" (heurística de longitud/forma),
          // verificar que al menos un término real de la pregunta actual aparece
          // literalmente en el fragmento cacheado — evita que isLikelyFollowUp
          // reutilice contexto de un tema distinto (ej. señales/scores) para
          // responder una pregunta nueva no relacionada (ej. stop loss), lo que
          // llevaba al modelo a inventar detalles plausibles pero falsos.
          const fastFollowUpGroundingTerms = localKeywordFallback(prompt, 6)
            .map(t => t.toLowerCase())
            .filter(t => t.length >= 2);
          const isCachedFragmentGrounded = fastFollowUpGroundingTerms.length > 0
            && fastFollowUpGroundingTerms.some(t => cachedFragment.toLowerCase().includes(t));
          const fragmentCovers = isCachedFragmentGrounded && !isFragmentInsufficient(cachedFragment, fastKeywords);
          if (!isCachedFragmentGrounded) {
            console.log(`[fast-followup] fragmento cacheado no grounded contra "${prompt.slice(0, 60)}" — tratando como fallback (búsqueda adicional)`);
          }

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
Si no alcanza para responder, decilo en una oración y sugerí DEEP mode.

REGLA DE CITAS DE LÍNEA: si mencionás un número de línea específico (ej. "línea 6814"), ese \
número DEBE aparecer literalmente como prefijo en el fragmento de evidencia que tenés delante \
(ej. el texto "6814: " al inicio de una línea del fragmento). Nunca inventes ni recuerdes de \
memoria un número de línea — es especialmente riesgoso cuando el contexto incluye evidencia de \
múltiples archivos (fragmento ya conocido + evidencia adicional de una búsqueda nueva), donde es \
fácil confundir la numeración de uno con la del otro. Si sabés en qué función o bloque está algo \
pero no tenés el número exacto en el fragmento que estás citando, describí la ubicación SIN \
número en vez de inventar uno.`;

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
                // ── FAST→DEEP escalation ──────────────────────────────────────────
                // La búsqueda liviana (symbol_index + ripgrep + "primer match nuevo")
                // no encontró un candidato válido, pero puede que ripgrep sí haya traído
                // resultados que el multi-hop real (runDeepSearchPipeline) pueda conectar
                // siguiendo la cadena de llamadas — eso es justo lo que faltó en el caso
                // real de "runHaikuTier" (5 resultados de ripgrep, ninguno suficiente por
                // sí solo). En vez de rendirse y mandar al usuario a cambiar de modo
                // manualmente, escalamos automáticamente, capado a 2 hops (FAST sigue
                // siendo la versión liviana, no usa el presupuesto de 4 hops de DEEP).
                send('action', { text: '🔭 FAST — sin match adicional liviano, escalando al motor de DEEP (multi-hop)...' });
                try {
                  const deepEscProd = fuMatches.filter(m => !isTestMatch(m.path, m.text));
                  const deepEscRanked = deepEscProd.length > 0 ? deepEscProd : fuMatches;
                  const deepEscEvidence = deepEscRanked.length > 0
                    ? await runDeepSearchPipeline(deepEscRanked, fastKeywords, repo, send, 2, false, prompt)
                    : [];

                  if (deepEscEvidence.length > 0) {
                    // ── Comprimir evidencia de DEEP antes de enviar a Groq/DeepSeek ──
                    // Sin este paso, fragmentos de 300 líneas c/u + cachedFragment
                    // superan los 28,000 chars y producen 413 (Groq) / 402 (DeepSeek).
                    const { context: combinedFollowUpContext, originalChars: escOrigChars, compressedChars: escCmpChars } =
                      compressDeepEvidenceForFast(deepEscEvidence, cachedFragment, alreadyReadPath ?? '');
                    console.log(
                      `[fast-deep-esc] evidencia comprimida: ${escOrigChars} chars → ${escCmpChars} chars ` +
                      `(${deepEscEvidence.length} fragmento(s), cachedFragment cap=${FAST_CACHED_FRAGMENT_CAP})`,
                    );

                    const fuAnalysis = await generateWithFallback(
                      `El usuario hace una pregunta de seguimiento: "${prompt}"\n\n${combinedFollowUpContext}`,
                      fuSystemPrompt,
                    );
                    const fuLines = fuAnalysis.split('\n').map((l: string) => l.trim()).filter(Boolean);
                    for (const line of fuLines) send('action', { text: `💡 ${line}` });

                    const updatedFastHistory = [
                      ...fastHistory,
                      { role: 'user',      content: prompt,     keywords: fastKeywords },
                      { role: 'assistant', content: fuAnalysis, fragment: combinedFollowUpContext, path: deepEscEvidence[0].path },
                    ];
                    await saveFastHistory(sessionId!, updatedFastHistory).catch(() => {});
                  } else {
                    send('action', { text: '💡 Lo que ya vimos no cubre esa parte específica, y ni la búsqueda liviana ni DEEP encontraron más contexto. Reformulá con el nombre exacto de la función o variable.' });
                  }
                } catch (deepEscErr) {
                  console.warn('[agent/fast-followup-deep-escalation] escalación a DEEP falló:', deepEscErr instanceof Error ? deepEscErr.message : deepEscErr);
                  send('action', { text: '💡 Lo que ya vimos no cubre esa parte específica, y no encontré otro archivo relacionado. Reformulá con más detalle o probá DEEP mode para una búsqueda más extensiva.' });
                }
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
            // Guardia de dominio: si el archivo original es backend, el candidato de
            // respaldo NO puede ser frontend — evita que palabras genéricas ("sesión",
            // "historial") arrastren evidencia de un componente React no relacionado
            // hacia una pregunta sobre código de backend. Si el original YA es frontend,
            // no restringimos (caso menos común, se mantiene el comportamiento previo).
            const readPathIsFrontend = FRONTEND_PATTERNS.some(p => p.test(readPath));
            const fbCandidates = fbMatches.filter(
              m => m.path !== readPath && !isTestMatch(m.path, m.text ?? ''),
            );
            const fbDomainMismatches = readPathIsFrontend
              ? []
              : fbCandidates.filter(m => FRONTEND_PATTERNS.some(p => p.test(m.path)));
            if (fbDomainMismatches.length > 0 && fbDomainMismatches.length === fbCandidates.length) {
              send('action', { text: `⚠️ Único resultado adicional (${fbDomainMismatches[0].path}) es de frontend — descartado por no coincidir con el dominio del archivo original (${readPath})` });
            }
            const fbBest = readPathIsFrontend
              ? fbCandidates[0]
              : fbCandidates.find(m => !FRONTEND_PATTERNS.some(p => p.test(m.path)));
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
sobre código que NO está en el fragmento — no para lo que sí está visible.

REGLA DE CITAS DE LÍNEA: si mencionás un número de línea específico (ej. "línea 6814"), ese \
número DEBE aparecer literalmente como prefijo en el fragmento que tenés delante (ej. el texto \
"6814: " al inicio de una línea del fragmento). Nunca inventes ni recuerdes de memoria un número \
de línea — es especialmente riesgoso cuando recibís "Fragmento principal" + "Fragmento \
adicional" de dos archivos distintos, donde es fácil confundir la numeración de uno con la del \
otro. Si sabés en qué función o bloque está algo pero no tenés el número exacto en el fragmento \
que estás citando, describí la ubicación SIN número en vez de inventar uno.`,
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
        : localKeywordFallback(prompt).join('|');

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
        determineMaxHops(prompt),
        true,
        prompt,
      );

      if (deepEvidence.length === 0) {
        send('action', { text: '⚠️ Match encontrado en índice pero no se pudo leer el fragmento del archivo.' });
      }

      // Persist evidence — diagnosis holds the FULL annotated brief so
      // CHAT/Haiku receives structured context (labeled by type), not a raw code dump.
      const deepEvidenceSummary = deepEvidence.length > 0
        ? formatDeepEvidenceForHaiku(deepEvidence, prompt, repo)
        : '';

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
  // Negative lookbehind "(?<!se\s)" excluye construcciones reflexivas/pasivas
  // donde "se" precede DIRECTAMENTE al verbo ("se ejecuta", "se aplica", etc.).
  // Para cubrir casos donde "se" precede al verbo principal pero el gerundio
  // aparece más adelante en la misma cláusula ("se actualiza agregando resultados",
  // "se resuelve aplicando un fallback"), se agrega un segundo chequeo post-match:
  // si el término que matcheó es un gerundio (-ando/-iendo/-yendo) Y hay un "se"
  // antes de él en la misma cláusula (sin punto/signo de interrogación entre medio),
  // la oración es descriptiva → 'explain'.
  const GENERATE_SIGNALS = /\b(?<!se\s)(corrig|correg|corrij|arregl|implement|agreg|añad|cre[aá]|refactor|escrib|modific|cambi|propon|ejecut|resolv|resu[eé]lv|remov|remu[eé]v|aplic|elimin|borr|insert|reemplaz|update|fix|patch)[\p{L}\p{N}_]*\b/iu;
  const match = GENERATE_SIGNALS.exec(message);
  if (!match) return 'explain';
  // Gerundio en cláusula reflexiva → descriptivo, no imperativo
  if (/(?:ando|iendo|yendo)$/i.test(match[0])) {
    // Tomar el texto antes del match, dentro de la misma cláusula (hasta el último
    // separador oracional: punto, signo de interrogación, exclamación o punto y coma)
    const beforeMatch = message.slice(0, match.index);
    const sameClause = beforeMatch.split(/[.!?;¿¡]/).pop() ?? '';
    if (/\bse\b/i.test(sameClause)) return 'explain';
  }
  return 'generate';
}

/**
 * Detecta si el mensaje del usuario es una consulta de auditoría que requiere
 * respuesta punto por punto con citas directas de código. Se activa si:
 *   - Hay 2+ preguntas numeradas (ej. "1. ¿...? 2. ¿...?")
 *   - O el mensaje contiene frases de auditoría explícitas
 */
function isAuditQuery(message: string): boolean {
  // 2+ preguntas numeradas: "1. ...? 2. ...?"
  const numberedQs = (message.match(/\b\d+[.)]\s+[^?]+\?/g) ?? []).length;
  if (numberedQs >= 2) return true;
  return /citando l[ií]nea|l[ií]nea exacta|confirm[aá]\s*o\s*corrig|verific[aá]\s*si es cierto|no asumas|punto por punto|cita la l[ií]nea/i.test(message);
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

/**
 * Clasifica si una pregunta técnica (ya marcada NEEDS_TOOLS) requiere un lookup
 * directo (simple → ripgrep + fragmento + Groq) o una búsqueda multi-hop
 * (complex → DEEP pre-fetch + Haiku).
 *
 * Actúa DENTRO del bloque NEEDS_TOOLS, no como gate previo al triage de Groq.
 */
function classifySearchComplexity(
  userMessage: string,
  conversationHistory: Array<{ role: string; content: string }>,
): 'simple' | 'complex' {
  // Heurística 1: palabras que indican relaciones entre múltiples conceptos → complex
  const hasRelationshipKeywords = /\b(relaci[oó]n|relaciona|relac|interacci[oó]n|junto|combo|ambos|trabajan|flujo completo|entre)\b/i.test(userMessage);
  const multipleTopicsRegex = /\b(y|con|versus|vs|adem[aá]s|tambi[eé]n)\s+(?:el|la|los|las)\s+\w+\s*\(/i;

  if (hasRelationshipKeywords || multipleTopicsRegex.test(userMessage)) {
    return 'complex';
  }

  // Heurística 2: cambio de tema respecto al último mensaje del usuario → complex
  const lastUserMessage = conversationHistory
    .slice()
    .reverse()
    .find(m => m.role === 'user')?.content ?? '';

  if (lastUserMessage && lastUserMessage !== userMessage) {
    const topicShift = /^(?:ahora|cambiando|diferente|otro|next|siguient|pasando)/i.test(userMessage);
    if (topicShift) return 'complex';
  }

  // Heurística 3: patrones que piden comparaciones o flujos completos → complex
  const complexPatterns = [
    /flujo\s+completo/i,
    /paso\s+a\s+paso/i,
    /c[oó]mo\s+se\s+relaciona/i,
    /diferencia\s+entre/i,
    /cuando\s+.*\s+entonces/i,
  ];
  if (complexPatterns.some(p => p.test(userMessage))) {
    return 'complex';
  }

  // Heurística 4 — 2+ identificadores técnicos distintos → complex.
  // Una query con múltiples símbolos (ej. CAPS_SNAKE_CASE + camelCase) casi
  // siempre necesita explorar distintos archivos/funciones. No requiere
  // lenguaje de relación explícito para ser clasificada como compleja.
  const techIds = [
    ...(userMessage.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? []),   // CAPS_SNAKE (≥2 partes)
    ...(userMessage.match(/\b[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]+\b/g) ?? []), // camelCase
  ];
  if (new Set(techIds.map(t => t.toLowerCase())).size >= 2) return 'complex';

  // Heurística 5 — preguntas de ENUMERACIÓN ("en qué archivos aparece X",
  // "dónde se usa X", "listame todos los lugares donde...") piden un listado
  // completo de resultados, no la explicación de un único fragmento. Necesitan
  // el pipeline de DEEP con búsqueda en paralelo — la ruta rápida solo trae
  // el primer match y descarta el resto en silencio.
  const enumerationPatterns = [
    /en\s+qu[eé]\s+archivos?/i,
    /d[oó]nde\s+(aparece|se\s+usa|se\s+encuentra|est[aá])/i,
    /todos?\s+los\s+lugares?\s+donde/i,
    /list[aá]me?\s+(todos?|los)\s+archivos?/i,
    /en\s+todos?\s+los\s+archivos?/i,
  ];
  if (enumerationPatterns.some(p => p.test(userMessage))) return 'complex';

  // Default: lookup directo
  return 'simple';
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

async function buildTriagePrompt(cacheHint: string, repo?: string): Promise<string> {
  let changelogContext = '';

  if (repo) {
    try {
      const changelog = await loadRepoKnowledge(repo, ['SYSTEM_CHANGELOG']);
      if (changelog?.summary) {
        const verifiedDate = changelog.verified_at ? new Date(changelog.verified_at) : new Date();
        const daysSince = Math.floor((Date.now() - verifiedDate.getTime()) / (1000 * 60 * 60 * 24));
        if (daysSince <= 7) {
          changelogContext = `\nCAMBIOS RECIENTES EN EL REPO (últimos ${daysSince} días):
${changelog.summary}

Si la pregunta está relacionada con código que cambió recientemente, prioriza buscar en el código nuevo. El usuario probablemente quiere saber cómo funciona AHORA, después de los cambios.\n`;
        }
      }
    } catch (err) {
      console.warn('[changelog] load en buildTriagePrompt falló:', err instanceof Error ? err.message : err);
    }

    // Cargar investigaciones previas sobre el mismo repo (últimos 30 días)
    try {
      const relevantInvestigations = await pool.query<{ summary: string }>(
        `SELECT summary FROM repo_knowledge
         WHERE repo = $1 AND concept LIKE 'INVESTIGATION_%'
         AND NOT stale AND verified_at > NOW() - INTERVAL '30 days'
         ORDER BY verified_at DESC LIMIT 2`,
        [repo],
      );
      if (relevantInvestigations.rows.length > 0) {
        changelogContext += `\n\nINVESTIGACIONES PREVIAS (últimos 30 días):\n`;
        relevantInvestigations.rows.forEach((row, i) => {
          changelogContext += `${i + 1}. ${row.summary.substring(0, 150)}...\n`;
        });
      }
    } catch (invErr) {
      console.warn('[investigations] load en buildTriagePrompt falló:', invErr instanceof Error ? invErr.message : invErr);
    }
  }

  return `Responde de forma breve y directa, usando SOLO tu conocimiento general — no tienes acceso a herramientas ni al código real del repo.
${changelogContext}${cacheHint}
PRIMERA PRIORIDAD — MENSAJES SOCIALES Y CONVERSACIONALES: si el mensaje es un saludo (Hola, Buenas, Hey…), agradecimiento (Gracias, Perfecto, Genial…), confirmación vacía (Ok, Entendido, Dale, Sí, No…), pregunta de cortesía (¿Cómo estás?…) o cualquier otro mensaje sin pregunta técnica real — respondé de forma conversacional, breve y natural. NUNCA retornés "NEEDS_TOOLS" para mensajes puramente sociales. Esta regla tiene prioridad ABSOLUTA sobre todas las demás reglas de este prompt, incluyendo las de trading y dominio.
SOBRE EL CONTEXTO ADICIONAL: si aparece una sección "RESUMEN" o "CONTEXTO ADICIONAL" arriba, ese contenido proviene de una inspección real del código fuente de este mismo repo, hecha por este sistema hace menos de 30 minutos — no es una suposición ni una fuente externa incierta. Tratá esos datos como hechos verificados: usá los nombres exactos que aparecen ahí, no los parafrasees, y no agregues disclaimers como "probablemente", "podría ser" o "esto puede variar" sobre información que ya está confirmada.
REGLA OBLIGATORIA — TÉRMINOS DE TRADING Y DOMINIO:
Si la pregunta menciona cualquier término de dominio de este proyecto — incluyendo pero no limitado a:
INDICADORES DE MERCADO: FVG, imbalance, CHOCH, BOS, EMA, SMA, RSI, MACD, ADX, ATR, SuperTrend, SAR, Score, RVOL, señal, trailing, stop, activación, condición de entrada.
MECANISMOS Y SUBSISTEMAS DEL PROYECTO: circuit breaker, streak, racha, screener, scanner, bias, trailing stop, circuitBreaker, low conviction, migración de mercado, o cualquier otro nombre de subsistema propio de este repo.
— o cualquier COMPARACIÓN entre estos conceptos (ej: "diferencia entre X e Y", "cómo funciona X vs Y", "cambiar X por Y") — debés responder ÚNICAMENTE con "NEEDS_TOOLS: " seguido de una razón breve, SALVO que la respuesta exacta a esa pregunta específica ya esté transcripta literalmente en el cacheHint o historial arriba (no basta con que el término aparezca — debe estar la respuesta real).

ATENCIÓN ESPECIAL — TÉRMINOS AMBIGUOS CON SIGNIFICADO GENÉRICO EXTERNO:
Términos como "circuit breaker", "streak", "screener" o "scanner" EXISTEN como conceptos genéricos de ingeniería/trading fuera de este proyecto (ej: "circuit breaker" es un patrón de diseño de software para manejo de errores en sistemas distribuidos). Esto los vuelve MÁS peligrosos que un identificador de código puro (como "checkS6Bull"), porque tenés conocimiento genérico plausible sobre ellos sin haber leído la implementación real de este repo. Si detectás que tu respuesta a uno de estos términos se basaría en su significado genérico de la industria en vez de en el código real de este proyecto — es señal inequívoca de NEEDS_TOOLS, incluso si "suena" correcto y coherente. Una respuesta genérica que no menciona la implementación real de este repo es siempre incorrecta para este tipo de pregunta, aunque describa bien el concepto en abstracto.
NUNCA completes con tu conocimiento genérico de trading/finanzas para preguntas sobre estos términos — el comportamiento de FVG, imbalance, EMA, Score, etc. en ESTE proyecto es específico del código real, no una definición estándar. Usar una definición genérica cuando el proyecto puede tener una implementación distinta es un error crítico.
Ejemplos que SIEMPRE resultan en NEEDS_TOOLS (aunque la pregunta parezca conceptual):
- "¿Cuál es la diferencia entre FVG e imbalance?" → NEEDS_TOOLS: necesito leer el código para ver cómo este proyecto los distingue
- "¿Cómo funciona el EMA aquí?" → NEEDS_TOOLS: depende de la implementación específica del repo
- "¿Qué es el Score en este bot?" → NEEDS_TOOLS: salvo que el cacheHint lo explique con detalle
- "Explicame el SuperTrend vs SAR" → NEEDS_TOOLS: comparación de implementaciones específicas
- "¿Cómo funciona el circuit breaker?" → NEEDS_TOOLS: "circuit breaker" tiene un significado genérico de ingeniería (patrón de manejo de errores) que NO es la implementación real de este proyecto — necesito leer el código para explicar cómo se usa acá, no el concepto abstracto
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

    invalidateRepoKnowledge(repo, [filePath]).catch(() => {});

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
const SESSION_HAIKU_TTL_MS = 15 * 60 * 1000; // 15 min de inactividad → vuelve a evaluar complexity

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
    // 2.5. Bare symbol name from index lookup (no syntactic context around it) —
    //      covers matches from lookupSymbol, where matchText is just the identifier itself
    //      (e.g. "testTrailingStopCoexistence"), which rules 2 and 3 miss because they
    //      require function/const/assignment syntax or a PascalCase-embedded word.
    if (/^(test|mock|debug|stub|fake|dummy)[A-Z]/.test(matchText.trim())) return true;
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
      // (capturing groups 1 and 3 = the two array names being compared)
      const OFFSET_CMP_FORWARD = /\b(\w+)\s*\[\s*(\w+)\s*\]!?\s*[><=!]{1,3}\s*\(?\s*(\w+)\s*\[\s*\2\s*-\s*\d+\s*\]/;
      // word[i-N]!? OP (?word[i]  — same tolerances for reverse form
      const OFFSET_CMP_REVERSE = /\b(\w+)\s*\[\s*(\w+)\s*-\s*\d+\s*\]!?\s*[><=!]{1,3}\s*\(?\s*(\w+)\s*\[\s*\2\s*\]/;
      // Explicit fvg variable (named structural result)
      const FVG_NAMED_VAR = /\bfvg(?:Bull|Bear|bull|bear|Up|Down|Long|Short|[A-Z])/;
      // Los arrays comparados deben sugerir datos de precio/vela — sin esto,
      // cualquier comparación de índice con offset (status, historial, buffers
      // genéricos) se marcaba como FVG solo por la forma del código.
      const PRICE_ARRAY_HINT = /\b(low|high|close|open|price|candle|wick)/i;

      const matchedLines: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const structuralMatch = line.match(OFFSET_CMP_FORWARD) ?? line.match(OFFSET_CMP_REVERSE);
        if (structuralMatch) {
          const arraysInvolved = `${structuralMatch[1]} ${structuralMatch[3]}`;
          if (PRICE_ARRAY_HINT.test(arraysInvolved)) {
            matchedLines.push(fragmentStartLine + i);
          }
          continue;
        }
        if (FVG_NAMED_VAR.test(line)) {
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
    const ALWAYS_EXCLUDE_GLOBS = [
      '--glob', '!**/attached_assets/**',
      '--glob', '!**/node_modules/**',
      '--glob', '!**/*.md',
    ];
    const testExcludeGlobs: string[] = options?.excludeTestPaths
      ? [
          ...ALWAYS_EXCLUDE_GLOBS,
          '--glob', '!**/*.test.ts', '--glob', '!**/*.test.js',
          '--glob', '!**/*.spec.ts', '--glob', '!**/*.spec.js',
          '--glob', '!**/__tests__/**', '--glob', '!**/tests/**',
          '--glob', '!**/mocks/**',    '--glob', '!**/fixtures/**',
        ]
      : ALWAYS_EXCLUDE_GLOBS;

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

// ── DEEP mode: fragment annotation types & helpers ────────────────────────────

/** Extended fragment type produced by runDeepSearchPipeline — includes annotation
 *  fields so Haiku receives structured context instead of a raw code dump. */
interface AnnotatedFragment {
  path: string;
  line: number;
  endLine: number;
  fragment: string;
  // ── Annotation fields (new) ──
  fragmentType: 'DEFINITION' | 'CALL_SITE' | 'INTERACTION' | 'PATTERN' | 'CONFIG';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  /** Brief description in Spanish: what this fragment does/defines */
  purpose: string;
  /** Function/variable names referenced inside the fragment */
  relatedSymbols: string[];
  /** 0 = initial search; 1+ = which multi-hop step found this */
  hopLevel: number;
}

/** Returns 2 for simple queries, 4 for complex multi-concept queries. */
function determineMaxHops(query: string): number {
  const multiConceptKeywords = /\b(y|con|versus|vs|adem[aá]s|tambi[eé]n|juntos|relaciona|interacci[oó]n|flujo|entre|relacionado|relacionados)\b/i;
  return multiConceptKeywords.test(query) ? 4 : 2;
}

/** Extract identifiers called/referenced inside a code fragment (for relatedSymbols). */
function extractRelatedSymbols(code: string): string[] {
  const CALL_PATTERN = /\b(?:await\s+)?([a-zA-Z_][a-zA-Z0-9_]{3,})\s*\(/g;
  const BUILTINS_SET = new Set([
    'if','for','while','switch','return','const','let','var','new','typeof',
    'instanceof','async','await','function','class','import','export','default',
    'throw','catch','try','super','this','void','null','true','false','undefined',
    'console','Math','Object','Array','Promise','JSON','parseInt','parseFloat',
    'String','Number','Boolean','Date','Set','Map','Error','Symbol','fetch',
    'setTimeout','setInterval','clearTimeout','clearInterval','require',
  ]);
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = CALL_PATTERN.exec(code)) !== null) {
    if (!BUILTINS_SET.has(m[1])) seen.add(m[1]);
  }
  return [...seen].slice(0, 8);
}

/** Detects whether two fragments represent an interaction (f1 conditionally depends on f2).
 *  If detected, reclassifies f2 (the callee) to INTERACTION in place. */
function detectInteraction(f1: AnnotatedFragment, f2: AnnotatedFragment): boolean {
  const interactionPatterns = [
    /if\s*\([^)]*check/i,
    /unless\s+/i,
    /while\s*\([^)]*check/i,
    /await.*return/i,
  ];
  const hasConditional = interactionPatterns.some(p => p.test(f1.fragment));
  const calledSymbol = f2.relatedSymbols[0] ?? '';
  if (hasConditional && calledSymbol && f1.fragment.includes(calledSymbol)) {
    f2.fragmentType = 'INTERACTION';
    return true;
  }
  return false;
}

/** Groups annotated fragments by type and renders a structured brief for Haiku. */
function formatDeepEvidenceForHaiku(
  fragments: AnnotatedFragment[],
  userQuery: string,
  repo: string,
): string {
  let output = '';
  output += `═══════════════════════════════════════════════════════════════\n`;
  output += `BÚSQUEDA PROFUNDA (DEEP MODE)\n`;
  output += `Pregunta: "${userQuery}"\n`;
  output += `Repo: ${repo}\n`;
  output += `═══════════════════════════════════════════════════════════════\n\n`;

  const byType: Record<string, AnnotatedFragment[]> = {};
  for (const f of fragments) {
    if (!byType[f.fragmentType]) byType[f.fragmentType] = [];
    byType[f.fragmentType].push(f);
  }

  const TYPE_EMOJI: Record<string, string> = {
    DEFINITION: '📌',
    CALL_SITE:  '🔗',
    INTERACTION:'⚡',
    PATTERN:    '🔍',
    CONFIG:     '⚙️',
  };

  const ORDER = ['DEFINITION', 'CALL_SITE', 'INTERACTION', 'PATTERN', 'CONFIG'];
  for (const type of ORDER) {
    const frags = byType[type] ?? [];
    if (frags.length === 0) continue;
    output += `\n${'─'.repeat(65)}\n`;
    output += `${TYPE_EMOJI[type] ?? '📄'} ${type}\n`;
    output += `${'─'.repeat(65)}\n`;
    frags.forEach((f, idx) => {
      output += `\n[${idx + 1}/${frags.length}] ${f.purpose}\n`;
      output += `Archivo: ${f.path}:${f.line}–${f.endLine}\n`;
      output += `Confianza: ${f.confidence} | Hop: ${f.hopLevel}\n`;
      if (f.relatedSymbols.length > 0) {
        output += `Símbolos relacionados: ${f.relatedSymbols.join(', ')}\n`;
      }
      output += `\n${f.fragment}\n\n`;
    });
  }

  // Relationship context — the structural insight DEEP provides so Haiku synthesizes
  output += `\n${'═'.repeat(65)}\n`;
  output += `CONTEXTO DE RELACIÓN (para que Haiku sintetice)\n`;
  output += `${'═'.repeat(65)}\n\n`;
  output += generateRelationshipContext(fragments);
  output += `\n\nNOTA: Haiku debe EXPLICAR esta estructura, no repetirla.`;
  output += `\nHaiku: convertí esto en prosa clara y narrativa (máx 4 párrafos).`;
  output += `\nDEEP: ya encontró y estructuró — Haiku solo sintetiza.`;

  // Señal explícita de relevancia por término de usuario — evita que la síntesis
  // ignore un fragmento hallado por multi-hop (ej. hop 2 = placeOrder con slPrice)
  // solo porque no coincide con el patrón de búsqueda original (ej. trailingStop).
  const userQueryTerms = localKeywordFallback(userQuery, 6)
    .map(t => t.toLowerCase())
    .filter(t => t.length >= 3);
  if (userQueryTerms.length > 0) {
    const directHits = fragments.filter(f =>
      userQueryTerms.some(t => f.fragment.toLowerCase().includes(t)),
    );
    if (directHits.length > 0) {
      output += `\n${'═'.repeat(65)}\n`;
      output += `⚠️ COINCIDENCIA DIRECTA CON LA PREGUNTA DEL USUARIO\n`;
      output += `${'═'.repeat(65)}\n`;
      output += `Los siguientes fragmentos contienen términos literales de la pregunta ("${userQueryTerms.join(', ')}") y DEBEN priorizarse en la síntesis, incluso si no son el símbolo originalmente buscado:\n`;
      for (const f of directHits) {
        output += `- ${f.path}:${f.line} (${f.fragmentType})\n`;
      }
    }
  }

  return output;
}

/** Generates a relationship summary from the set of annotated fragments. */
function generateRelationshipContext(fragments: AnnotatedFragment[]): string {
  const hasDefinition  = fragments.some(f => f.fragmentType === 'DEFINITION');
  const hasCallSite    = fragments.some(f => f.fragmentType === 'CALL_SITE');
  const hasPattern     = fragments.some(f => f.fragmentType === 'PATTERN');
  const hasInteraction = fragments.some(f => f.fragmentType === 'INTERACTION');
  const callSiteCount  = fragments.filter(f => f.fragmentType === 'CALL_SITE').length;

  let context = '';
  if (hasDefinition && hasCallSite) {
    context += `• La definición se usa en múltiples call sites (implementación distribuida)\n`;
  }
  if (hasDefinition && hasPattern) {
    context += `• La definición implementa un patrón detectado (patrón de diseño/trading)\n`;
  }
  if (hasInteraction) {
    context += `• Hay una interacción condicional entre componentes (uno condiciona el comportamiento del otro)\n`;
  }
  if (hasCallSite && callSiteCount > 1) {
    context += `• El componente se usa en contextos distintos (${callSiteCount} call sites)\n`;
  }
  return context || `• Fragmentos del codebase relacionados con la pregunta (ver estructura arriba)\n`;
}

// ── Confidence evaluation (DEEP early-stop) ───────────────────────────────────

const SYSTEM_PROMPT_CONFIDENCE_CHECK =
  'Eres un evaluador de evidencia de código. Responde ÚNICAMENTE con JSON válido, sin texto extra.';

/**
 * Asks Groq (same integration as triage) whether the evidence accumulated so far
 * is sufficient to answer the user's query. Returns { sufficient, reason }.
 * On any failure (network, bad JSON, etc.) returns sufficient=false as a fail-safe
 * so we prefer one extra hop over cutting information short.
 */
async function evaluateSearchConfidence(
  userQuery: string,
  fragmentsSoFar: AnnotatedFragment[],
  hopLevel: number,
  auditMode = false,
): Promise<{ sufficient: boolean; reason: string }> {
  const summary = fragmentsSoFar.map(f =>
    `- [${f.fragmentType}] ${f.purpose} (${f.path}:${f.line})`,
  ).join('\n');

  // En modo auditoría el criterio es más estricto: sufficient=true solo si
  // hay evidencia directa para CADA punto numerado, no solo cobertura general
  // del tema. Esto evita el corte temprano de hops ante preguntas multi-punto.
  const auditCriteria = auditMode
    ? `MODO AUDITORÍA — el usuario hizo preguntas numeradas específicas. ` +
      `Solo devolvé sufficient=true si la evidencia cubre DIRECTAMENTE CADA UNO ` +
      `de los puntos numerados con código real leído (no solo el tema general). ` +
      `Si falta evidencia directa para aunque sea uno solo de los puntos, ` +
      `devolvé sufficient=false.\n\n`
    : '';
  const prompt =
    `Pregunta del usuario: "${userQuery}"\n\n` +
    `Evidencia encontrada hasta el hop ${hopLevel}:\n${summary}\n\n` +
    auditCriteria +
    `¿Esta evidencia ya es suficiente para responder completamente la pregunta, ` +
    `incluyendo CÓMO se relacionan los conceptos si la pregunta lo pide?\n` +
    `Responde SOLO con JSON: {"sufficient": true|false, "reason": "una frase breve"}`;

  try {
    const response = await callGroqAgent(prompt, SYSTEM_PROMPT_CONFIDENCE_CHECK, 150);
    return JSON.parse(
      response.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, ''),
    ) as { sufficient: boolean; reason: string };
  } catch {
    // Fail-safe: prefer an extra hop over cutting information short
    return { sufficient: false, reason: 'fallback — no se pudo evaluar' };
  }
}

// ── Dynamic fragment narrowing (DEEP pipeline) ────────────────────────────────
// Replaces the fixed readEnclosingFunction(300 lines) + smartReadSection(±60)
// pattern with an iterative Groq-guided read that starts at ±100 lines and
// trims to the relevant sub-range, minimising what eventually reaches Haiku.

const NARROW_FRAGMENT_SYSTEM =
  'Eres un analizador de código. Responde ÚNICAMENTE con JSON válido, sin texto extra.';

interface NarrowFragmentResult {
  excerpt: string;
  startLine: number;
  endLine: number;
  purpose: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  initialLineCount: number;
  finalLineCount: number;
  iterations: number;
}

/**
 * Reads a code fragment dynamically around anchorLine using iterative Groq
 * refinement. Starts with ±100 lines (vs the former fixed 300-line function
 * read), then expands in the indicated direction if Groq says the window is
 * insufficient. Finally trims to the relevant sub-range ± 10 lines.
 *
 * Returns null on any failure (network, bad JSON, empty file) so the caller
 * falls back to the existing readEnclosingFunction / smartReadSection logic —
 * no behavioral regression on Groq outage.
 */
async function readAndNarrowFragment(
  content: string,
  anchorLine: number,        // 1-indexed
  userQuery: string,
  symbolTerms: string[],
): Promise<NarrowFragmentResult | null> {
  const INITIAL_CONTEXT = 100;   // ±100 lines initial window (200 lines total)
  const EXPANSION_STEP  = 100;   // lines to add per expansion step
  const MAX_ITERATIONS  = 3;     // max Groq calls per fragment
  const MARGIN          = 10;    // extra context lines around relevantRange

  const fileLines = content.split('\n');
  const totalFileLines = fileLines.length;
  if (totalFileLines === 0 || anchorLine < 1) return null;

  const buildExcerpt = (s: number, e: number): string =>
    fileLines.slice(s, e + 1).map((l, i) => `${s + i + 1}: ${l}`).join('\n');

  // 0-indexed boundaries
  let winStart = Math.max(0, anchorLine - 1 - INITIAL_CONTEXT);
  let winEnd   = Math.min(totalFileLines - 1, anchorLine - 1 + INITIAL_CONTEXT);

  const initialLineCount = winEnd - winStart + 1;
  const queryShort  = userQuery.slice(0, 200);
  const symbolHint  = symbolTerms.slice(0, 2).join(', ');

  type GroqNarrow = {
    sufficient: boolean;
    relevantRange: { start: number; end: number };
    needsExpansion: 'up' | 'down' | 'both' | null;
    purpose: string;
  };
  let lastParsed: GroqNarrow | null = null;
  let iterations = 0;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    iterations = iter + 1;
    const excerpt = buildExcerpt(winStart, winEnd);
    const prompt =
      `Pregunta: "${queryShort}"\n` +
      `Símbolo buscado: "${symbolHint}"\n\n` +
      `Fragmento de código (líneas ${winStart + 1}–${winEnd + 1}):\n${excerpt}\n\n` +
      `Devolvé JSON:\n{\n` +
      `  "sufficient": true|false,\n` +
      `  "relevantRange": {"start": N, "end": M},\n` +
      `  "needsExpansion": "up"|"down"|"both"|null,\n` +
      `  "purpose": "qué hace este fragmento respecto a la pregunta"\n` +
      `}\n` +
      `sufficient=true si el fragmento ya contiene lo necesario para responder. ` +
      `relevantRange debe ser el sub-rango más angosto que aún responde la pregunta ` +
      `(usá los números de línea del prefijo "N: código"). ` +
      `Si sufficient=false, needsExpansion indica hacia dónde expandir.`;

    try {
      const raw = await callGroqAgent(prompt, NARROW_FRAGMENT_SYSTEM, 200);
      const parsed = JSON.parse(
        raw.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, ''),
      ) as GroqNarrow;
      if (!parsed || typeof parsed.sufficient !== 'boolean') throw new Error('invalid shape');
      lastParsed = parsed;
      if (parsed.sufficient) break;

      const dir = parsed.needsExpansion ?? 'both';
      if (dir === 'up'   || dir === 'both') winStart = Math.max(0, winStart - EXPANSION_STEP);
      if (dir === 'down' || dir === 'both') winEnd   = Math.min(totalFileLines - 1, winEnd + EXPANSION_STEP);
    } catch (groqErr) {
      console.warn(
        `[deep-dynamic-range] Groq falló en iteración ${iter + 1}: ` +
        (groqErr instanceof Error ? groqErr.message : String(groqErr)),
      );
      break; // Groq failed — stop, fall through to old logic below
    }
  }

  // All Groq calls failed → return null so caller uses old readEnclosingFunction
  if (!lastParsed) return null;

  // ── Trim to relevantRange ± MARGIN ───────────────────────────────────────────
  let finalStart = winStart;
  let finalEnd   = winEnd;
  const rr = lastParsed.relevantRange;
  if (rr && typeof rr.start === 'number' && typeof rr.end === 'number') {
    // rr values are 1-indexed line numbers (from the "N: code" prefixes)
    finalStart = Math.max(winStart, Math.max(0, rr.start - 1 - MARGIN));
    finalEnd   = Math.min(winEnd,   Math.min(totalFileLines - 1, rr.end - 1 + MARGIN));
  }
  // Safety: ensure the anchor line is never outside the final window
  finalStart = Math.min(finalStart, Math.max(0, anchorLine - 1));
  finalEnd   = Math.max(finalEnd,   Math.min(totalFileLines - 1, anchorLine - 1));

  const finalLineCount = finalEnd - finalStart + 1;
  const finalExcerpt   = buildExcerpt(finalStart, finalEnd);
  const purpose        = (lastParsed.purpose ?? '').trim()
    || `Fragmento relacionado con ${symbolHint || 'símbolo'}`;
  const confidence: 'HIGH' | 'MEDIUM' | 'LOW' = lastParsed.sufficient ? 'HIGH' : 'MEDIUM';

  console.log(
    `[deep-dynamic-range] fragmento inicial: ${initialLineCount} líneas → ` +
    `recortado a ${finalLineCount} líneas tras ${iterations} iteración(es)`,
  );

  return {
    excerpt: finalExcerpt,
    startLine: finalStart + 1,
    endLine: finalEnd + 1,
    purpose,
    confidence,
    initialLineCount,
    finalLineCount,
    iterations,
  };
}

// ── repo_knowledge — memoria persistente indexada por concepto ────────────────

/** Normaliza una keyword técnica a un slug de concepto para indexar en repo_knowledge. */
function conceptSlug(keyword: string): string {
  return keyword.toLowerCase().replace(/[^a-z0-9]/g, '');
}

interface RepoKnowledgeRow {
  concept: string;
  summary: string;
  source_files: { path: string; startLine: number; endLine: number }[];
  confidence: string;
  verified_at: string;
}

/**
 * Busca conocimiento persistente ya verificado para alguna de las keywords
 * dadas, en este repo. No tiene TTL — solo se excluye si fue marcado stale
 * por una invalidación (commit a un archivo fuente relacionado).
 */
async function loadRepoKnowledge(repo: string, keywords: string[]): Promise<RepoKnowledgeRow | null> {
  if (keywords.length === 0) return null;
  const slugs = keywords.map(conceptSlug).filter(Boolean);
  if (slugs.length === 0) return null;
  try {
    const r = await pool.query<RepoKnowledgeRow>(
      `SELECT concept, summary, source_files, confidence, verified_at
       FROM repo_knowledge
       WHERE repo = $1 AND concept = ANY($2) AND NOT stale
       ORDER BY verified_at DESC LIMIT 1`,
      [repo, slugs],
    );
    return r.rows[0] ?? null;
  } catch (err) {
    console.warn('[repo_knowledge] load failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Híbrido: usa el conocimiento cacheado si el fragmento tiene calidad suficiente
 * (misma heurística que FAST mode usa para decidir si vale la pena buscar más:
 * isFragmentInsufficient). Si el fragmento cacheado es pobre (corto, declaración
 * sin cuerpo, o cubre ≤1 línea con las keywords), relee directo desde
 * source_files — sin ripgrep, sin extracción de keywords, un solo read_file
 * puntual — y AUTORREPARA guardando la versión buena para la próxima consulta.
 * Si no se puede releer (archivo movido/borrado), descarta el caché y devuelve
 * null para que el llamador caiga al flujo de búsqueda normal.
 */
async function loadRepoKnowledgeVerified(
  repo: string,
  keywords: string[],
  originalQuery?: string,
): Promise<RepoKnowledgeRow | null> {
  const raw = await loadRepoKnowledge(repo, keywords);
  if (!raw) return null;

  // Grounding: el conocimiento cacheado solo es válido si al menos un término
  // real de la pregunta actual (no la keyword extraída, que puede haber
  // generalizado por parecido semántico, ej. "stop loss" → "trailingStop")
  // aparece literalmente en el resumen guardado.
  if (originalQuery) {
    const groundingTerms = localKeywordFallback(originalQuery, 6);
    const isGroundedInSummary = groundingTerms.length > 0
      && groundingTerms.some(t => raw.summary.toLowerCase().includes(t.toLowerCase()));
    if (!isGroundedInSummary) {
      console.warn(`[repo_knowledge] "${raw.concept}" — no grounded contra la pregunta original ("${originalQuery.slice(0, 60)}"), descartando caché`);
      return null;
    }
  }

  if (!isFragmentInsufficient(raw.summary, keywords)) {
    return raw; // caché de buena calidad — servir directo
  }

  const primary = raw.source_files?.[0];
  if (!primary) {
    console.warn(`[repo_knowledge] "${raw.concept}" — fragmento insuficiente y sin source_files, descartando caché`);
    return null;
  }

  try {
    const freshContent = await getFileContent(primary.path, repo);
    const freshSection =
      readEnclosingFunction(freshContent, primary.startLine) ??
      smartReadSection(freshContent, primary.startLine, 60);

    if (!freshSection) {
      console.warn(`[repo_knowledge] "${raw.concept}" — no se pudo releer sección en ${primary.path}:${primary.startLine}, descartando caché`);
      return null;
    }

    console.log(`[repo_knowledge] "${raw.concept}" — fragmento insuficiente, autorreparado desde ${primary.path}`);

    // Autorreparación: la próxima consulta sobre este concepto ya sirve la versión buena
    await saveRepoKnowledge(
      repo,
      keywords[0],
      freshSection.excerpt,
      [{ path: primary.path, startLine: freshSection.startLine, endLine: freshSection.endLine }],
      raw.confidence,
    );

    return {
      ...raw,
      summary: freshSection.excerpt,
      source_files: [{ path: primary.path, startLine: freshSection.startLine, endLine: freshSection.endLine }],
    };
  } catch (err) {
    console.warn(`[repo_knowledge] "${raw.concept}" — releer ${primary.path} falló, descartando caché:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Guarda o actualiza conocimiento verificado para un concepto. Se llama después
 * de una búsqueda exitosa (evidencia no vacía) dentro del pipeline de planificación.
 * Upsert por (repo, concept) — la investigación más reciente reemplaza a la anterior.
 */
async function saveRepoKnowledge(
  repo: string,
  primaryKeyword: string,
  summary: string,
  sourceFiles: { path: string; startLine: number; endLine: number }[],
  confidence: string,
): Promise<void> {
  const concept = conceptSlug(primaryKeyword);
  if (!concept) return;
  try {
    await pool.query(
      `INSERT INTO repo_knowledge (repo, concept, summary, source_files, confidence, stale, verified_at)
       VALUES ($1, $2, $3, $4, $5, FALSE, NOW())
       ON CONFLICT (repo, concept) DO UPDATE SET
         summary = EXCLUDED.summary,
         source_files = EXCLUDED.source_files,
         confidence = EXCLUDED.confidence,
         stale = FALSE,
         verified_at = NOW()`,
      [repo, concept, summary, JSON.stringify(sourceFiles), confidence],
    );
  } catch (err) {
    console.warn('[repo_knowledge] save failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Marca como stale todo el conocimiento guardado cuyo source_files incluya
 * alguno de los paths modificados por un commit — para que la próxima consulta
 * lo vuelva a verificar en vez de confiar en evidencia potencialmente vieja.
 */
export async function invalidateRepoKnowledge(repo: string, changedPaths: string[]): Promise<void> {
  if (changedPaths.length === 0) return;
  try {
    await pool.query(
      `UPDATE repo_knowledge
       SET stale = TRUE
       WHERE repo = $1 AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(source_files) elem
         WHERE elem->>'path' = ANY($2)
       )`,
      [repo, changedPaths],
    );
  } catch (err) {
    console.warn('[repo_knowledge] invalidate failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Guarda una investigación profunda (multi-turn o marcada explícitamente con /save)
 * en repo_knowledge bajo el concepto INVESTIGATION_* para reutilización futura.
 */
async function saveInvestigationMemory(
  repo: string,
  sessionMessages: any[],
  investigationState: InvestigationState,
): Promise<void> {
  if (!investigationState.shouldSave || sessionMessages.length < 2) {
    console.log(`[investigation] sesión no califica para guardarse (shouldSave=${investigationState.shouldSave}, turnCount=${investigationState.turnCount})`);
    return;
  }

  try {
    const topicList = Array.from(investigationState.topicTerms).join(', ');
    const date = new Date().toISOString().split('T')[0];

    const findings: string[] = [];
    for (const msg of sessionMessages) {
      if (msg.role === 'assistant') {
        const text = typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
            : String(msg.content ?? '');
        if (text.includes('encontré') || text.includes('cambió') || text.includes('problema')) {
          findings.push(text.substring(0, 200));
        }
      }
    }

    const investigationSummary = `Investigación del ${date}: ${topicList}
Turnos: ${investigationState.turnCount}

Hallazgos clave:
${findings.slice(0, 3).map((f, i) => `${i + 1}. ${f}...`).join('\n')}

Conceptos relacionados: ${topicList}
Sesión: ${sessionMessages.length} mensajes, ${investigationState.turnCount} preguntas`.trim();

    const investigationConcept = `INVESTIGATION_${investigationState.topicTerms.values().next().value ?? 'unknown'}`;

    await saveRepoKnowledge(
      repo,
      investigationConcept,
      investigationSummary,
      [],
      'medium',
    );

    console.log(
      `[investigation] guardada en repo_knowledge bajo "${investigationConcept}" — ${investigationState.turnCount} turnos investigados`,
    );
  } catch (err) {
    console.warn('[investigation] guardar falló:', err instanceof Error ? err.message : err);
  }
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
  userQuery?: string,
  auditMode = false,
): Promise<AnnotatedFragment[]> {
  // Extract literal fragments — no AI, no interpretation
  const deepEvidence: AnnotatedFragment[] = [];
  for (const match of matches.slice(0, 5)) {
    try {
      const fc = await getFileContent(match.path, repo);
      // ── Dynamic range narrowing — hop 0 / DEFINITION ─────────────────────────
      // Reads ±100 lines initially (vs. fixed 300-line readEnclosingFunction),
      // then Groq identifies the relevant sub-range to trim before Haiku sees it.
      const narrowResult0 = match.line
        ? await readAndNarrowFragment(fc, match.line, userQuery ?? '', queryTerms)
        : null;
      let section = narrowResult0
        ?? (match.line
          ? (smartReadSection(fc, match.line, 60) ?? readEnclosingFunction(fc, match.line))
          : (match.text ? smartReadSection(fc, match.text, 60) : null));
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
      const isPattern = patternNotes.length > 0;
      for (const note of patternNotes) send('action', { text: `🔍 ${note}` });
      deepEvidence.push({
        path: match.path,
        line: section.startLine,
        endLine: section.endLine,
        fragment: annotatedFragment,
        // ── Annotation fields ──
        fragmentType: isPattern ? 'PATTERN' : 'DEFINITION',
        confidence: narrowResult0?.confidence ?? 'HIGH',
        purpose: narrowResult0?.purpose
          ?? `Define ${match.text?.slice(0, 60) ?? match.path.split('/').pop() ?? 'símbolo'}`,
        relatedSymbols: extractRelatedSymbols(annotatedFragment),
        hopLevel: 0,
      });
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
        // El overlap debe cubrir al menos el 60% del string más corto, además
        // del mínimo absoluto de MIN_OVERLAP. Sin este requisito de proporción,
        // palabras genéricas cortas compartidas entre identificadores largos no
        // relacionados (ej. "time" dentro de "realTime" y "timeout") bastaban
        // para que el multi-hop los tratara como relacionados y se desviara
        // hacia archivos sin ninguna conexión real con la búsqueda original.
        const minRequiredOverlap = Math.max(MIN_OVERLAP, Math.ceil(shorter.length * 0.6));
        for (let l = shorter.length; l >= minRequiredOverlap; l--) {
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
          // Priority: real function declarations first, then arrow functions,
          // then generic const/let/var — prevents parameter extractions like
          // "const repo = params.repo" from winning over "function triggerSonnet(".
          const defMFunc  = ev.fragment.match(
            /(?:^|\n)\s*(?:\d+:\s*)?(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_][a-zA-Z0-9_]{3,})\s*\(/,
          );
          const defMArrow = ev.fragment.match(
            /(?:^|\n)\s*(?:\d+:\s*)?(?:export\s+)?(?:const|let)\s+([a-zA-Z_][a-zA-Z0-9_]{3,})\s*=\s*(?:async\s*)?\(/,
          );
          const defMVar   = ev.fragment.match(
            /(?:^|\n)\s*(?:\d+:\s*)?(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_][a-zA-Z0-9_]{3,})\s*=/,
          );
          const defSym = defMFunc?.[1] ?? defMArrow?.[1] ?? defMVar?.[1] ?? null;
          if (!defSym) continue;
          const defSymLower = defSym.toLowerCase();
          if (triedSymbols.has(defSymLower)) continue;
          triedSymbols.add(defSymLower);

          send('action', { text: `🔗 Salto ${hop + 1} (call site de "${defSym}")…` });
          try {
            // ── Graph-first: callers of defSym ──────────────────────────
            let callerMatch: { path: string; line: number } | null = null;
            let s2Source = 'ripgrep-fallback';
            try {
              const g2 = await pool.query<{ caller_file: string; caller_line: number }>(
                `SELECT caller_file, caller_line FROM symbol_calls
                 WHERE repo = $1 AND callee_name = $2
                   AND NOT (caller_file = $3 AND caller_line BETWEEN $4 AND $5)
                 ORDER BY caller_file, caller_line LIMIT 20`,
                [repo, defSym, ev.path, ev.line, ev.endLine]
              );
              const g2prod = g2.rows.filter(h => !isTestMatch(h.caller_file, ''));
              const g2hit = g2prod[0] ?? g2.rows[0];
              if (g2hit) { callerMatch = { path: g2hit.caller_file, line: g2hit.caller_line }; s2Source = 'grafo'; }
            } catch { /* graph unavailable — fall through */ }
            if (!callerMatch) {
              const callerRaw = await rgSearch(`\\b${defSym}\\s*\\(`, repo);
              const callerProd = callerRaw.filter(h =>
                !isTestMatch(h.path, h.text) &&
                !(h.path === ev.path && h.line >= ev.line && h.line <= ev.endLine)
              );
              const rg = callerProd[0];
              if (rg?.line) callerMatch = { path: rg.path, line: rg.line };
            }
            console.log(`[DEEP hop] fuente=${s2Source} hop=${hop + 1} strategy=2 sym="${defSym}"`);
            if (!callerMatch?.line) continue;

            const fc = await getFileContent(callerMatch.path, repo);
            // Dynamic range narrowing — Strategy 2 / CALL_SITE
            const narrowedS2 = await readAndNarrowFragment(fc, callerMatch.line, userQuery ?? '', [defSym]);
            let section = narrowedS2
              ?? smartReadSection(fc, callerMatch.line, 60)
              ?? readEnclosingFunction(fc, callerMatch.line);
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
            deepEvidence.push({
              path: callerMatch.path,
              line: section.startLine,
              endLine: section.endLine,
              fragment: annotatedFragment,
              fragmentType: 'CALL_SITE',
              confidence: narrowedS2?.confidence ?? 'HIGH',
              purpose: narrowedS2?.purpose ?? `Invoca ${defSym}; contexto de uso`,
              relatedSymbols: extractRelatedSymbols(annotatedFragment),
              hopLevel: hop + 1,
            });
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
        // Confidence check after Strategy 2 found a caller this hop
        {
          const newFragmentsThisHop = deepEvidence.slice(hopStart);
          if (newFragmentsThisHop.length > 0 && userQuery) {
            const conf = await evaluateSearchConfidence(userQuery, deepEvidence, hop + 1, auditMode);
            console.log(`[DEEP confidence] hop ${hop + 1}: sufficient=${conf.sufficient} — ${conf.reason}`);
            if (conf.sufficient) {
              console.log(`[DEEP confidence] deteniendo búsqueda temprano en hop ${hop + 1}/${maxHops}`);
              break;
            }
          }
        }
        continue;
      }

      const [bestSym] = [...candidates.entries()].sort((a, b) => b[1] - a[1])[0];
      const bestSymLower = bestSym.toLowerCase();
      triedSymbols.add(bestSymLower);

      send('action', { text: `🔗 Salto ${hop + 1}: buscando "${bestSym}"…` });
      try {
        // ── Graph-first: find call sites of bestSym from pre-built index ─
        let s1Source = 'ripgrep-fallback';
        let hitProcessed = false;
        try {
          const g1 = await pool.query<{ caller_file: string; caller_line: number }>(
            `SELECT caller_file, caller_line FROM symbol_calls
             WHERE repo = $1 AND callee_name = $2
             ORDER BY caller_file, caller_line LIMIT 20`,
            [repo, bestSym]
          );
          const g1prod = g1.rows.filter(h => !isTestMatch(h.caller_file, ''));
          const g1hit = g1prod[0] ?? g1.rows[0];
          if (g1hit) {
            s1Source = 'grafo';
            const fc = await getFileContent(g1hit.caller_file, repo);
            // Dynamic range narrowing — Strategy 1 / grafo / CALL_SITE
            const narrowedG1 = await readAndNarrowFragment(fc, g1hit.caller_line, userQuery ?? '', [bestSym]);
            let section = narrowedG1
              ?? smartReadSection(fc, g1hit.caller_line, 60)
              ?? readEnclosingFunction(fc, g1hit.caller_line);
            if (section?.excerpt.toLowerCase().includes(bestSymLower)) {
              relevanceSet.add(bestSymLower);
              const { annotatedFragment, notes: hopNotes } = annotateTradingPatterns(
                section.excerpt, section.startLine, g1hit.caller_file,
              );
              for (const note of hopNotes) send('action', { text: `🔍 ${note}` });
              deepEvidence.push({
                path: g1hit.caller_file,
                line: section.startLine,
                endLine: section.endLine,
                fragment: annotatedFragment,
                fragmentType: 'CALL_SITE',
                confidence: narrowedG1?.confidence ?? 'HIGH',
                purpose: narrowedG1?.purpose ?? `Invoca o define ${bestSym}`,
                relatedSymbols: extractRelatedSymbols(annotatedFragment),
                hopLevel: hop + 1,
              });
              if (showRawPreview) {
                send('action', { text: `📌 [hop ${hop + 1}] ${g1hit.caller_file}:${section.startLine}-${section.endLine}` });
                for (const fl of section.excerpt.split('\n').slice(0, 20)) send('action', { text: fl });
              } else {
                send('action', { text: `📌 Evidencia leída [hop ${hop + 1}] — ${g1hit.caller_file}` });
              }
              hitProcessed = true;
            }
          }
        } catch { /* graph unavailable — fall through to ripgrep */ }
        console.log(`[DEEP hop] fuente=${s1Source} hop=${hop + 1} strategy=1 sym="${bestSym}"`);

        if (!hitProcessed) {
          // ── Ripgrep fallback ────────────────────────────────────────────
          const hopMatches = await unifiedGrepSearch(bestSym, repo, send);
          const prodMatches = hopMatches.filter(h => !isTestMatch(h.path, h.text));
          const bestMatch = (prodMatches.length > 0 ? prodMatches : hopMatches)[0];
          if (bestMatch) {
            const fc = await getFileContent(bestMatch.path, repo);
            // Dynamic range narrowing — Strategy 1 / ripgrep / CALL_SITE
            const narrowedRg = bestMatch.line
              ? await readAndNarrowFragment(fc, bestMatch.line, userQuery ?? '', [bestSym])
              : null;
            let section = narrowedRg
              ?? (bestMatch.line
                ? (smartReadSection(fc, bestMatch.line, 60) ?? readEnclosingFunction(fc, bestMatch.line))
                : null);
            if (section) {
              if (!section.excerpt.toLowerCase().includes(bestSymLower)) {
                const fallback = bestMatch.line ? smartReadSection(fc, bestMatch.line, 50) : null;
                if (fallback?.excerpt.toLowerCase().includes(bestSymLower)) {
                  section = fallback;
                } else {
                  send('action', { text: `⚠️ Salto ${hop + 1}: "${bestSym}" no confirmado en fragmento, descartado` });
                  section = null;
                }
              }
              if (section) {
                relevanceSet.add(bestSymLower);
                const { annotatedFragment, notes: hopNotes } = annotateTradingPatterns(
                  section.excerpt, section.startLine, bestMatch.path,
                );
                for (const note of hopNotes) send('action', { text: `🔍 ${note}` });
                deepEvidence.push({
                  path: bestMatch.path,
                  line: section.startLine,
                  endLine: section.endLine,
                  fragment: annotatedFragment,
                  fragmentType: 'CALL_SITE',
                  confidence: narrowedRg?.confidence ?? 'HIGH',
                  purpose: narrowedRg?.purpose ?? `Invoca o define ${bestSym}`,
                  relatedSymbols: extractRelatedSymbols(annotatedFragment),
                  hopLevel: hop + 1,
                });
                if (showRawPreview) {
                  send('action', { text: `📌 [hop ${hop + 1}] ${bestMatch.path}:${section.startLine}-${section.endLine}` });
                  for (const fl of section.excerpt.split('\n').slice(0, 20)) send('action', { text: fl });
                } else {
                  send('action', { text: `📌 Evidencia leída [hop ${hop + 1}] — ${bestMatch.path}` });
                }
              }
            }
          }
        }
      } catch { /* skip if file unreadable */ }
      // Confidence check after Strategy 1 hop
      {
        const newFragmentsThisHop = deepEvidence.slice(hopStart);
        if (newFragmentsThisHop.length > 0 && userQuery) {
          const conf = await evaluateSearchConfidence(userQuery, deepEvidence, hop + 1, auditMode);
          console.log(`[DEEP confidence] hop ${hop + 1}: sufficient=${conf.sufficient} — ${conf.reason}`);
          if (conf.sufficient) {
            console.log(`[DEEP confidence] deteniendo búsqueda temprano en hop ${hop + 1}/${maxHops}`);
            break;
          }
        }
      }
    }
  }
  // ── end multi-hop ─────────────────────────────────────────────────────────────

  // ── Interaction detection pass ────────────────────────────────────────────────
  // After all hops: check whether any DEFINITION conditionally drives a CALL_SITE.
  // If so, reclassify the callee as INTERACTION for clearer Haiku context.
  {
    const defs  = deepEvidence.filter(f => f.fragmentType === 'DEFINITION');
    const calls = deepEvidence.filter(f => f.fragmentType === 'CALL_SITE');
    for (const def of defs) {
      for (const call of calls) {
        if (detectInteraction(def, call)) {
          send('action', { text: `⚡ Interacción detectada: ${call.path.split('/').pop()}` });
        }
      }
    }
  }

  return deepEvidence;
}

// ── Fast-mode DEEP evidence compressor ───────────────────────────────────────
// Applied exclusively in the FAST follow-up → DEEP escalation path before
// passing evidence to generateWithFallback (Groq/DeepSeek). Haiku's own path
// (runHaikuTier) receives evidence through the tool_result turn, which Claude
// handles natively. This compressor prevents 413/402 from free-tier APIs.

const FAST_DEEP_FRAGMENT_CAP  = 3_000; // chars per individual fragment
const FAST_DEEP_EVIDENCE_CAP  = 8_000; // chars total for all DEEP fragments combined
const FAST_CACHED_FRAGMENT_CAP = 4_000; // chars for the prior-turn cached fragment

/**
 * Compresses DEEP evidence for use in the FAST follow-up → DEEP escalation
 * path, where evidence is sent to Groq/DeepSeek (free-tier, low char limits).
 *
 * Priority: DEFINITION > CALL_SITE (more signal per char). If total would
 * exceed FAST_DEEP_EVIDENCE_CAP, CALL_SITE fragments are dropped first.
 * Each fragment is hard-capped at FAST_DEEP_FRAGMENT_CAP chars.
 *
 * Returns { context, originalChars, compressedChars } for logging.
 */
function compressDeepEvidenceForFast(
  evidence: AnnotatedFragment[],
  cachedFragment: string,
  alreadyReadPath: string,
): { context: string; originalChars: number; compressedChars: number } {
  const TRUNC_MARKER = '\n[... fragmento truncado por tamaño]';

  // ── 1. Cap the cached fragment from the prior turn ─────────────────────────
  const rawCached = cachedFragment;
  const cappedCached = rawCached.length > FAST_CACHED_FRAGMENT_CAP
    ? rawCached.slice(0, FAST_CACHED_FRAGMENT_CAP) + TRUNC_MARKER
    : rawCached;

  // ── 2. Sort DEFINITION before CALL_SITE (higher signal/char ratio) ─────────
  const TYPE_PRIORITY: Record<string, number> = {
    DEFINITION: 0, PATTERN: 1, INTERACTION: 2, CONFIG: 3, CALL_SITE: 4,
  };
  const sorted = [...evidence].sort(
    (a, b) => (TYPE_PRIORITY[a.fragmentType] ?? 5) - (TYPE_PRIORITY[b.fragmentType] ?? 5),
  );

  // ── 3. Cap each fragment individually ─────────────────────────────────────
  const capped = sorted.map(e => {
    const raw = e.fragment;
    const frag = raw.length > FAST_DEEP_FRAGMENT_CAP
      ? raw.slice(0, FAST_DEEP_FRAGMENT_CAP) + TRUNC_MARKER
      : raw;
    return { ...e, fragment: frag };
  });

  // ── 4. Accumulate until total DEEP evidence cap is reached ─────────────────
  const included: typeof capped = [];
  let totalEvidenceChars = 0;
  for (const e of capped) {
    const fragChars = e.fragment.length + e.path.length + 60; // 60 = label overhead
    if (totalEvidenceChars + fragChars > FAST_DEEP_EVIDENCE_CAP) break;
    included.push(e);
    totalEvidenceChars += fragChars;
  }

  // ── 5. Build the final context string ─────────────────────────────────────
  const deepEscContext = included
    .map(e => `Evidencia (DEEP, ${e.fragmentType}, hop ${e.hopLevel}) — ${e.path} (líneas ${e.line}-${e.endLine}):\n${e.fragment}`)
    .join('\n\n');

  const combinedContext =
    `Fragmento ya conocido — ${alreadyReadPath}:\n${cappedCached}\n\n${deepEscContext}`;

  // ── 6. Compute original size for logging ───────────────────────────────────
  const originalChars =
    rawCached.length +
    evidence.map(e => e.fragment.length + e.path.length + 60).reduce((a, b) => a + b, 0);
  const compressedChars = combinedContext.length;

  return { context: combinedContext, originalChars, compressedChars };
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
  return localKeywordFallback(message);
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

/**
 * Verifica, SIN llamar a ningún modelo, si el mensaje del usuario menciona algo
 * que existe de verdad en el código de este repo — reemplaza la lista fija de
 * palabras de dominio (FVG, circuit breaker, etc.) por una consulta al índice
 * real de símbolos, que ya se genera por repo. Escala automáticamente a
 * cualquier repo nuevo sin tocar código.
 *
 * Costo: $0 de API — extractKeywordsFromMessage es regex local, getRepoSymbolNames
 * consulta tu propia base de datos (ya se usa hoy en unifiedGrepSearch).
 */
async function isGroundedInRepoSymbols(
  message: string,
  repo: string,
): Promise<{ grounded: boolean; matchedSymbol?: string; matchedTerm?: string }> {
  const symbolNames = await getRepoSymbolNames(repo);
  if (symbolNames.length === 0) return { grounded: false };

  const candidates = extractKeywordsFromMessage(message)
    .map(t => t.replace(/[^\w]/g, '')) // limpiar puntuación pegada (ej. "breaker?")
    .filter(t => t.length >= 3);

  for (const term of candidates) {
    const matches = findRealSymbolMatches(term, symbolNames, 1);
    if (matches.length > 0) {
      return { grounded: true, matchedSymbol: matches[0], matchedTerm: term };
    }
  }
  return { grounded: false };
}

async function executeChatTool(
  name: string,
  input: Record<string, any>,
  repo: string,
  send: (event: string, data: Record<string, unknown>) => void,
  sessionId: string,
  auditMode = false,
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
    // Cambio 3 — detect cross-line patterns (e.g. "circuitBreaker.*trailing") that
    // search for a relationship across a single line. These almost never match
    // cross-function relationships in multi-line code. Warn (don't block) so Haiku
    // redirects to deep_search instead of iterating with the same unproductive pattern.
    const isCrossLinePattern = /\w+\.\*\w+/.test(input.pattern);
    const crossLineHint = isCrossLinePattern
      ? ` ⚠️ PATRÓN CROSS-LÍNEA: "${input.pattern}" busca la relación entre dos términos en la MISMA línea — las relaciones entre funciones/variables en distintas líneas rara vez se pueden encontrar así. Si lo que buscás es cómo se relacionan estos símbolos, usá deep_search en su lugar.`
      : '';

    if (matches.length === 0) {
      if (isCloned(repo)) {
        return `Sin resultados para "${input.pattern}" en el clon local. El término puede no existir literalmente — revisá variantes o usá read_file en los archivos más probables.${crossLineHint}`;
      }
      return `Sin resultados vía GitHub code search para "${input.pattern}". Causas posibles: delay de indexación de GitHub, rate limit silencioso, o caracteres especiales en el patrón (${input.pattern}). Si el término existe, usá read_file directamente en los archivos donde lo esperás encontrar, en vez de reintentar grep_code con el mismo término.${crossLineHint}`;
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
    if (isCrossLinePattern) {
      lines.push(crossLineHint);
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
    type DeepEvidence = AnnotatedFragment;
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
      return { matches: ranked, evidence: await runDeepSearchPipeline(ranked, terms, repo, send, determineMaxHops(query), false, query, auditMode) };
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
    const summary = formatDeepEvidenceForHaiku(evidence, query, repo);
    send('action', { text: `✅ deep_search — ${evidence.length} fragmento(s) extraído(s) y anotados` });
    // Cambio 1 — propagate confidence signal so Haiku stops searching immediately
    // when deep_search internally evaluated the evidence as sufficient.
    try {
      const conf = await evaluateSearchConfidence(query, evidence, 99, auditMode);
      if (conf.sufficient) {
        return summary +
          `\n\n⚠️ SEÑAL DE CONFIANZA: La evidencia encontrada fue evaluada como SUFICIENTE ` +
          `para responder la pregunta. Si ya tenés lo que necesitás, sintetizá la respuesta ` +
          `ahora en vez de seguir buscando.`;
      }
    } catch { /* non-fatal — proceed without signal */ }
    return summary;
  }
  return `Tool desconocida: ${name}`;
}

// ── runChatTurn ───────────────────────────────────────────────────────────────

// System prompt for Haiku exploration tier — smart domain-aware search strategy
/**
 * Prepended to HAIKU_SEARCH_SYSTEM when isAuditQuery=true.
 * OVERRIDES the "FORMATO POR DEFECTO" compression section completely —
 * all other rules (búsqueda, anti-alucinación, dominio) siguen vigentes.
 */
const HAIKU_AUDIT_FORMAT_OVERRIDE = `[MODO AUDITORÍA — OVERRIDE DE FORMATO]
El usuario hizo una consulta de verificación puntual (preguntas numeradas, "citando línea exacta", \
"confirmá o corregí", etc.). Para ESTA respuesta, el FORMATO POR DEFECTO de más abajo (4-5 líneas, \
sin headers, máx 2 citas) está SUSPENDIDO. Aplicá estas reglas en su lugar:

1. Respondé CADA punto en el orden en que fue preguntado, con un header corto por punto \
   (ej. **Punto 1 —** o **1.**). No colapses puntos distintos en un párrafo.
2. Para cada afirmación, citá el fragmento de código real que la respalda: nombre de archivo, \
   número de línea Y el texto exacto de esa línea tal como aparece en el código que leíste. \
   Formato sugerido: \`archivo.ts:N → "texto de la línea"\`. Si el número de línea no aparece \
   literalmente como prefijo en el fragmento que tenés delante, describí la ubicación por \
   nombre de función/bloque SIN inventar un número.
3. Si un punto no pudo confirmarse con evidencia directa del código (el símbolo no existe, \
   el fragmento no cubre esa parte, la búsqueda no encontró resultados), marcalo \
   explícitamente: "⚠️ No confirmado — [razón breve]".
4. Si lo que encontraste DIFIERE de lo que preguntó el usuario, marcalo: \
   "🔴 Discrepancia — el código muestra X, la pregunta asumía Y".
5. Terminá con una sección \`**Conclusión:**\` de 1-3 oraciones resumiendo qué se confirmó, \
   qué no se encontró y si hay discrepancias relevantes.
6. NO agregues el hint "💬 Pedime 'más detalle'" al final — en modo auditoría ya estás \
   dando el máximo detalle disponible.
7. La regla <<SUGGEST_SONNET:...>> sigue vigente — usala solo si encontraste un problema \
   concreto y verificado.`;

const HAIKU_SEARCH_SYSTEM = `Eres un asistente de exploración y síntesis de código. \
Tu objetivo principal es responder la pregunta del usuario de forma completa y eficiente.

━━━ PASO 0 (OBLIGATORIO — hacerlo ANTES de cualquier tool call) ━━━
Revisá si el contexto de la conversación ya contiene evidencia que responda la pregunta:
  • Si hay una sección "EVIDENCIA VERIFICADA (DEEP mode)" o "BÚSQUEDA PROFUNDA (DEEP MODE)":
    esas citas de archivo:línea son lecturas REALES del código fuente — HECHOS, no suposiciones.

    La evidencia puede venir en formato ESTRUCTURADO con etiquetas por tipo:
      📌 DEFINITION  → donde se define el símbolo
      🔗 CALL_SITE   → dónde se invoca (contexto de uso)
      ⚡ INTERACTION → componente que condiciona el comportamiento de otro
      🔍 PATTERN     → patrón de trading detectado (FVG, trailing, etc.)
    Si ves esas secciones, DEEP ya hizo el trabajo de búsqueda y clasificación.
    Tu trabajo es SINTETIZAR en prosa, NO repetir la estructura ni listar archivos.

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

⏱️ PRESUPUESTO DE PASOS: Tenés un presupuesto limitado de pasos de exploración. \
Si ya hiciste 2+ búsquedas (deep_search o grep_code) sin encontrar información NUEVA y relevante, \
DETENÉ la exploración y sintetizá una respuesta con la mejor evidencia disponible — \
aunque sea parcial o concluya "estos componentes parecen operar de forma independiente \
según el código revisado". Nunca es mejor agotar el límite de pasos sin responder \
que dar una respuesta honesta con evidencia parcial.

Reglas de búsqueda, en orden de prioridad:
1. Si ya tenés EVIDENCIA VERIFICADA (DEEP mode) en el contexto del mensaje, \
evaluá primero si responde completamente la pregunta — incluyendo relaciones \
entre conceptos si la pregunta las pide — ANTES de llamar cualquier tool.
2. Si necesitás ampliar o verificar esa evidencia, o la pregunta involucra \
cómo se relacionan 2+ conceptos, usá deep_search — NO grep_code. \
deep_search explora con múltiples pasos verificados y solo se detiene \
cuando la evidencia es suficiente.
3. Usá grep_code SOLO para un lookup puntual de un símbolo específico ya \
conocido por nombre exacto (ej. confirmar una línea, no para explorar \
relaciones o entender comportamiento).
4. Usá read_file solo para leer un archivo completo ya identificado por \
nombre — no como método de exploración.

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
  Pasalas todas juntas en tu PRIMER intento: deep_search(query: "trailingStop|TRAILING_STOP|trailing_stop|callbackRatio")

REINTENTO EN PARALELO — si ese primer deep_search (con las variantes combinadas) vuelve con \
evidencia insuficiente o vacía, NO repitas un segundo deep_search con más variantes combinadas \
en una sola query. En su lugar, lanzá 2-3 llamadas SEPARADAS a deep_search en la MISMA respuesta \
(mismo turno, varias tool calls juntas), cada una con un ángulo distinto de la pregunta — por \
ejemplo una con sinónimos funcionales, otra con el nombre de un módulo/archivo probable, otra con \
un concepto relacionado del dominio. Estas llamadas se ejecutan en paralelo del lado del servidor, \
así que separarlas no cuesta tiempo extra. Ejemplo: en vez de un segundo \
deep_search(query: "a|b|c|d|e|f"), preferí en el mismo turno: \
deep_search(query: "a|b"), deep_search(query: "c|d"), deep_search(query: "e|f") — tres tool calls \
distintas, no una combinada.

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
CUANDO RECIBÍS EVIDENCIA DEEP ESTRUCTURADA (secciones 📌 DEFINITION / 🔗 CALL_SITE / ⚡ INTERACTION / 🔍 PATTERN):
  DEEP ya hizo el trabajo duro — encontró, leyó y clasificó el código.
  Tu tarea es convertir esa estructura en prosa clara y narrativa. NUNCA la repitas ni la parafrasees como lista.
  Usá el "CONTEXTO DE RELACIÓN" del brief como guía para el ángulo de tu síntesis.
  Si el usuario pide 'más detalle', podés expandir con código/ejemplos de lo que ya está en el historial.

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
  - SEÑAL PARA BOTÓN DE CORRECCIÓN — opcional, solo cuando corresponda: si durante la \
    investigación encontraste un problema CONCRETO y VERIFICADO en el código (no una mejora \
    cosmética ni una especulación) — sea el que el usuario preguntó, o uno distinto que \
    encontraste de paso — agregá una línea nueva DESPUÉS de la línea "💬 Pedime 'más detalle'" \
    con este formato exacto: "<<SUGGEST_SONNET: resumen de una frase del problema encontrado>>". \
    Esta línea es invisible para el usuario — el sistema la intercepta y muestra un botón en su \
    lugar. NUNCA la uses si no encontraste un problema real y verificado — la regla \
    ANTI-FABRICACIÓN DE CAUSA RAÍZ de más abajo sigue aplicando con la misma severidad: no \
    inventes un problema solo para tener algo que ofrecer corregir.

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
  ✗ PROHIBIDO — ANTI-FABRICACIÓN DE CAUSA RAÍZ: si el usuario no pidió explícitamente un
    fix, patch o corrección (verbos como "arreglá", "corregí", "aplicá", "implementá"),
    NUNCA inventes ni fuerces una "causa raíz" solo para tener algo que reportar. Si la
    investigación no encontró un problema real y verificado en el código, decilo con
    honestidad — "no encontré un problema concreto en el código revisado" es una respuesta
    válida y preferible a fabricar un hallazgo. Notar algo mejorable (ej. manejo de errores
    ausente, un catch vacío) está permitido SOLO como observación en prosa al final de tu
    respuesta, nunca presentado como "la causa raíz del bug" si no hay evidencia de que algo
    esté fallando en producción.

No inferás lo que no leíste. Citá fragmentos exactos (breves) para respaldar tus afirmaciones, \
incluso en el modo comprimido.

REGLA ANTI-RELLENO NUMÉRICO — obligatoria: si el fragmento menciona el NOMBRE de una \
constante (ej. MIN_SL_PCT, MAX_SL_PCT, ATR_SL_MULT) pero NO muestra su valor asignado \
literalmente en el código visible, NUNCA completes ni estimes ese valor — ni con un número \
"típico" del dominio, ni por cálculo inverso a partir de otros ejemplos. Escribí explícitamente \
que la constante existe pero su valor no está confirmado en el fragmento disponible \
(ej: "el porcentaje exacto de MIN_SL_PCT no está confirmado en este fragmento"). \
Esto aplica en modo comprimido y expandido por igual — la brevedad nunca justifica \
completar un dato no verificado.

VERIFICACIÓN OBLIGATORIA VÍA deep_search — antes de afirmar CUALQUIER valor numérico de \
configuración (porcentajes, umbrales, multiplicadores, límites), verificá que ese valor \
específico aparece LITERALMENTE en la evidencia ya reunida en esta conversación. Si no \
aparece, y la herramienta deep_search está disponible, LLAMALA con el nombre exacto de \
la constante (ej. deep_search(query: "maxSlPct|MIN_SL_PCT|MAX_SL_PCT")) ANTES de escribir \
tu respuesta — no sintetices primero y verifiques después. Solo si deep_search tampoco \
encuentra el valor, aplicá la REGLA ANTI-RELLENO NUMÉRICO de arriba (declarar que no está \
confirmado).

PROHIBIDO SUSTITUIR UNA VARIABLE POR OTRA "PARECIDA" — nunca uses el valor de una variable \
de configuración para responder sobre una variable DISTINTA, aunque ambas sean porcentajes \
del mismo dominio (ej. "riesgo por trade" y "SL máximo" son parámetros independientes — \
uno determina el tamaño de la posición, el otro el límite de pérdida — NUNCA uses el valor \
de uno para afirmar el valor del otro, ni asumas que son iguales). Si ves dos porcentajes \
distintos en el código o los fragmentos y no estás seguro de cuál corresponde a la pregunta, \
citá ambos por separado con su nombre de variable exacto, en vez de elegir uno.

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

const GROQ_CONTEXT_AWARE_SYSTEM = `Sos un asistente que responde preguntas sobre código de trading. Tenés disponible el fragmento de código que se leyó en el turno ANTERIOR de esta misma conversación — puede ser útil para la pregunta actual, o puede no tener nada que ver.

Tu trabajo:
1. Leé la pregunta actual del usuario y el fragmento de código disponible.
2. Si el fragmento contiene información suficiente para responder la pregunta actual con precisión — aunque la pregunta use términos que no aparecían en la búsqueda original, mientras el fragmento los mencione o los explique — respondé directamente:
   - Máximo 6-8 líneas de prosa conectada, sin bullets ni bloques de código.
   - Citá archivo:línea entre paréntesis para respaldar afirmaciones puntuales.
   - Usá los nombres técnicos de trading exactos (FVG, EMA, SuperTrend, RSI, ADX, ATR, Score, etc.) — nunca los parafrasees.
   - Terminá siempre con esta línea exacta: "💬 Pedime 'más detalle' si querés el desglose completo con código y ejemplos."
3. Si el fragmento NO tiene relación con la pregunta actual, o la cubre solo parcialmente y falta algo importante — NO inventes ni completes con conocimiento genérico. Respondé ÚNICAMENTE con: "NEEDS_SEARCH: " seguido de una razón breve (una frase) de qué falta o qué habría que buscar.

VARIABLES DE DOMINIO — convenciones fijas en repos de trading (Signal OS, Ahorar, etc.):
  • \`st\`, \`stDir\`, \`stDirArr\` → dirección del indicador SuperTrend (NO Parabolic SAR — son indicadores distintos, nunca los intercambies).
  • \`sa\`, \`sb\` → Score alcista y Score bajista (índice numérico de momentum/dirección). NUNCA los asocies con "SAR".
  • \`fvgBull\`, \`fvgBear\` → FVG (Fair Value Gap) alcista / bajista.
  • \`noAgot\` → sin agotamiento de momentum (booleano).
  • \`ema\`/\`emaFast\`/\`emaSlow\` → EMA. \`rsi\`/\`rsiVal\` → RSI. \`adx\`/\`adxVal\` → ADX. \`atr\`/\`atrVal\` → ATR.

Si una variable corta (\`sa\`, \`sb\`, \`st\`, etc.) no está en la tabla de arriba ni tiene definición visible en el fragmento, escribí: "no pude confirmar qué representa \`[var]\` en este fragmento — no la renombro." No la deduzcas por parecido visual con un acrónimo.`;

// Tools available for Sonnet synthesis turn — no search tools, only read + patch
// Sonnet only gets propose_patch — it must not re-investigate with search tools.
// Haiku already gathered all context; Sonnet's job is to write the patch.
const SONNET_SYNTHESIS_TOOLS = CHAT_TOOLS.filter(t => t.name === 'propose_patch');

const SUGGEST_SONNET_RE = /<<SUGGEST_SONNET:\s*(.+?)\s*>>\s*$/s;

/** Extrae la señal invisible <<SUGGEST_SONNET: ...>> del texto de Haiku, si existe.
 *  Devuelve el texto limpio (sin la línea de señal) y el motivo, o null si no hay señal. */
function extractSonnetSuggestion(text: string): { cleanText: string; reason: string | null } {
  const match = text.match(SUGGEST_SONNET_RE);
  if (!match) return { cleanText: text, reason: null };
  return { cleanText: text.slice(0, match.index).trimEnd(), reason: match[1].trim() };
}

async function runHaikuTier(
  messages: any[],
  repo: string,
  send: (event: string, data: Record<string, unknown>) => void,
  sessionId: string,
  maxSteps = 12,
  allowPatch = true,
  auditMode = false,
): Promise<{ resolved: boolean; messages: any[]; foundFiles: boolean; suggestion?: { reason: string } | null }> {
  send('action', { text: '⚡ Haiku 4.5 — exploración inteligente del codebase' });
  send('model_active', { model: 'Haiku 4.5', tier: 'balanced' });
  // En modo auditoría, el FORMATO POR DEFECTO (compresión a 4-5 líneas, sin
  // headers, máx 2 citas) se reemplaza por instrucciones de respuesta punto
  // por punto con citas directas. HAIKU_AUDIT_FORMAT_OVERRIDE se prepone al
  // sistema para que tome precedencia sobre la sección FORMATO POR DEFECTO.
  const haikuSystem = auditMode
    ? HAIKU_AUDIT_FORMAT_OVERRIDE + '\n\n' + HAIKU_SEARCH_SYSTEM
    : HAIKU_SEARCH_SYSTEM;

  let foundFiles = false;
  let pendingSuggestion: { reason: string } | null = null;
  // Cambio 1 — count consecutive shallow searches (grep_code / read_file)
  // without an intervening deep_search call. Reset to 0 whenever deep_search
  // or task_complete is called, or when the forced message is injected.
  let consecutiveShallowSearches = 0;

  for (let step = 0; step < maxSteps; step++) {
    // Cambio 2 — "2 steps left" hard warning injected into the last user
    // message so Haiku receives it before this API call.
    if (step === maxSteps - 2 && messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
        lastMsg.content.push({
          type: 'text',
          text: `⚠️ ADVERTENCIA FINAL: Te quedan 2 pasos antes del límite. ` +
                `En tu PRÓXIMA respuesta debés sintetizar la respuesta final ` +
                `con la evidencia disponible — no hagas más llamadas a herramientas de búsqueda.`,
        });
        console.log(`[runHaikuTier] inyectando advertencia de presupuesto final (paso ${step}/${maxSteps})`);
      }
    }

    // ── Prompt size monitoring (mirrors callGroqAgent promptLen pattern) ──────
    {
      const msgsPayload = compressOldToolResults(messages);
      const approxChars =
        haikuSystem.length +
        JSON.stringify(msgsPayload).length;
      console.log(`[runHaikuTier] step ${step}/${maxSteps} — prompt ~${approxChars} chars (~${Math.round(approxChars / 4)} tokens est.)`);
    }
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
        system: [{ type: 'text', text: haikuSystem, cache_control: { type: 'ephemeral' } }],
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
      const { cleanText, reason } = extractSonnetSuggestion(t.text as string);
      send('chat_message', { text: cleanText });
      if (reason) {
        pendingSuggestion = { reason };
        send('suggest_sonnet', { reason });
      }
    }

    const toolUses = data.content.filter((b: any) => b.type === 'tool_use');
    if (toolUses.length === 0) {
      // Check if Haiku signalled no results via the sentinel text
      const allText = textBlocks.map((b: any) => b.text as string).join('\n');
      if (allText.includes('BÚSQUEDA_SIN_RESULTADOS')) {
        return { resolved: false, messages, foundFiles: false, suggestion: null };
      }
      return { resolved: true, messages, foundFiles, suggestion: pendingSuggestion };
    }

    const toolExecutions = await Promise.all(
      toolUses.map(async (tool: any) => ({
        tool,
        resultText: await executeChatTool(tool.name, tool.input, repo, send, sessionId, auditMode),
      })),
    );

    const toolResults: any[] = [];
    for (const { tool, resultText } of toolExecutions) {
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
      // Cambio 1 — update consecutive-shallow-search counter
      if (tool.name === 'grep_code' || tool.name === 'read_file') {
        consecutiveShallowSearches++;
      } else if (tool.name === 'deep_search' || tool.name === 'task_complete') {
        consecutiveShallowSearches = 0;
      }
    }

    // Cambio 1 — inject forced synthesis message when 3+ shallow searches
    // have run since the last deep_search (or since the start).
    if (consecutiveShallowSearches >= 3) {
      toolResults.push({
        type: 'text',
        text: `⚠️ STOP: Llevás ${consecutiveShallowSearches} búsquedas seguidas ` +
              `(grep_code/read_file) sin usar deep_search ni responder. ` +
              `Con la evidencia que ya reuniste, generá la respuesta final AHORA. ` +
              `Si de verdad falta algo crítico, tu ÚNICA opción en este paso es llamar ` +
              `deep_search (no grep_code ni read_file) para completarlo — ` +
              `no seguir con búsquedas sueltas.`,
      });
      console.log(`[runHaikuTier] inyectando mensaje forzoso: ${consecutiveShallowSearches} búsquedas consecutivas sin deep_search (paso ${step})`);
      consecutiveShallowSearches = 0; // reset after injection
    }

    messages.push({ role: 'user', content: toolResults });
  }

  // Cambio 3 — safety-net synthesis: instead of returning an empty "limit reached"
  // response, make one additional tool-free call so Haiku can synthesize from the
  // accumulated tool_result history rather than leaving the user with no answer.
  send('action', { text: '🧠 Haiku alcanzó el límite — forzando síntesis final' });
  console.log('[runHaikuTier] maxSteps exhausted — attempting forced synthesis');
  messages.push({
    role: 'user',
    content: [{
      type: 'text',
      text: `LÍMITE DE PASOS ALCANZADO. Con toda la evidencia acumulada en el historial ` +
            `de esta conversación, generá AHORA la respuesta final al usuario. ` +
            `No podés hacer más llamadas a herramientas — sintetizá directamente con lo que tenés. ` +
            `Si la evidencia es parcial, decilo honestamente en lugar de dejar al usuario sin respuesta.`,
    }],
  });
  try {
    // ── Prompt size monitoring — forced synthesis call ────────────────────────
    {
      const msgsPayload = compressOldToolResults(messages);
      const approxChars = haikuSystem.length + JSON.stringify(msgsPayload).length;
      console.log(`[runHaikuTier] síntesis forzada — prompt ~${approxChars} chars (~${Math.round(approxChars / 4)} tokens est.)`);
    }
    const synthRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        system: [{ type: 'text', text: haikuSystem }],
        // No tools — force a text-only synthesis response.
        messages: compressOldToolResults(messages),
      }),
    });
    if (synthRes.ok) {
      const synthData = await synthRes.json() as { type?: string; content: any[] };
      if (synthData.type !== 'error' && Array.isArray(synthData.content)) {
        messages.push({ role: 'assistant', content: synthData.content });
        const synthText = synthData.content.filter((b: any) => b.type === 'text');
        for (const t of synthText) {
          send('chat_message', { text: t.text });
        }
        if (synthText.length > 0) {
          return { resolved: true, messages, foundFiles };
        }
      }
    }
  } catch (e) {
    console.error('[runHaikuTier] forced synthesis call failed:', e);
  }
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
  triggerSonnet = false,
): Promise<void> {
  // ── Botón "Generar con Sonnet" — el usuario confirmó una sugerencia que Haiku
  // hizo al final de una exploración anterior. Saltamos Groq/Haiku por completo y
  // reusamos el historial ya guardado (que incluye toda la exploración y evidencia
  // que Haiku ya leyó) como punto de partida para Sonnet. `userMessage` acá lleva
  // el texto del "reason" de la sugerencia, no un mensaje tipeado por el usuario.
  if (triggerSonnet) {
    const priorMessages = await loadChatHistory(sessionId);
    const instruction =
      `[El usuario confirmó que querés que generes el patch para el hallazgo que sugeriste: ` +
      `"${userMessage}". Basate en la exploración y evidencia ya presentes en el historial de ` +
      `esta conversación — no vuelvas a buscar desde cero. Generá el patch con propose_patch.]`;
    const sonnetMessages = [...priorMessages, { role: 'user', content: instruction }];
    await runSonnetPhase(sonnetMessages, repo, send, sessionId, userMessage);
    return;
  }

  const history = await loadChatHistory(sessionId);

  // Modo auditoría: preguntas numeradas o con frases de verificación puntual.
  // Activa criterio de confianza más estricto en DEEP y formato de respuesta
  // punto por punto en Haiku. No habilita ningún camino hacia Sonnet.
  const auditMode = isAuditQuery(userMessage);
  if (auditMode) {
    console.log(`[runChatTurn] modo auditoría detectado: "${userMessage.slice(0, 80)}"`);
  }

  // ── Detección de investigación profunda (multi-turn sobre el mismo concepto) ──
  // Si el usuario escribe /save, marca para guardarse explícitamente.
  if (userMessage.toLowerCase().includes('/save')) {
    sessionInvestigationState.shouldSave = true;
    userMessage = userMessage.replace(/\/save\s*/gi, '').trim();
    // si solo escribió /save, terminar aquí (no hay mensaje real que procesar)
    if (!userMessage) return;
  }

  // Extraer términos principales del mensaje para agrupar investigaciones
  const _invTerms = extractKeywordsFromMessage(userMessage)
    .filter(t => t.length >= 4)
    .map(t => t.toLowerCase());

  sessionInvestigationState.turnCount++;
  sessionInvestigationState.turnHistory.push({
    term: _invTerms[0] ?? 'general',
    timestamp: Date.now(),
  });
  _invTerms.forEach(t => sessionInvestigationState.topicTerms.add(t));

  // Auto-detectar investigación multi-turn: 3+ preguntas sobre ≤3 temas distintos
  if (
    sessionInvestigationState.turnCount >= 3 &&
    sessionInvestigationState.topicTerms.size <= 3 &&
    !sessionInvestigationState.shouldSave
  ) {
    sessionInvestigationState.shouldSave = true;
    console.log(
      `[investigation] multi-turn detectado — ${sessionInvestigationState.turnCount} preguntas sobre ${Array.from(sessionInvestigationState.topicTerms).join(', ')}`,
    );
  }

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
  const haikuUsedAt = SESSION_HAIKU_USED.get(sessionId);
  const haikuStillActive = haikuUsedAt !== undefined && (Date.now() - haikuUsedAt) < SESSION_HAIKU_TTL_MS;

  const complexity: 'simple' | 'complex' = forceGroq
    ? 'simple'
    : haikuStillActive
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

  // Límite defensivo: cacheHint puede crecer sin cota con conceptos muy
  // investigados (repo_knowledge + contexto compartido + investigaciones
  // previas acumuladas) y provocar que el prompt total exceda el límite
  // de tokens de Groq, causando fallo en las 3 keys sin distinción de causa.
  const CACHE_HINT_CHAR_LIMIT = 6000;
  if (cacheHint.length > CACHE_HINT_CHAR_LIMIT) {
    console.warn(`[runChatTurn] cacheHint truncado: ${cacheHint.length} → ${CACHE_HINT_CHAR_LIMIT} chars`);
    cacheHint = cacheHint.slice(0, CACHE_HINT_CHAR_LIMIT) + '\n\n[... contexto adicional truncado por longitud — usar deep_search si falta información específica]';
  }

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

    // ── Grounding contra el índice real de símbolos — reemplaza la lista fija
    // de palabras de dominio. Si el mensaje menciona algo que existe de verdad
    // en el código de este repo, forzamos la búsqueda directamente, sin pagar
    // ni arriesgar la llamada de triage a Groq (que puede alucinar una
    // definición genérica para términos ambiguos como "circuit breaker").
    const grounding = await isGroundedInRepoSymbols(userMessage, repo);

    let groqAnswer: string;
    let groqReason: string;

    if (grounding.grounded) {
      console.log(`[grounding] "${grounding.matchedTerm}" → símbolo real "${grounding.matchedSymbol}" en ${repo} — forzando búsqueda, sin llamar a Groq triage`);
      groqAnswer = `NEEDS_TOOLS: "${grounding.matchedTerm}" coincide con el símbolo real "${grounding.matchedSymbol}" en este repo`;
      groqReason = groqAnswer.replace('NEEDS_TOOLS:', '').trim();
    } else {
      // Convert the stored session history (Anthropic format) to the flat {role, content}
      // array Groq expects — stripping all tool_use / tool_result blocks so Groq only
      // sees the conversational text thread, not the raw code-search internals.
      // `cacheHint` (DEEP evidence, shared summaries) stays in the system prompt as
      // complementary context on top of the real turn history.
      groqAnswer = await callGroqAgent(
        userMessage,
        await buildTriagePrompt(cacheHint, repo),
        fastFinding ? 768 : 512,
        groqHistory,
        0,
      );

      // Parsing tolerante: Groq puede envolver el sentinel en markdown
      // (**NEEDS_TOOLS:**), agregar texto antes, o variar mayúsculas/espacios.
      // startsWith() exacto se rompe con cualquiera de esas variantes.
      const needsToolsMatch = groqAnswer.match(/\*{0,2}NEEDS_TOOLS:\*{0,2}\s*(.*)/is);

      if (!needsToolsMatch) {
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

      groqReason = needsToolsMatch[1].trim();
    }

    // ── Router de complejidad de búsqueda ─────────────────────────────────────
    // Para preguntas de lookup directo (S1, trailing stop, etc.) evitamos el
    // runDeepSearchPipeline completo — ripgrep + fragmento + Groq es suficiente
    // y es la misma estrategia que FAST mode usa exitosamente.
    // Si la ruta rápida falla o la pregunta es multi-hop, cae al DEEP pre-fetch.
    const searchComplexity = classifySearchComplexity(
      userMessage,
      groqHistory.map((m: any) => ({ role: m.role as string, content: typeof m.content === 'string' ? m.content : '' })),
    );

    if (searchComplexity === 'simple' && classifyIntent(userMessage) === 'explain') {
      send('action', { text: `🔍 Búsqueda rápida — lookup directo (${groqReason.slice(0, 60)})` });
      let fastPathHandled = false;
      try {
        const chatFastHistory = await loadFastHistory(sessionId!);
        const chatFastLastUser = chatFastHistory.slice().reverse().find((m: any) => m.role === 'user');
        const chatFastLastAss  = chatFastHistory.slice().reverse().find((m: any) => m.role === 'assistant');

        // ── Intento con contexto cacheado — Groq decide si alcanza o necesita buscar ──
        // En vez de una heurística previa que clasifica "es follow-up / no es follow-up",
        // si hay un fragmento del turno anterior SIEMPRE se lo ofrecemos a Groq como
        // contexto disponible y dejamos que decida. Esto cubre naturalmente cualquier
        // forma de pregunta de seguimiento, sin depender de reglas fijas de matching.
        let chatCachedHandled = false;
        const chatCachedGroundingTerms = localKeywordFallback(userMessage, 6);
        const chatCachedFragmentGrounded = chatCachedGroundingTerms.length > 0
          && chatCachedGroundingTerms.some(t => (chatFastLastAss?.fragment ?? '').toLowerCase().includes(t.toLowerCase()));
        if (chatFastLastAss?.fragment && !chatCachedFragmentGrounded) {
          console.log(`[chat-fast-cached-context] fragmento cacheado no grounded contra "${userMessage.slice(0, 60)}" — saltando a búsqueda nueva`);
        }
        if (chatFastLastAss?.fragment && chatCachedFragmentGrounded) {
          try {
            const chatCachedAttempt = await callGroqAgent(
              `Pregunta actual: "${userMessage}"\n\nFragmento de código disponible (leído en el turno anterior, ${chatFastLastUser?.path ?? 'archivo desconocido'}):\n${chatFastLastAss.fragment}`,
              GROQ_CONTEXT_AWARE_SYSTEM,
              512,
            );

            const needsSearchMatch = chatCachedAttempt.match(/NEEDS_SEARCH:\s*(.*)/is);
            if (!needsSearchMatch) {
              send('action', { text: '⚡ Ruta rápida — respondiendo con contexto ya disponible...' });
              send('chat_message', { text: chatCachedAttempt });

              const _ccaWithPaths =
                chatCachedAttempt + `\n\n<evidence_files>\n${chatFastLastUser?.path ?? ''}\n</evidence_files>`;
              messages.push({ role: 'assistant', content: [{ type: 'text', text: _ccaWithPaths }] });
              await saveChatHistory(sessionId, messages);

              const updatedChatFastHistoryFromCache = [
                ...chatFastHistory,
                { role: 'user',      content: userMessage,       keywords: [] },
                { role: 'assistant', content: chatCachedAttempt, fragment: chatFastLastAss.fragment, path: chatFastLastUser?.path },
              ];
              await saveFastHistory(sessionId!, updatedChatFastHistoryFromCache).catch(() => {});

              send('confidence', {
                level: 'medium',
                reason: 'CHAT — ruta rápida: respondido con fragmento ya cacheado, sin nueva búsqueda',
                suggestedAction: 'none',
              });
              send('done', { files: [], commitMessage: '', mainComponent: chatFastLastUser?.path ?? '', mainContent: '', repo, branch: '' });
              chatCachedHandled = true;
            } else {
              const needSearchReason = needsSearchMatch[1].trim();
              send('action', { text: `🔍 El contexto ya leído no alcanza (${needSearchReason.slice(0, 80)}) — buscando...` });
            }
          } catch (chatCacheErr) {
            console.warn('[chat-fast-cached-context] intento con contexto cacheado falló, cayendo a búsqueda normal:', chatCacheErr instanceof Error ? chatCacheErr.message : chatCacheErr);
          }
        }

        if (chatCachedHandled) {
          fastPathHandled = true;
        } else {
          // Flujo de búsqueda normal — ripgrep + fragmento + Groq:
          const chatFastTerms = await extractKeywordsForSearch(userMessage, repo);

          // ── Chequear conocimiento persistente ANTES de buscar ────────────────────
          const chatFastKnowledge = await loadRepoKnowledgeVerified(repo, chatFastTerms, userMessage);
          if (chatFastKnowledge) {
            send('action', { text: `📚 Conocimiento persistente reutilizado — "${chatFastKnowledge.concept}" (verificado ${new Date(chatFastKnowledge.verified_at).toLocaleDateString()})` });
            try {
              const chatKnowledgeSynthesis = await callGroqAgent(
                `Pregunta: "${userMessage}"\n\nEvidencia confirmada (conocimiento persistente ya verificado):\n${chatFastKnowledge.summary}`,
                GROQ_SINGLE_FRAGMENT_SYSTEM,
                512,
              );
              send('chat_message', { text: chatKnowledgeSynthesis });
              const primaryFile = chatFastKnowledge.source_files[0];
              const _ckPaths = primaryFile?.path ?? '';
              const _ckAssistantWithPaths =
                chatKnowledgeSynthesis + `\n\n<evidence_files>\n${_ckPaths}\n</evidence_files>`;
              messages.push({ role: 'assistant', content: [{ type: 'text', text: _ckAssistantWithPaths }] });
              await saveChatHistory(sessionId, messages);
              const updatedChatFastHistoryFromKnowledge = [
                ...chatFastHistory,
                { role: 'user',      content: userMessage,            keywords: chatFastTerms },
                { role: 'assistant', content: chatKnowledgeSynthesis, fragment: chatFastKnowledge.summary, path: _ckPaths },
              ];
              await saveFastHistory(sessionId!, updatedChatFastHistoryFromKnowledge).catch(() => {});
              send('confidence', {
                level: chatFastKnowledge.confidence === 'high' ? 'high' : 'medium',
                reason: 'CHAT — ruta rápida: memoria persistente reutilizada, sin nueva búsqueda',
                suggestedAction: 'none',
              });
              send('done', { files: [], commitMessage: '', mainComponent: _ckPaths, mainContent: '', repo, branch: '' });
              fastPathHandled = true;
            } catch (chatKnowledgeErr) {
              console.warn('[chat-fast-knowledge] síntesis desde conocimiento persistente falló, cayendo a búsqueda nueva:', chatKnowledgeErr instanceof Error ? chatKnowledgeErr.message : chatKnowledgeErr);
              // sin marcar fastPathHandled — cae al flujo normal de abajo
            }
          }

          if (!fastPathHandled) {
            const chatFastPattern = chatFastTerms.length > 0
              ? chatFastTerms.join('|')
              : localKeywordFallback(userMessage).join('|');
            if (chatFastPattern.length > 0) {
              const { matches: chatFastMatches, allTest: chatFastAllTest } = await searchWithTestFallback(chatFastPattern, repo, send);
              const chatFastBest = chatFastMatches.find(m => !isTestMatch(m.path, m.text ?? '')) ?? chatFastMatches[0];
              if (chatFastBest && chatFastAllTest) {
                send('action', { text: '⚠️ Solo encontré código de test — el símbolo de producción puede tener un nombre diferente.' });
              }
              if (chatFastBest) {
                send('action', { text: `📍 Símbolo encontrado: ${chatFastBest.path}${chatFastBest.line ? `:${chatFastBest.line}` : ''}` });
                const chatFastContent = await getFileContent(chatFastBest.path, repo);
                const chatFastSection = chatFastBest.line
                  ? (readEnclosingFunction(chatFastContent, chatFastBest.line) ?? smartReadSection(chatFastContent, chatFastBest.line, 60))
                  : null;
                if (chatFastSection) {
                  const chatFastFragment = chatFastSection.excerpt ?? '';
                  const chatFastSynthesis = await callGroqAgent(
                    `Pregunta: "${userMessage}"\n\nFragmento de código (${chatFastBest.path}, líneas ${chatFastSection.startLine}-${chatFastSection.endLine}):\n${chatFastFragment}`,
                    GROQ_SINGLE_FRAGMENT_SYSTEM,
                    512,
                  );
                  send('chat_message', { text: chatFastSynthesis });
                  const _cfPaths = chatFastBest.path;
                  const _cfAssistantWithPaths =
                    chatFastSynthesis + `\n\n<evidence_files>\n${_cfPaths}\n</evidence_files>`;
                  messages.push({ role: 'assistant', content: [{ type: 'text', text: _cfAssistantWithPaths }] });
                  await saveChatHistory(sessionId, messages);
                  send('confidence', {
                    level: 'medium',
                    reason: 'CHAT — ruta rápida: ripgrep + fragmento + Groq (lookup directo)',
                    suggestedAction: 'none',
                  });
                  send('done', { files: [{ path: chatFastBest.path, lineRanges: chatFastBest.line ? [{ start: chatFastSection.startLine, end: chatFastSection.endLine, matchedTerm: chatFastTerms[0] }] : [] }], commitMessage: '', mainComponent: chatFastBest.path, mainContent: '', repo, branch: '' });
                  const updatedChatFastHistory = [
                    ...chatFastHistory,
                    { role: 'user',      content: userMessage,       keywords: chatFastTerms },
                    { role: 'assistant', content: chatFastSynthesis, fragment: chatFastFragment, path: chatFastBest.path },
                  ];
                  await saveFastHistory(sessionId!, updatedChatFastHistory).catch(() => {});
                  // ── Guardar conocimiento nuevo para la próxima vez ──────────────────
                  if (chatFastTerms.length > 0) {
                    const chatFastConfidence = (chatFastBest.symbolType && !chatFastAllTest) ? 'high' : 'medium';
                    saveRepoKnowledge(
                      repo,
                      chatFastTerms[0],
                      chatFastFragment,
                      [{ path: chatFastBest.path, startLine: chatFastSection.startLine, endLine: chatFastSection.endLine }],
                      chatFastConfidence,
                    ).catch(() => {});
                  }
                  fastPathHandled = true;
                }
              }
            }
          }
        }
      } catch (chatFastErr) {
        console.warn('[chat-fast-path] ruta rápida falló, cayendo a DEEP pre-fetch:', chatFastErr instanceof Error ? chatFastErr.message : chatFastErr);
      }
      if (fastPathHandled) return;
    }

    send('action', { text: `🧠 Groq → ${groqReason.slice(0, 80)} — ejecutando DEEP pre-fetch` });

    // ── DEEP pre-fetch con planificación previa: descompone la pregunta en
    // sub-preguntas ANTES de buscar, en vez de que Haiku descubra reactivamente
    // qué falta paso a paso. Reduce rondas de deep_search en preguntas complejas.
    {
      const planHistStr = groqHistory.slice(-6)
        .map((m: any) => `${m.role === 'user' ? 'Usuario' : 'Asistente'}: ${m.content}`)
        .join('\n');
      const planSteps = await planSearchSteps(userMessage, planHistStr);
      const searchQueries: string[] = planSteps.length > 0 ? planSteps : [userMessage];

      send('action', {
        text: planSteps.length > 1
          ? `🗺️ Plan de búsqueda — ${planSteps.length} sub-pregunta(s) identificadas`
          : '🔍 DEEP pre-fetch — búsqueda directa',
      });

      const allEvidence: AnnotatedFragment[] = [];
      const seenFragmentKeys = new Set<string>();

      await Promise.all(searchQueries.map(async (subQuery, idx) => {
        try {
          let subKws = await extractKeywordsForSearch(subQuery, repo);
          if (!subKws || subKws.length === 0) subKws = extractKeywordsFromMessage(subQuery);
          if (subKws.length === 0) return;

          // ── Chequear conocimiento persistente ANTES de buscar ──────────────────
          const knowledge = await loadRepoKnowledgeVerified(repo, subKws, subQuery);
          if (knowledge) {
            send('action', { text: `📚 [${idx + 1}/${searchQueries.length}] Conocimiento persistente reutilizado — "${knowledge.concept}" (verificado ${new Date(knowledge.verified_at).toLocaleDateString()})` });
            for (const sf of knowledge.source_files) {
              const key = `${sf.path}:${sf.startLine}`;
              if (!seenFragmentKeys.has(key)) {
                seenFragmentKeys.add(key);
                allEvidence.push({
                  path: sf.path,
                  line: sf.startLine,
                  endLine: sf.endLine,
                  fragment: knowledge.summary,
                  fragmentType: 'DEFINITION',
                  confidence: knowledge.confidence === 'high' ? 'HIGH' : 'MEDIUM',
                  purpose: `Conocimiento persistente: ${knowledge.concept}`,
                  relatedSymbols: [],
                  hopLevel: 0,
                });
              }
            }
            return; // no repetir la búsqueda para esta sub-pregunta
          }

          // ── Sin conocimiento previo — buscar como hasta ahora ──────────────────
          const allKws = [...subKws, ...reformulateQueryTerms(subKws)];
          const subPattern = allKws.join('|');
          if (planSteps.length > 1) {
            send('action', { text: `🔍 [${idx + 1}/${searchQueries.length}] ${subQuery.slice(0, 60)} — buscando: ${subKws.join(', ')}` });
          } else {
            send('action', { text: `🔍 DEEP pre-fetch — keywords: ${subKws.join(', ')}` });
          }

          let subResult = await searchWithTestFallback(subPattern, repo, send);

          // Reintento con reformulación de segundo orden — mismo mecanismo que ya
          // usa la tool deep_search para Haiku, aplicado acá al pre-fetch paralelo
          // de Groq para que una sub-pregunta del plan no se pierda en silencio.
          if (subResult.matches.length === 0) {
            const retryKws = reformulateQueryTerms(allKws);
            if (retryKws.length > 0) {
              const retryPattern = retryKws.join('|');
              send('action', { text: `🔄 [${idx + 1}/${searchQueries.length}] Sin resultados — reintentando con: ${retryKws.slice(0, 3).join(', ')}…` });
              subResult = await searchWithTestFallback(retryPattern, repo, send);
              if (subResult.matches.length > 0) {
                allKws.push(...retryKws);
              }
            }
          }

          if (subResult.matches.length === 0) return;

          const subProd = subResult.matches.filter((m) => !isTestMatch(m.path, m.text));
          const subRanked = subProd.length > 0 ? subProd : subResult.matches;
          const subEvidence = await runDeepSearchPipeline(subRanked, allKws, repo, send, determineMaxHops(subQuery), false, subQuery, auditMode);

          for (const ev of subEvidence) {
            const key = `${ev.path}:${ev.line}`;
            if (!seenFragmentKeys.has(key)) {
              seenFragmentKeys.add(key);
              allEvidence.push(ev);
            }
          }

          // ── Guardar conocimiento nuevo para la próxima vez ─────────────────────
          if (subEvidence.length > 0) {
            const combinedFragment = subEvidence.map(e => e.fragment).join('\n\n---\n\n');
            const sourceFiles = subEvidence.map(e => ({ path: e.path, startLine: e.line, endLine: e.endLine }));
            const avgConfidence = subEvidence.every(e => e.confidence === 'HIGH') ? 'high' : 'medium';
            saveRepoKnowledge(repo, subKws[0], combinedFragment, sourceFiles, avgConfidence).catch(() => {});
          }
        } catch {
          // No-fatal — una sub-pregunta que falla no debe tumbar las demás
        }
      }));

      // ── Post-pipeline merge: fusionar fragmentos solapados o próximos (≤15 líneas)
      // del mismo archivo. Sin esto, sub-preguntas paralelas que leen rangos distintos
      // del mismo código (ej: 1620-1650 y 1640-1668) llegan a Haiku como fragmentos
      // separados sin el contexto compartido que los conecta.
      if (allEvidence.length > 1) {
        const MERGE_GAP = 15;
        const sorted = [...allEvidence].sort((a, b) =>
          a.path !== b.path ? a.path.localeCompare(b.path) : a.line - b.line,
        );
        const merged: AnnotatedFragment[] = [];
        for (const ev of sorted) {
          const last = merged[merged.length - 1];
          const lastEnd = last?.endLine ?? last?.line ?? -1;
          if (last && last.path === ev.path && ev.line <= lastEnd + MERGE_GAP) {
            // Rangos solapados o a ≤15 líneas — fusionar y releer el rango unificado
            const mergedStart = Math.min(last.line, ev.line);
            const mergedEnd   = Math.max(lastEnd, ev.endLine ?? ev.line);
            try {
              const fc = await getFileContent(last.path, repo);
              const fileLines = fc.split('\n');
              const excerpt = fileLines
                .slice(mergedStart - 1, mergedEnd)
                .map((l, i) => `${mergedStart + i}: ${l}`)
                .join('\n');
              merged[merged.length - 1] = {
                ...last,
                line:       mergedStart,
                endLine:    mergedEnd,
                fragment:   excerpt,
                confidence: (ev.confidence === 'HIGH' || last.confidence === 'HIGH') ? 'HIGH' : 'MEDIUM',
              };
              console.log(
                `[allEvidence] fusión: ${last.path} [${last.line}-${lastEnd}] + ` +
                `[${ev.line}-${ev.endLine ?? ev.line}] → [${mergedStart}-${mergedEnd}] ` +
                `(${mergedEnd - mergedStart + 1} líneas)`,
              );
            } catch {
              console.warn(`[allEvidence] fusión: re-read falló para ${last.path}, fragmento descartado`);
            }
          } else {
            merged.push(ev);
          }
        }
        if (merged.length !== allEvidence.length) {
          console.log(`[allEvidence] merge pass: ${allEvidence.length} fragmentos → ${merged.length} tras fusión`);
          allEvidence.length = 0;
          allEvidence.push(...merged);
        }
      }

      if (allEvidence.length > 0) {
        const evidenceSummary = formatDeepEvidenceForHaiku(allEvidence, userMessage, repo);
        const evidencePlain = allEvidence.map(e => `${e.path}:${e.line}\n${e.fragment}`).join('\n\n---\n\n');

        // Enrutamiento Groq vs Haiku: 1 fragmento autocontenido + intención de
        // EXPLICACIÓN (no generación de código) → Groq interpreta directo, sin Haiku.
        // 2+ fragmentos (requieren cruzarse) o intención de GENERAR código → sigue a Haiku.
        if (allEvidence.length === 1 && classifyIntent(userMessage) === 'explain') {
          send('action', { text: '⚡ 1 fragmento autocontenido — Groq interpreta directo (sin Haiku)' });
          try {
            const groqSynthesis = await callGroqAgent(
              `Pregunta: "${userMessage}"\n\nEvidencia confirmada (DEEP mode):\n${evidencePlain}`,
              GROQ_SINGLE_FRAGMENT_SYSTEM,
              512,
            );
            send('chat_message', { text: groqSynthesis });
            const _evPaths = allEvidence.map(e => e.path).join('\n');
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
          `\n\nEVIDENCIA VERIFICADA (DEEP mode — plan de búsqueda con ${searchQueries.length} sub-pregunta(s) ` +
          `ejecutadas en paralelo, lectura real del código fuente, fragmentos anotados por tipo). ` +
          `Si esta evidencia responde la pregunta por completo, sintetizá en prosa desde aquí (PASO 0) ` +
          `sin re-buscar. Si falta algo puntual, podés usar deep_search para completarlo:\n` +
          evidenceSummary;
        const lastMsg = messages[messages.length - 1];
        if (typeof lastMsg?.content === 'string') lastMsg.content += deepCtx;
        send('action', { text: `✅ Plan ejecutado — ${allEvidence.length} fragmento(s) consolidados de ${searchQueries.length} sub-pregunta(s)` });
      } else {
        send('action', { text: `⚠️ Plan de búsqueda sin resultados, Haiku investigará` });
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
      auditMode,
    );
    // BUG FIX (handoff a Sonnet nunca se disparaba en intent='generate'):
    // haikuResult.resolved se vuelve true cada vez que Haiku responde con texto
    // libre sin llamar ninguna tool — y como Haiku NUNCA tiene propose_patch
    // disponible, para preguntas de generación su única salida posible es texto
    // libre. Eso disparaba resolved=true SIEMPRE en intent='generate', cortando
    // el return acá antes de llegar al chequeo de intent más abajo, y Sonnet
    // nunca se invocaba — Haiku terminaba escribiendo el código él mismo en
    // prosa, violando la restricción de HAIKU_SEARCH_SYSTEM.
    // Fix: el atajo de "ya resuelto, no hace falta Sonnet" solo es válido para
    // intent === 'explain'. Para 'generate', SIEMPRE seguimos hacia Sonnet,
    // sin importar si Haiku ya escribió una respuesta en texto.
    if (haikuResult.resolved && intent === 'explain') {
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
    if (!haikuResult.foundFiles && !haikuResult.resolved) {
      // Two full search passes found nothing AND Haiku didn't produce a real
      // answer from existing session context either — don't escalate to Sonnet;
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

    // intent === 'generate': Haiku exploró y encontró los archivos relevantes.
    // En lugar de invocar a Sonnet automáticamente — lo que bypasea el gate de
    // confirmación del usuario — emitimos suggest_sonnet para que el frontend
    // muestre el botón de confirmación. Sonnet solo corre cuando el usuario
    // confirma explícitamente (triggerSonnet=true en un mensaje posterior,
    // manejado en línea ~6906). Esto elimina el riesgo de modificaciones no
    // autorizadas ante una clasificación de intención incorrecta (ej: una pregunta
    // descriptiva que matcheó 'generate' por un gerundio en cláusula reflexiva).
    send('suggest_sonnet', {
      reason: 'Haiku encontró los archivos relevantes. ¿Querés que Sonnet 5 aplique el cambio?',
    });
    await saveChatHistory(sessionId, haikuResult.messages);
  }
}

// ── Sonnet patch-generation phase (reusable) ──────────────────────────────────
// Se invoca desde dos lugares: el handoff automático de runChatTurn cuando
// intent === 'generate' (pedido explícito de modificación), y el path de
// triggerSonnet (confirmación por botón de una sugerencia que hizo Haiku).
async function runSonnetPhase(
  messages: any[],
  repo: string,
  send: (event: string, data: Record<string, unknown>) => void,
  sessionId: string,
  userMessage: string,
): Promise<void> {
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
router.post('/chat/close', async (req, res) => {
  const { sessionId, repo: bodyRepo } = req.body as { sessionId?: string; repo?: string };
  const repo = bodyRepo ?? process.env.GITHUB_REPO ?? '';
  if (!sessionId) { res.status(400).json({ error: 'sessionId required' }); return; }
  try {
    const messages = await loadChatHistory(sessionId);
    await saveInvestigationMemory(repo, messages, sessionInvestigationState);
    // Resetear state para el siguiente chat
    sessionInvestigationState = {
      topicTerms: new Set(),
      turnCount: 0,
      turnHistory: [],
      shouldSave: false,
    };
    res.json({ ok: true });
  } catch (err) {
    console.error('[chat/close] error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

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
  const { message, repo: bodyRepo, sessionId, findingId, forceGroq, triggerSonnet } = req.body as {
    message?: string; repo?: string; sessionId?: string; findingId?: string; forceGroq?: boolean; triggerSonnet?: boolean;
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
    await runChatTurn(sessionId, message, repo, send, 20, findingId, forceGroq ?? false, triggerSonnet ?? false);
    send('done', {});
  } catch (err) {
    const stack = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error('[CHAT] error en runChatTurn:', stack);
    send('error', { text: stack });
  }
  res.end();
});

export default router;
