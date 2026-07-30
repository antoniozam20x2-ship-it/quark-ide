import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { PROJECTS, type Project, type BoardBrief } from '../../App';

const API_BASE = (import.meta.env.VITE_API_URL ?? window.location.origin).replace(/\/$/, '');

const BACKEND_PROJECTS = ['Signal OS', 'Sniper OS', 'Nexus OS'];

function isBackendProject(name: string): boolean {
  return BACKEND_PROJECTS.some((b) => name.includes(b));
}

// ── Diff helpers ─────────────────────────────────────────────────────────────
type DiffLine = { type: 'same' | 'removed' | 'added'; text: string };

function computeLineDiff(a: string[], b: string[]): DiffLine[] {
  const m = a.length, n = b.length;
  // For very large files fall back to positional comparison (still O(n))
  if (m > 1500 || n > 1500) {
    const result: DiffLine[] = [];
    const max = Math.max(m, n);
    for (let i = 0; i < max; i++) {
      if (i < m && i < n) {
        if (a[i] === b[i]) result.push({ type: 'same', text: a[i] });
        else {
          result.push({ type: 'removed', text: a[i] });
          result.push({ type: 'added', text: b[i] });
        }
      } else if (i < m) result.push({ type: 'removed', text: a[i] });
      else result.push({ type: 'added', text: b[i] });
    }
    return result;
  }
  // LCS-based diff
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);

  const result: DiffLine[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.unshift({ type: 'same', text: a[i - 1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: 'added', text: b[j - 1] }); j--;
    } else {
      result.unshift({ type: 'removed', text: a[i - 1] }); i--;
    }
  }
  return result;
}

type PairedRow = {
  leftNum: number | null; leftText: string | null; leftType: 'same' | 'removed' | null;
  rightNum: number | null; rightText: string | null; rightType: 'same' | 'added' | null;
};

function toPairedRows(diff: DiffLine[]): PairedRow[] {
  const rows: PairedRow[] = [];
  let lNum = 1, rNum = 1, i = 0;
  while (i < diff.length) {
    const d = diff[i];
    if (d.type === 'same') {
      rows.push({ leftNum: lNum, leftText: d.text, leftType: 'same', rightNum: rNum, rightText: d.text, rightType: 'same' });
      lNum++; rNum++; i++;
    } else if (d.type === 'removed') {
      const next = diff[i + 1];
      if (next?.type === 'added') {
        rows.push({ leftNum: lNum, leftText: d.text, leftType: 'removed', rightNum: rNum, rightText: next.text, rightType: 'added' });
        lNum++; rNum++; i += 2;
      } else {
        rows.push({ leftNum: lNum, leftText: d.text, leftType: 'removed', rightNum: null, rightText: null, rightType: null });
        lNum++; i++;
      }
    } else {
      rows.push({ leftNum: null, leftText: null, leftType: null, rightNum: rNum, rightText: d.text, rightType: 'added' });
      rNum++; i++;
    }
  }
  return rows;
}

// Server-sent event shape
interface AgentEvent {
  event: 'action' | 'file' | 'done' | 'error' | 'replit_prompt' | 'confidence' | 'model_active';
  text?: string;
  path?: string;
  file?: string;
  task?: string;
  files?: { path: string; content: string; originalContent?: string }[];
  commitMessage?: string;
  mainComponent?: string;
  mainContent?: string;
  repo?: string;
  branch?: string;
  incomplete?: boolean;
  // confidence event fields
  level?: 'high' | 'medium' | 'low';
  reason?: string;
  suggestedAction?: 'deep' | 'chat';
  diagnosis?: string;
  findingId?: string;
}

// Local feed items (superset — includes synthetic 'code' events)
interface FeedItem {
  event: 'action' | 'file' | 'done' | 'error' | 'code' | 'replit_prompt' | 'user_message' | 'chat_message' | 'patch_proposal';
  text?: string;
  path?: string;
  content?: string;
  file?: string;
  task?: string;
  patchId?: string;
  old_str?: string;
  new_str?: string;
  reasoning?: string;
}

interface CommitResult {
  sha: string;
  owner: string;
  repo: string;
  files: { path: string; content: string }[];
  message: string;
}

interface FixResult {
  filePath: string;
  fixedContent: string;
  originalContent: string;
  branch: string;
}

interface ChatPatch {
  id: string;
  path: string;
  old_str: string;
  new_str: string;
  reasoning: string;
}

interface ConfidencePayload {
  level: 'high' | 'medium' | 'low';
  reason: string;
  suggestedAction: 'deep' | 'chat';
  files: string[];
  diagnosis: string;
}

const FIX_KEYWORDS = /\b(corrige|corrígeme|fix|arregla|repara|soluciona)\b/i;

// ── Design tokens — mirrors QuarkChat.tsx/Brous for visual consistency ─────────
const T = {
  // Tier accent colors (ModelIndicator shape + model name + active mode button)
  tierFast:     '#f5a623',   // amber  — Groq / FAST mode
  tierBalanced: '#22d3ee',   // cyan   — Haiku / DEEP mode
  tierDeep:     '#a855f7',   // violet — Sonnet / AUTO mode
  modeChat:     '#34d399',   // emerald — CHAT mode (conversational, not search)

  // Semantic action message colors
  actionFound:     '#34d399',
  actionSynthesis: '#38bdf8',
  actionWarn:      '#f5a623',
  actionError:     '#ef4444',
  actionNeutral:   'rgba(255,255,255,0.45)',

  // Keyword highlight in assistant messages
  keyword: '#f2c14e',

  // Liquid glass
  glassBg:        'rgba(255,255,255,0.06)',
  glassBorder:    'rgba(255,255,255,0.12)',
  glassBorderHi:  'rgba(255,255,255,0.20)',
  glassHighlight: 'rgba(255,255,255,0.15)',
  glassBlur:      'blur(20px) saturate(180%)',

  // User bubble tint
  userTint: 'rgba(168,85,247,0.11)',
} as const;

/** Map real backend emoji/patterns to semantic color. */
function categorizeActionMsg(text: string): string {
  if (/^❌/.test(text))               return T.actionError;
  if (/^⚠️/.test(text))              return T.actionWarn;
  if (/^(📌|📂|⚡|✅)/.test(text))  return T.actionFound;
  if (/^(💡|📚)/.test(text))         return T.actionSynthesis;
  if (/Plan ejecutado/i.test(text))  return T.actionSynthesis;
  if (/^🧠\s+Paso/.test(text))       return T.actionNeutral;  // step indicator
  if (/^🧠/.test(text))              return T.actionSynthesis; // analysis
  if (/^🎯/.test(text))              return T.actionSynthesis;
  // QuarkAgent-specific diagnostic labels
  if (/^CAUSA:/.test(text))          return T.actionError;
  if (/^DÓNDE:/.test(text))          return T.actionSynthesis;
  if (/^POR QUÉ:/.test(text))        return T.actionWarn;
  if (/^SOLUCIÓN:/.test(text))       return T.actionFound;
  return T.actionNeutral;
}

/** Parse **bold** markdown into golden <span>s; rest stays neutral. */
function parseMarkdownBold(text: string): React.ReactNode {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return parts.map((part, i) =>
    i % 2 === 1
      ? <span key={i} style={{ color: T.keyword, fontWeight: 600 }}>{part}</span>
      : part
  );
}

interface Props {
  activeProject: Project;
  onApplyToEditor: (code: string) => void;
  onShowPreview: (html: string) => void;
  initialPrompt?: string;
  onSendToWarRoom?: (brief: BoardBrief) => void;
  onProjectChange?: (p: Project) => void;
}

const LS_REPO_KEY  = 'quark-agent-repo';
const LS_MODE_KEY  = 'quark-agent-mode';

export default function QuarkAgent({ activeProject, onApplyToEditor, onShowPreview, initialPrompt, onSendToWarRoom, onProjectChange }: Props) {
  const [prompt, setPrompt]               = useState('');
  const [selectedRepo, setSelectedRepo]   = useState(
    () => localStorage.getItem(LS_REPO_KEY) ?? activeProject.repo ?? 'quark-ide',
  );
  const [running, setRunning]             = useState(false);
  const [feed, setFeed]                   = useState<FeedItem[]>([]);
  const [result, setResult]               = useState<AgentEvent | null>(null);
  const [hasReadResult, setHasReadResult] = useState(false);
  const [committing, setCommitting]       = useState(false);
  const [commitResult, setCommitResult]   = useState<CommitResult | null>(null);
  const [isGeneratingHtml, setIsGeneratingHtml] = useState(false);
  const [fixResult, setFixResult]               = useState<FixResult | null>(null);
  const [mode, setMode]                         = useState<'fast' | 'deep' | 'chat' | 'auto'>(() => {
    const m = localStorage.getItem(LS_MODE_KEY);
    return (m === 'fast' || m === 'deep' || m === 'chat' || m === 'auto') ? m as 'fast' | 'deep' | 'chat' | 'auto' : 'fast';
  });
  // chatSessionId persiste en localStorage keyado por repo — sobrevive remounts.
  // Clave distinta de 'quark-chat-session:*' (QuarkChat.tsx) para que ambos
  // componentes no compartan ni pisenla misma sesión de backend.
  const [chatSessionId] = useState(() => {
    const lsKey = `quark-agent-chat-session:${localStorage.getItem(LS_REPO_KEY) ?? 'default'}`;
    const existing = localStorage.getItem(lsKey);
    if (existing) return existing;
    const fresh = `chat-${Date.now()}`;
    localStorage.setItem(lsKey, fresh);
    return fresh;
  });
  const [chatPatches, setChatPatches]           = useState<ChatPatch[]>([]);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [editableCommitMsg, setEditableCommitMsg] = useState('');
  const [confidencePayload, setConfidencePayload] = useState<ConfidencePayload | null>(null);
  const [findingId, setFindingId] = useState<string | null>(null);
  const [activeModel, setActiveModel] = useState<{ model: string; tier: string } | null>(null);
  const [autoRunCost, setAutoRunCost] = useState<number | null>(null);
  const previewTriggeredRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const agentTextareaRef = useRef<HTMLTextAreaElement>(null);
  const currentPromptRef = useRef('');
  const pendingAutoSendRef = useRef<string | null>(null);

  // Keep a live ref so closures in useEffect always read the current value
  const isBackend = isBackendProject(activeProject.name);
  const isBackendRef = useRef(isBackend);
  isBackendRef.current = isBackend;
  const readFilesRef = useRef<{ path: string; content: string }[]>([]);

  // ── Session persistence ────────────────────────────────────────────────────

  // Persist repo + mode prefs immediately to localStorage
  useEffect(() => { localStorage.setItem(LS_REPO_KEY, selectedRepo); }, [selectedRepo]);
  useEffect(() => { localStorage.setItem(LS_MODE_KEY, mode); }, [mode]);

  // Mantiene selectedRepo sincronizado con activeProject cuando el usuario cambia
  // de proyecto desde el selector superior (activeProject es prop, cambia en el
  // padre). Sin este efecto, selectedRepo queda "pegado" al valor guardado en
  // localStorage de una sesión anterior, y las llamadas al backend usan un repo
  // distinto al que la UI muestra arriba — bug real detectado en producción
  // (búsqueda de la señal S3 resolvió contra el repo equivocado).
  useEffect(() => {
    if (activeProject.repo && activeProject.repo !== selectedRepo) {
      setSelectedRepo(activeProject.repo);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject.repo]);

  // Load feed + result from DB on mount
  useEffect(() => {
    // Capture stable values from the initial render — both are initialized
    // synchronously from localStorage so they're correct on first mount.
    const sessionIdForLoad = chatSessionId;
    const modeForLoad = mode;

    async function loadSession() {
      try {
        // ── FAST/DEEP session (feed + result snapshot) ─────────────────────
        const res = await fetch(`${API_BASE}/agent/session`);
        if (res.ok) {
          const data = await res.json() as { session: { feed: FeedItem[]; result: AgentEvent | null; commitResult: CommitResult | null; fixResult: FixResult | null } | null };
          if (data.session) {
            if (data.session.feed?.length)        setFeed(data.session.feed);
            if (data.session.result)              setResult(data.session.result);
            if (data.session.commitResult)        setCommitResult(data.session.commitResult);
            if (data.session.fixResult)           setFixResult(data.session.fixResult);
          }
        }

        // ── CHAT mode: rehidratar historial del backend ────────────────────
        // El backend guarda hasta 40 turnos en memory_entries; los recargamos
        // al volver a la pestaña para que la conversación sobreviva el remount.
        // Solo aplica cuando el modo activo es 'chat' — en FAST/DEEP el feed
        // ya viene del snapshot de sesión de arriba.
        if (modeForLoad === 'chat') {
          const chatRes = await fetch(`${API_BASE}/agent/chat/history/${encodeURIComponent(sessionIdForLoad)}`);
          if (chatRes.ok) {
            const chatData = await chatRes.json() as { messages: { role: 'user' | 'assistant'; text: string }[] };
            if (chatData.messages.length > 0) {
              const chatFeed: FeedItem[] = chatData.messages.map(m => ({
                event: m.role === 'user' ? 'user_message' : 'chat_message',
                text: m.text,
              } as FeedItem));
              setFeed(chatFeed);
            }
          }
        }
      } catch {
        // fail silently — agent works without session
      } finally {
        setSessionLoading(false);
      }
    }
    loadSession();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty — runs once on mount; chatSessionId and mode are stable from localStorage

  async function saveSession(
    feedSnapshot: FeedItem[],
    resultSnapshot: AgentEvent | null,
    commitResultSnapshot: CommitResult | null,
    fixResultSnapshot: FixResult | null,
  ) {
    try {
      await fetch(`${API_BASE}/agent/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feed:         feedSnapshot,
          result:       resultSnapshot,
          commitResult: commitResultSnapshot,
          fixResult:    fixResultSnapshot,
          savedAt:      new Date().toISOString(),
        }),
      });
    } catch {
      // fail silently
    }
  }

  // ── Scroll + textarea auto-height ─────────────────────────────────────────

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [feed, result, commitResult]);

  useEffect(() => {
    const el = agentTextareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [prompt]);

  // Sync editable commit message whenever a new result arrives
  useEffect(() => {
    if (result?.commitMessage) setEditableCommitMsg(result.commitMessage);
  }, [result?.commitMessage]);

  useEffect(() => {
    if (initialPrompt && initialPrompt.trim()) {
      setPrompt(initialPrompt);
      setTimeout(() => generate(initialPrompt), 300);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt]);

  async function callFix(errorDescription: string, filePath: string) {
    setRunning(true);
    setFeed([{ event: 'action', text: `🔧 Leyendo ${filePath} y analizando con Claude...` }]);
    setResult(null);
    setFixResult(null);
    setCommitResult(null);
    try {
      const res = await fetch(`${API_BASE}/agent/fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo:             selectedRepo,
          branch:           activeProject.branch,
          filePath,
          errorDescription,
        }),
      });
      const data = await res.json() as {
        fixedContent?: string;
        originalContent?: string;
        filePath?: string;
        branch?: string;
        error?: string;
      };
      if (data.error || !data.fixedContent) throw new Error(data.error ?? 'Sin respuesta de Claude');
      const newFixResult: FixResult = {
        filePath:        data.filePath!,
        fixedContent:    data.fixedContent,
        originalContent: data.originalContent ?? '',
        branch:          data.branch ?? activeProject.branch,
      };
      const doneMsg: FeedItem = { event: 'action', text: '✅ Corrección lista — revisa el diff antes de hacer commit' };
      setFixResult(newFixResult);
      setFeed((prev) => {
        const next = [...prev, doneMsg];
        saveSession(next, null, null, newFixResult);
        return next;
      });
    } catch (err) {
      setFeed((prev) => [...prev, { event: 'error', text: err instanceof Error ? err.message : String(err) }]);
    } finally {
      setRunning(false);
    }
  }

  async function commitFix() {
    if (!fixResult || committing) return;
    setCommitting(true);
    try {
      const res = await fetch(`${API_BASE}/github/commit-multiple`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files:   [{ path: fixResult.filePath, content: fixResult.fixedContent }],
          message: `fix: ${fixResult.filePath}`,
          repo:    selectedRepo,
          branch:  fixResult.branch,
        }),
      });
      const data = await res.json() as { sha?: string; owner?: string; error?: string };
      if (!data.sha) throw new Error(data.error ?? 'Commit failed');
      const newCommitResult: CommitResult = {
        sha:     data.sha,
        owner:   data.owner ?? '',
        repo:    selectedRepo,
        files:   [{ path: fixResult.filePath, content: fixResult.fixedContent }],
        message: `fix: ${fixResult.filePath}`,
      };
      setCommitResult(newCommitResult);
      setFeed((prev) => { saveSession(prev, null, newCommitResult, null); return prev; });
      if (activeProject.railwayProjectId) {
        setTimeout(async () => {
          try {
            await fetch(`${API_BASE}/debugger/run`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                projectId:   activeProject.railwayProjectId,
                projectName: activeProject.name,
                repo:        selectedRepo,
              }),
            })
          } catch {}
        }, 180_000)
      }
    } catch (err) {
      setFeed((prev) => [...prev, { event: 'error', text: err instanceof Error ? err.message : String(err) }]);
    } finally {
      setCommitting(false);
    }
  }

  // Auto-send to CHAT after mode switch triggered by confidence hand-off button
  useEffect(() => {
    if (mode === 'chat' && pendingAutoSendRef.current) {
      const msg = pendingAutoSendRef.current;
      pendingAutoSendRef.current = null;
      generate(msg);
    }
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  async function generate(promptOverride?: string) {
    const text = (promptOverride ?? prompt).trim();
    if (!text || running) return;
    setPrompt('');
    currentPromptRef.current = text;
    if (agentTextareaRef.current) agentTextareaRef.current.style.height = '44px';

    // ── CHAT MODE — appends to feed, does not reset session ─────────────────
    if (mode === 'chat') {
      setRunning(true);
      setFeed(prev => [...prev, { event: 'user_message', text }]);
      try {
        const chatFindingId = findingId;
        setFindingId(null); // consumir el finding — solo aplica al primer mensaje de esta sesión CHAT
        const res = await fetch(`${API_BASE}/agent/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, repo: selectedRepo, sessionId: chatSessionId, findingId: chatFindingId ?? undefined }),
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const processBlock = (block: string) => {
          for (const line of block.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              const parsed = JSON.parse(line.slice(6)) as {
                event: string; text?: string; path?: string;
                old_str?: string; new_str?: string; reasoning?: string;
                model?: string; tier?: string;
              };
              if (parsed.event === 'chat_message') {
                setFeed(prev => [...prev, { event: 'chat_message', text: parsed.text }]);
              } else if (parsed.event === 'patch_proposal') {
                const patchId = `patch-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
                setFeed(prev => [...prev, {
                  event: 'patch_proposal', patchId,
                  path: parsed.path, old_str: parsed.old_str,
                  new_str: parsed.new_str, reasoning: parsed.reasoning,
                }]);
                setChatPatches(prev => [...prev, {
                  id: patchId, path: parsed.path!,
                  old_str: parsed.old_str!, new_str: parsed.new_str!,
                  reasoning: parsed.reasoning ?? '',
                }]);
              } else if (parsed.event === 'model_active') {
                setActiveModel({ model: parsed.model!, tier: parsed.tier! });
              } else if (parsed.event === 'action') {
                setFeed(prev => [...prev, { event: 'action', text: parsed.text }]);
              } else if (parsed.event === 'error') {
                setFeed(prev => [...prev, { event: 'error', text: parsed.text }]);
              }
            } catch (e) { console.warn('[Chat] Parse error:', e); }
          }
        };
        while (true) {
          const { done, value } = await reader.read();
          if (value) buffer += decoder.decode(value, { stream: !done });
          const blocks = buffer.split('\n\n');
          buffer = done ? '' : (blocks.pop() ?? '');
          for (const block of blocks) processBlock(block);
          if (done) { if (buffer.trim()) processBlock(buffer); break; }
        }
      } catch (err) {
        setFeed(prev => [...prev, { event: 'error', text: err instanceof Error ? err.message : String(err) }]);
      } finally {
        setRunning(false);
      }
      return;
    }

    setRunning(true);
    setFeed([]);
    setResult(null);
    setHasReadResult(false);
    setFixResult(null);
    setCommitResult(null);
    setConfidencePayload(null);
    setFindingId(null);
    setActiveModel(null);
    setAutoRunCost(null);
    previewTriggeredRef.current = false;
    readFilesRef.current = [];

    // ── FIX PATH — route to callFix when fix keyword + filename detected ──────
    const fileInPrompt = text.match(/[\w/\-\.]+\.(ts|tsx|js|jsx|json|py|md|yml|yaml)/);
    if (FIX_KEYWORDS.test(text) && fileInPrompt) {
      setRunning(false); // callFix manages its own running state
      await callFix(text, fileInPrompt[0]);
      return;
    }

    // ── AUTO MODE — clone + SDK + diff ────────────────────────────────────────
    if (mode === 'auto') {
      try {
        const res = await fetch(`${API_BASE}/agent/auto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: text, repo: selectedRepo, branch: activeProject.branch ?? 'main' }),
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const processBlock = (block: string) => {
          for (const line of block.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              const parsed = JSON.parse(line.slice(6)) as AgentEvent;
              if (parsed.event === 'done') {
                if ((parsed as any).totalCostUsd) setAutoRunCost((parsed as any).totalCostUsd as number);
                setResult(parsed);
                if (parsed.files?.length) {
                  readFilesRef.current = parsed.files.map((f) => ({ path: f.path, content: f.content }));
                  setFeed((prev) => {
                    const next = [
                      ...prev,
                      { event: 'action' as const, text: `📂 ${parsed.files!.length} archivo(s) modificado(s) por AUTO:` },
                      ...parsed.files!.map((f) => ({ event: 'code' as const, path: f.path, content: f.content })),
                    ];
                    saveSession(next, parsed, null, null);
                    return next;
                  });
                }
                setRunning(false);
              } else if (parsed.event === 'action') {
                setFeed(prev => [...prev, { event: 'action', text: parsed.text }]);
              } else if (parsed.event === 'error') {
                setFeed(prev => [...prev, { event: 'error', text: parsed.text }]);
                setRunning(false);
              }
            } catch (e) { console.warn('[Auto] Parse error:', e); }
          }
        };
        while (true) {
          const { done, value } = await reader.read();
          if (value) buffer += decoder.decode(value, { stream: !done });
          const blocks = buffer.split('\n\n');
          buffer = done ? '' : (blocks.pop() ?? '');
          for (const block of blocks) processBlock(block);
          if (done) { if (buffer.trim()) processBlock(buffer); break; }
        }
      } catch (err) {
        setFeed(prev => [...prev, { event: 'error', text: err instanceof Error ? err.message : String(err) }]);
      } finally {
        setRunning(false);
      }
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/agent/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt:      text,
          repo:        selectedRepo,
          branch:      activeProject.branch,
          projectName: activeProject.name,
          deepMode:    mode === 'deep',
          findingId:   mode === 'deep' ? findingId : undefined,
          sessionId:   chatSessionId,
        }),
      });

      const reader  = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const processBlock = (block: string) => {
        for (const line of block.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            const parsed = JSON.parse(line.slice(6)) as AgentEvent;
            console.log('[Agent] Event:', parsed.event, '| isBackend:', isBackendRef.current);

            if (parsed.event === 'done') {
              if ((parsed as any).totalCostUsd) setAutoRunCost((parsed as any).totalCostUsd as number);
              setResult(parsed);

              // For backend projects: inject code blocks into the feed from done.files
              if (isBackendRef.current && parsed.files?.length) {
                readFilesRef.current = parsed.files!.map((f) => ({ path: f.path, content: f.content }));
                setFeed((prev) => {
                  const next = [
                    ...prev,
                    { event: 'action' as const, text: `📂 ${parsed.files!.length} archivo(s) generados:` },
                    ...parsed.files!.map((f) => ({
                      event: 'code' as const,
                      path: f.path,
                      content: f.content,
                    })),
                  ];
                  saveSession(next, parsed, null, null);
                  return next;
                });
              } else {
                if (parsed.files?.length) {
                  readFilesRef.current = parsed.files.map((f) => ({ path: f.path, content: f.content }));
                }
                setFeed((prev) => {
                  const next = [...prev, { event: parsed.event as FeedItem['event'] }];
                  saveSession(next, parsed, null, null);
                  return next;
                });
              }

              // Only apply to editor when it's a real generation (not read-only)
              if (!isBackendRef.current && parsed.mainContent && parsed.commitMessage) {
                onApplyToEditor(parsed.mainContent);
              }
              setRunning(false);

            } else if (parsed.event === 'file') {
              // For backend: just show the path marker (code block comes after done)
              // For UI: same path marker
              setFeed((prev) => [...prev, { event: 'file', path: parsed.path }]);

            } else if (parsed.event === 'replit_prompt') {
              setFeed((prev) => [...prev, {
                event: 'replit_prompt',
                text: parsed.text,
                file: parsed.file,
                task: parsed.task,
              }]);

            } else if (parsed.event === 'confidence') {
              setConfidencePayload({
                level: parsed.level as 'high' | 'medium' | 'low',
                reason: parsed.reason ?? '',
                suggestedAction: parsed.suggestedAction as 'deep' | 'chat',
                files: (parsed.files as unknown as string[]) ?? [],
                diagnosis: parsed.diagnosis ?? '',
              });
              if (parsed.findingId) setFindingId(parsed.findingId as string);
            } else if (parsed.event === 'model_active') {
              setActiveModel({ model: (parsed as any).model, tier: (parsed as any).tier });
            } else {
              setFeed((prev) => [...prev, { event: parsed.event as FeedItem['event'], text: parsed.text }]);
              if (parsed.text?.startsWith('💡')) {
                setHasReadResult(true);
              }
            }

            if (parsed.event === 'error') setRunning(false);

          } catch (e) {
            console.warn('[Agent] Parse error on line:', line.slice(0, 100), e);
          }
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: !done });
        const blocks = buffer.split('\n\n');
        buffer = done ? '' : (blocks.pop() ?? '');
        for (const block of blocks) processBlock(block);
        if (done) { if (buffer.trim()) processBlock(buffer); break; }
      }
    } catch (err) {
      setFeed((prev) => [...prev, { event: 'error', text: err instanceof Error ? err.message : String(err) }]);
    } finally {
      setRunning(false);
    }
  }

  // Auto-trigger preview — ONLY for UI (non-backend) projects
  // Uses isBackendRef so the closure always reads the current value even with [result] deps

  async function generateHtml() {
    if (!result) return;
    if (isBackendRef.current) return;
    if (!result.mainContent) return;
    if (isGeneratingHtml) return;
    setIsGeneratingHtml(true);
    try {
      const res = await fetch(`${API_BASE}/agent/generate-html`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code:  result.mainContent ?? '',
          files: result.files ?? [],
        }),
      });
      const data = await res.json() as { html?: string; success: boolean; error?: string };
      if (!data.success || !data.html) throw new Error(data.error ?? 'Sin HTML');
      onShowPreview(data.html);
    } catch (err) {
      setFeed((prev) => [...prev, { event: 'error', text: err instanceof Error ? err.message : String(err) }]);
    } finally {
      setIsGeneratingHtml(false);
    }
  }

  async function commitToGitHub() {
    if (!result?.files || committing) return;
    setCommitting(true);
    try {
      const res = await fetch(`${API_BASE}/github/commit-multiple`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files:   result.files,
          message: editableCommitMsg || result.commitMessage,
          repo:    result.repo ?? selectedRepo,
          branch:  result.branch ?? activeProject.branch,
        }),
      });
      const data = await res.json() as { sha?: string; owner?: string; error?: string };
      if (!data.sha) throw new Error(data.error ?? 'Commit failed');
      const finalCommit: CommitResult = {
        sha:     data.sha,
        owner:   data.owner ?? '',
        repo:    result.repo ?? selectedRepo,
        files:   result.files ?? [],
        message: result.commitMessage ?? '',
      };
      setCommitResult(finalCommit);
      setFeed((prev) => { saveSession(prev, result, finalCommit, null); return prev; });
      if (activeProject.railwayProjectId) {
        setTimeout(async () => {
          try {
            await fetch(`${API_BASE}/debugger/run`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                projectId:   activeProject.railwayProjectId,
                projectName: activeProject.name,
                repo:        result?.repo ?? selectedRepo,
              }),
            })
          } catch {}
        }, 180_000)
      }
    } catch (err) {
      setFeed((prev) => [...prev, { event: 'error', text: err instanceof Error ? err.message : String(err) }]);
    } finally {
      setCommitting(false);
    }
  }

  async function commitChatPatches() {
    if (!chatPatches.length || committing) return;
    setCommitting(true);
    let committed = 0;
    for (const patch of chatPatches) {
      try {
        const res = await fetch(`${API_BASE}/agent/apply-patch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo: selectedRepo, path: patch.path, old_str: patch.old_str, new_str: patch.new_str }),
        });
        const data = await res.json() as { ok: boolean; error?: string };
        if (data.ok) {
          committed++;
          setFeed(prev => [...prev, { event: 'action', text: `✅ Patch commiteado: ${patch.path}` }]);
        } else {
          setFeed(prev => [...prev, { event: 'error', text: `❌ ${patch.path}: ${data.error ?? 'Error al aplicar'}` }]);
        }
      } catch (err) {
        setFeed(prev => [...prev, { event: 'error', text: `❌ ${patch.path}: ${err instanceof Error ? err.message : String(err)}` }]);
      }
    }
    setChatPatches([]);
    if (committed > 0) {
      setFeed(prev => [...prev, { event: 'action', text: `🎉 ${committed} patch(es) commiteados en ${selectedRepo}` }]);
    }
    setCommitting(false);
  }

  const shortSha    = commitResult?.sha.slice(0, 7) ?? '';
  const githubUrl   = commitResult
    ? `https://github.com/${commitResult.owner}/${commitResult.repo}/commit/${commitResult.sha}`
    : '';
  const railwayUrl  = `https://railway.app/project/${activeProject.railwayProjectId}`;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
      background: 'radial-gradient(ellipse at 50% 20%, #0d0d12 0%, #050506 100%)', overflow: 'hidden',
    }}>
      {/* Header — position+zIndex required: backdrop-filter creates a stacking context;
          without explicit z-index the feed content (later in DOM) paints over dropdowns. */}
      <div style={{
        position: 'relative', zIndex: 10,
        padding: '8px 12px', borderBottom: `1px solid ${T.glassBorder}`,
        display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
        background: T.glassBg,
        backdropFilter: T.glassBlur, WebkitBackdropFilter: T.glassBlur,
        boxShadow: `inset 0 1px 0 ${T.glassHighlight}`,
      }}>
        <span style={{ color: 'rgba(255,255,255,0.88)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em' }}>
          QUARK AGENT
        </span>
        <span style={{ color: 'rgba(255,255,255,0.28)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          — {activeProject.emoji} {activeProject.name}
          {isBackend && (
            <span style={{ color: 'rgba(255,255,255,0.42)', marginLeft: 6, fontSize: 10 }}>backend</span>
          )}
        </span>
        {(feed.length > 0 || result || commitResult || fixResult) && !running && (
          <button
            onClick={() => {
              fetch(`${API_BASE}/agent/context`, { method: 'DELETE' }).catch(() => {});
              setResult(null);
              setFeed([]);
              setCommitResult(null);
              setFixResult(null);
              setEditableCommitMsg('');
              saveSession([], null, null, null);
            }}
            style={{
              background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 4, color: 'rgba(255,255,255,0.65)',
              fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 700,
              padding: '3px 8px', cursor: 'pointer', letterSpacing: '0.04em',
              whiteSpace: 'nowrap', transition: 'background 0.15s', flexShrink: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.09)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
          >
            ＋ Nueva sesión
          </button>
        )}
      </div>

      {/* Feed */}
      <div style={{
        flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 12px',
        display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        {sessionLoading && (
          <p style={{ color: 'rgba(255,255,255,0.28)', fontSize: 11, margin: 0, fontFamily: 'JetBrains Mono, monospace' }}>
            Cargando sesión...
          </p>
        )}
        {!sessionLoading && feed.length === 0 && !running && !result && (
          <p style={{ color: 'rgba(255,255,255,0.3)', fontSize: 12, margin: 0, lineHeight: 1.6 }}>
            Describe lo que quieres construir en{' '}
            <span style={{ color: 'rgba(255,255,255,0.88)' }}>{activeProject.name}</span>.
            El Agent leerá el repo, generará los archivos y te dará la opción de hacer commit.
          </p>
        )}

        {feed.map((ev, i) => {
          if (ev.event === 'action') {
            const t = ev.text ?? '';
            const isAnalysis = t.startsWith('💡');
            const actionColor =
              t.startsWith('CAUSA:')    ? '#FF6B6B' :
              t.startsWith('DÓNDE:')    ? '#00D4FF' :
              t.startsWith('POR QUÉ:') ? '#FFD93D' :
              t.startsWith('SOLUCIÓN:') ? '#6BCB77' :
              isAnalysis                 ? 'rgba(255,255,255,0.88)' :
              t.startsWith('⚠️')          ? '#FFD93D' :
              t.startsWith('🎯')          ? '#00D4FF' :
              (t.startsWith('🔍') || t.startsWith('📖') || t.startsWith('📂') || t.startsWith('⚡')) ? '#6b7280' :
              '#4ade80';
            if (isAnalysis) {
              return (
                <div key={i} style={{ fontSize: 12, lineHeight: 1.6, color: '#d4d4dc', paddingLeft: 2 }}>
                  <ReactMarkdown
                    components={{
                      p: ({ children }) => <span style={{ display: 'block' }}>{children}</span>,
                      strong: ({ children }) => (
                        <strong style={{ fontWeight: 700, color: '#ffffff' }}>{children}</strong>
                      ),
                      code: ({ children }) => (
                        <code style={{
                          background: '#080808',
                          border: '1px solid rgba(255,255,255,0.07)',
                          color: 'rgba(255,255,255,0.55)',
                          borderRadius: 3,
                          padding: '1px 5px',
                          fontSize: 11,
                          fontFamily: 'JetBrains Mono, monospace',
                        }}>{children}</code>
                      ),
                    }}
                  >
                    {t}
                  </ReactMarkdown>
                </div>
              );
            }
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: actionColor, fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}>
                  {ev.text}
                </span>
              </div>
            );
          }

          if (ev.event === 'file') return (
            <div key={i} style={{
              background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderLeft: '2px solid rgba(255,255,255,0.22)',
              borderRadius: 4, padding: '3px 10px',
              color: 'rgba(255,255,255,0.38)', fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
            }}>
              📄 {ev.path}
            </div>
          );

          if (ev.event === 'code') return (
            <div key={i} style={{
              background: '#080808',
              border: '1px solid rgba(255,255,255,0.07)',
              borderLeft: '2px solid rgba(255,255,255,0.2)',
              borderRadius: 6,
              overflow: 'hidden',
            }}>
              {/* file path header */}
              <div style={{
                padding: '4px 10px',
                borderBottom: '1px solid rgba(255,255,255,0.07)',
                color: 'rgba(255,255,255,0.45)',
                fontSize: 10,
                fontFamily: 'JetBrains Mono, monospace',
                letterSpacing: '0.05em',
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <span style={{ color: 'rgba(255,255,255,0.28)' }}>📄</span>
                {ev.path}
              </div>
              {/* code content */}
              <div style={{
                padding: '10px 12px',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 10,
                color: 'rgba(255,255,255,0.55)',
                whiteSpace: 'pre-wrap',
                overflowX: 'auto',
                maxHeight: 300,
                overflowY: 'auto',
                lineHeight: 1.6,
              }}>
                {ev.content}
              </div>
            </div>
          );

          if (ev.event === 'error') return (
            <div key={i} style={{
              background: 'rgba(255,68,68,0.06)', border: '1px solid rgba(255,68,68,0.2)',
              borderRadius: 4, padding: '6px 10px',
              color: 'rgba(255,120,120,0.9)', fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
            }}>
              ❌ {ev.text}
            </div>
          );

          if (ev.event === 'user_message') return (
            <div key={i} style={{
              alignSelf: 'flex-end', maxWidth: '80%',
              background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '10px 10px 2px 10px', padding: '8px 12px',
              color: 'rgba(255,255,255,0.88)', fontSize: 12, lineHeight: 1.6,
              fontFamily: 'system-ui, sans-serif', whiteSpace: 'pre-wrap',
            }}>
              {ev.text}
            </div>
          );

          if (ev.event === 'chat_message') return (
            <div key={i} style={{
              background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
              borderLeft: '2px solid rgba(255,255,255,0.22)',
              borderRadius: '2px 10px 10px 10px', padding: '10px 14px',
              color: 'rgba(255,255,255,0.88)', fontSize: 12, lineHeight: 1.75,
              fontFamily: 'system-ui, sans-serif', whiteSpace: 'pre-wrap',
              maxWidth: '92%',
            }}>
              {ev.text}
            </div>
          );

          if (ev.event === 'patch_proposal') {
            const oldLines = (ev.old_str ?? '').split('\n');
            const newLines = (ev.new_str ?? '').split('\n');
            const isRejected = !chatPatches.some(p => p.id === ev.patchId);
            return (
              <div key={i} style={{
                border: `1px solid ${isRejected ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.1)'}`,
                borderLeft: `2px solid ${isRejected ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.28)'}`,
                borderRadius: 6, overflow: 'hidden', background: '#080808',
                opacity: isRejected ? 0.4 : 1, transition: 'opacity 0.2s',
              }}>
                {/* header */}
                <div style={{
                  padding: '5px 10px', borderBottom: '1px solid rgba(255,255,255,0.07)',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  background: '#0a0a0a',
                }}>
                  <span style={{ color: 'rgba(255,255,255,0.55)', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}>
                    📝 {ev.path}
                  </span>
                  {!isRejected ? (
                    <button
                      onClick={() => setChatPatches(prev => prev.filter(p => p.id !== ev.patchId))}
                      style={{
                        background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.35)',
                        borderRadius: 4, color: '#f87171',
                        fontSize: 9, fontWeight: 700, padding: '2px 8px',
                        fontFamily: 'JetBrains Mono, monospace', cursor: 'pointer',
                        letterSpacing: '0.04em',
                      }}
                    >
                      ✕ Rechazar
                    </button>
                  ) : (
                    <span style={{ color: 'rgba(255,255,255,0.22)', fontSize: 9, fontFamily: 'JetBrains Mono, monospace' }}>rechazado</span>
                  )}
                </div>
                {/* reasoning */}
                {ev.reasoning && (
                  <div style={{
                    padding: '5px 10px', color: 'rgba(255,255,255,0.35)', fontSize: 10,
                    fontFamily: 'JetBrains Mono, monospace', borderBottom: '1px solid rgba(255,255,255,0.06)',
                  }}>
                    {ev.reasoning}
                  </div>
                )}
                {/* diff — two columns */}
                <div style={{ display: 'flex', gap: 0 }}>
                  <div style={{ flex: 1, minWidth: 0, borderRight: '1px solid rgba(255,255,255,0.06)' }}>
                    <div style={{
                      padding: '2px 8px', color: 'rgba(255,255,255,0.28)', fontSize: 9,
                      fontFamily: 'JetBrains Mono, monospace',
                      borderBottom: '1px solid rgba(255,255,255,0.06)', background: '#060606',
                    }}>ANTES</div>
                    <div style={{
                      fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
                      lineHeight: 1.55, padding: '6px 4px',
                      whiteSpace: 'pre-wrap', overflowX: 'auto',
                      maxHeight: 220, overflowY: 'auto',
                    }}>
                      {oldLines.map((line, li) => (
                        <div key={li} style={{ display: 'flex', background: 'rgba(239,68,68,0.12)', minHeight: '1.55em' }}>
                          <span style={{ color: 'rgba(255,255,255,0.12)', userSelect: 'none', minWidth: 28, textAlign: 'right', marginRight: 6, flexShrink: 0 }}>{li + 1}</span>
                          <span style={{ color: '#fca5a5' }}>{line || ' '}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      padding: '2px 8px', color: 'rgba(255,255,255,0.28)', fontSize: 9,
                      fontFamily: 'JetBrains Mono, monospace',
                      borderBottom: '1px solid rgba(255,255,255,0.06)', background: '#060606',
                    }}>DESPUÉS</div>
                    <div style={{
                      fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
                      lineHeight: 1.55, padding: '6px 4px',
                      whiteSpace: 'pre-wrap', overflowX: 'auto',
                      maxHeight: 220, overflowY: 'auto',
                    }}>
                      {newLines.map((line, li) => (
                        <div key={li} style={{ display: 'flex', background: 'rgba(34,197,94,0.08)', minHeight: '1.55em' }}>
                          <span style={{ color: 'rgba(255,255,255,0.12)', userSelect: 'none', minWidth: 28, textAlign: 'right', marginRight: 6, flexShrink: 0 }}>{li + 1}</span>
                          <span style={{ color: '#86efac' }}>{line || ' '}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            );
          }

          if (ev.event === 'replit_prompt') return (
            <div key={i} style={{
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 8,
              padding: 12,
              margin: '8px 0',
            }}>
              <div style={{ color: 'rgba(255,255,255,0.65)', fontWeight: 700, marginBottom: 8, fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}>
                PROMPT PARA REPLIT
              </div>
              <pre style={{
                color: 'rgba(255,255,255,0.78)',
                fontSize: 11,
                whiteSpace: 'pre-wrap',
                fontFamily: 'JetBrains Mono, monospace',
                margin: 0,
                lineHeight: 1.6,
              }}>
                {ev.text}
              </pre>
              <button
                onClick={() => navigator.clipboard.writeText(ev.text ?? '')}
                style={{
                  marginTop: 8,
                  background: 'rgba(255,255,255,0.08)',
                  color: 'rgba(255,255,255,0.7)',
                  border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: 4,
                  padding: '6px 12px',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontFamily: 'JetBrains Mono, monospace',
                }}
              >
                📋 Copiar prompt
              </button>
            </div>
          );

          return null;
        })}

        {/* 3D model indicator — persists between turns, animates only while running */}
        {activeModel && (
          <div
            key={activeModel.tier}
            className="model-icon-wrap"
            style={{ display: 'flex', alignItems: 'center', gap: 10 }}
          >
            {/* 3D icon */}
            <div style={{ perspective: '72px', width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {activeModel.tier === 'fast' && (
                <div
                  className={running ? 'model-icon-spinning' : undefined}
                  style={{
                    width: 18, height: 18,
                    transformStyle: 'preserve-3d',
                    clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
                    background: `linear-gradient(145deg, ${T.tierFast} 0%, ${T.tierFast}66 100%)`,
                    boxShadow: `0 0 8px ${T.tierFast}55, 0 2px 6px rgba(0,0,0,0.6), inset 0 1px 0 ${T.tierFast}88`,
                  }}
                />
              )}
              {activeModel.tier === 'balanced' && (
                <div
                  className={running ? 'model-icon-spinning' : undefined}
                  style={{
                    width: 20, height: 20,
                    transformStyle: 'preserve-3d',
                    clipPath: 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)',
                    background: 'linear-gradient(145deg, rgba(255,255,255,0.88) 0%, rgba(255,255,255,0.46) 100%)',
                    boxShadow: '0 2px 8px rgba(255,255,255,0.07)',
                  }}
                />
              )}
              {activeModel.tier === 'deep' && (
                <div
                  className={running ? 'model-icon-spinning' : undefined}
                  style={{
                    width: 20, height: 20,
                    transformStyle: 'preserve-3d',
                    borderRadius: '50%',
                    background: 'radial-gradient(circle at 35% 32%, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.46) 55%, rgba(255,255,255,0.08) 100%)',
                    boxShadow: '0 2px 12px rgba(255,255,255,0.11), inset 0 -2px 6px rgba(0,0,0,0.35)',
                  }}
                />
              )}
            </div>
            {/* model name + status */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <span style={{
                fontSize: 10, fontFamily: 'JetBrains Mono, monospace',
                color: 'rgba(255,255,255,0.55)', letterSpacing: '0.03em',
                whiteSpace: 'nowrap',
              }}>
                {activeModel.model}
              </span>
              {running && (
                <span style={{ color: 'rgba(255,255,255,0.25)', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}>
                  procesando<span className="thinking-dots" />
                </span>
              )}
            </div>
          </div>
        )}

        {running && !activeModel && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: 'rgba(255,255,255,0.2)', fontSize: 12, fontFamily: 'JetBrains Mono, monospace' }}>
              procesando<span className="thinking-dots" />
            </span>
          </div>
        )}

        {/* ── FIX DIFF PANEL ───────────────────────────────────────────────── */}
        {fixResult && !running && !commitResult && (() => {
          const origLines  = fixResult.originalContent.split('\n');
          const fixedLines = fixResult.fixedContent.split('\n');
          const added   = fixedLines.filter((l) => !origLines.includes(l)).length;
          const removed = origLines.filter((l) => !fixedLines.includes(l)).length;
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              {/* stat bar */}
              <div style={{
                background: 'rgba(245,158,11,0.06)', border: '1px solid #3f2e1e',
                borderRadius: 6, padding: '6px 12px',
                display: 'flex', alignItems: 'center', gap: 10,
                fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
              }}>
                <span style={{ color: '#f59e0b', fontWeight: 700 }}>🔧 {fixResult.filePath}</span>
                <span style={{ color: '#22c55e' }}>+{added}</span>
                <span style={{ color: '#ef4444' }}>−{removed}</span>
              </div>
              {/* diff columns */}
              <div style={{ display: 'flex', gap: 4, minHeight: 0 }}>
                {/* original */}
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div style={{ color: 'rgba(255,255,255,0.38)', fontSize: 10, fontFamily: 'JetBrains Mono, monospace', padding: '2px 6px' }}>
                    ANTES
                  </div>
                  <div style={{
                    background: '#080808', border: '1px solid #2d1515', borderRadius: 4,
                    fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'rgba(255,255,255,0.55)',
                    whiteSpace: 'pre-wrap', overflowX: 'auto', maxHeight: 280, overflowY: 'auto',
                    lineHeight: 1.6, padding: '8px 10px',
                  }}>
                    {origLines.map((line, i) => (
                      <div key={i} style={{
                        background: !fixedLines.includes(line) ? 'rgba(239,68,68,0.12)' : 'transparent',
                        color: !fixedLines.includes(line) ? '#fca5a5' : '#a0a0c0',
                      }}>{line || ' '}</div>
                    ))}
                  </div>
                </div>
                {/* fixed */}
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div style={{ color: 'rgba(255,255,255,0.38)', fontSize: 10, fontFamily: 'JetBrains Mono, monospace', padding: '2px 6px' }}>
                    DESPUÉS
                  </div>
                  <div style={{
                    background: '#080808', border: '1px solid #153015', borderRadius: 4,
                    fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'rgba(255,255,255,0.55)',
                    whiteSpace: 'pre-wrap', overflowX: 'auto', maxHeight: 280, overflowY: 'auto',
                    lineHeight: 1.6, padding: '8px 10px',
                  }}>
                    {fixedLines.map((line, i) => (
                      <div key={i} style={{
                        background: !origLines.includes(line) ? 'rgba(34,197,94,0.1)' : 'transparent',
                        color: !origLines.includes(line) ? '#86efac' : '#a0a0c0',
                      }}>{line || ' '}</div>
                    ))}
                  </div>
                </div>
              </div>
              {/* commit button */}
              <button
                onClick={commitFix}
                disabled={committing}
                style={{
                  background: committing ? '#1e1e3f' : 'rgba(245,158,11,0.1)',
                  border: `1px solid ${committing ? '#1e1e3f' : '#78350f'}`,
                  borderRadius: 6, color: committing ? '#3a3a5c' : '#fbbf24',
                  fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700,
                  padding: '9px 12px', cursor: committing ? 'not-allowed' : 'pointer',
                  letterSpacing: '0.04em', transition: 'background 0.15s', width: '100%',
                }}
                onMouseEnter={(e) => { if (!committing) e.currentTarget.style.background = 'rgba(245,158,11,0.18)'; }}
                onMouseLeave={(e) => { if (!committing) e.currentTarget.style.background = 'rgba(245,158,11,0.1)'; }}
              >
                {committing ? '⟳ Committing fix…' : `⚡ Commit fix → ${fixResult.filePath}`}
              </button>
            </div>
          );
        })()}

        {/* ── BACKEND PROJECT result panel ──────────────────────────────────── */}
        {result && !running && isBackend && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>

            {/* Commit SHA — shown after successful commit */}
            {commitResult ? (
              <div style={{
                background: 'rgba(0,255,136,0.05)', border: '1px solid #1e3f2a',
                borderRadius: 6, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: 'rgba(255,255,255,0.82)', fontSize: 12 }}>✅</span>
                  <span style={{ color: 'rgba(255,255,255,0.82)', fontSize: 11, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}>
                    Commit {shortSha} — {commitResult.files.length} archivo(s) modificado(s)
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                  {githubUrl && (
                    <a
                      href={githubUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                        background: 'rgba(30,30,63,0.8)', border: '1px solid #2d2d6b',
                        borderRadius: 6, color: '#a0a0e0', fontSize: 11, fontWeight: 700,
                        fontFamily: 'JetBrains Mono, monospace', padding: '7px 10px',
                        textDecoration: 'none', letterSpacing: '0.04em', transition: 'background 0.15s',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(50,50,100,0.8)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(30,30,63,0.8)'; }}
                    >
                      🔗 GitHub {shortSha}
                    </a>
                  )}
                  <a
                    href={railwayUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                      background: 'rgba(124,58,237,0.12)', border: '1px solid #4c1d95',
                      borderRadius: 6, color: 'rgba(255,255,255,0.55)', fontSize: 11, fontWeight: 700,
                      fontFamily: 'JetBrains Mono, monospace', padding: '7px 10px',
                      textDecoration: 'none', letterSpacing: '0.04em', transition: 'background 0.15s',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(124,58,237,0.22)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(124,58,237,0.12)'; }}
                  >
                    🚀 Ver en Railway
                  </a>
                </div>
              </div>
            ) : !result.commitMessage && result.files?.length ? (
              /* ── READ-ONLY viewer — no commit, just show file content ──────── */
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {result.files.map((file, idx) => {
                  const lines = file.content.split('\n');
                  return (
                    <div key={idx} style={{
                      border: '1px solid #1e3a2a',
                      borderLeft: '2px solid #00ff88',
                      borderRadius: 6, overflow: 'hidden', background: '#080808',
                    }}>
                      {/* header */}
                      <div style={{
                        padding: '5px 10px', borderBottom: '1px solid #1e3a2a',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        background: '#060606',
                      }}>
                        <span style={{ color: 'rgba(255,255,255,0.82)', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}>
                          📄 {file.path}
                        </span>
                        <span style={{ color: 'rgba(255,255,255,0.28)', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}>
                          {lines.length} líneas
                        </span>
                      </div>
                      {/* content */}
                      <div style={{
                        fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
                        lineHeight: 1.55, padding: '6px 8px',
                        whiteSpace: 'pre-wrap', overflowX: 'auto',
                      }}>
                        {lines.map((line, i) => (
                          <div key={i} style={{ display: 'flex', gap: 0 }}>
                            <span style={{
                              color: 'rgba(255,255,255,0.12)', userSelect: 'none',
                              minWidth: 32, textAlign: 'right', marginRight: 10, flexShrink: 0,
                            }}>
                              {i + 1}
                            </span>
                            <span style={{ color: 'rgba(255,255,255,0.55)' }}>{line || ' '}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              /* Diff viewer + commit — shown before commit */
              result.files?.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>

                  {/* Diff por archivo — 2 columnas side-by-side */}
                  {result.files.map((file, idx) => {
                    const origLines = (file.originalContent ?? '').split('\n');
                    const newLines  = file.content.split('\n');
                    const isNew     = file.originalContent === undefined;
                    const diff      = isNew ? [] : computeLineDiff(origLines, newLines);
                    const pairs     = isNew ? [] : toPairedRows(diff);
                    const added     = isNew ? newLines.length : diff.filter((d) => d.type === 'added').length;
                    const removed   = isNew ? 0 : diff.filter((d) => d.type === 'removed').length;
                    return (
                      <div key={idx} style={{
                        border: '1px solid rgba(255,255,255,0.07)',
                        borderLeft: '2px solid #7c3aed',
                        borderRadius: 6,
                        overflow: 'hidden',
                        background: '#080808',
                      }}>
                        {/* header */}
                        <div style={{
                          padding: '5px 10px',
                          borderBottom: '1px solid rgba(255,255,255,0.07)',
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        }}>
                          <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}>
                            📄 {file.path}
                          </span>
                          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, display: 'flex', gap: 8 }}>
                            {removed > 0 && <span style={{ color: '#f87171' }}>−{removed}</span>}
                            {added   > 0 && <span style={{ color: '#86efac' }}>+{added}</span>}
                            {isNew && <span style={{ color: 'rgba(255,255,255,0.55)' }}>nuevo archivo</span>}
                            {!isNew && removed === 0 && added === 0 && <span style={{ color: 'rgba(255,255,255,0.28)' }}>sin cambios</span>}
                          </span>
                        </div>
                        {/* columns */}
                        {isNew ? (
                          /* New file — single column */
                          <div style={{
                            fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
                            lineHeight: 1.55, padding: '6px 8px',
                            whiteSpace: 'pre-wrap', overflowX: 'auto',
                          }}>
                            {newLines.map((line, i) => (
                              <div key={i} style={{ display: 'flex', background: 'rgba(34,197,94,0.06)' }}>
                                <span style={{ color: 'rgba(255,255,255,0.12)', userSelect: 'none', minWidth: 32, textAlign: 'right', marginRight: 8, flexShrink: 0 }}>
                                  {i + 1}
                                </span>
                                <span style={{ color: '#86efac' }}>{line || ' '}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div style={{ display: 'flex', gap: 0 }}>
                            {/* LEFT — original */}
                            <div style={{ flex: 1, minWidth: 0, borderRight: '1px solid rgba(255,255,255,0.06)' }}>
                              <div style={{
                                padding: '2px 8px', color: 'rgba(255,255,255,0.28)', fontSize: 9,
                                fontFamily: 'JetBrains Mono, monospace',
                                borderBottom: '1px solid rgba(255,255,255,0.06)', background: '#060606',
                              }}>ANTES</div>
                              <div style={{
                                fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
                                lineHeight: 1.55, padding: '6px 4px',
                                whiteSpace: 'pre-wrap', overflowX: 'auto',
                              }}>
                                {pairs.map((row, i) => (
                                  <div key={i} style={{
                                    display: 'flex',
                                    background: row.leftType === 'removed' ? 'rgba(239,68,68,0.12)' : 'transparent',
                                    minHeight: '1.55em',
                                  }}>
                                    <span style={{ color: 'rgba(255,255,255,0.12)', userSelect: 'none', minWidth: 32, textAlign: 'right', marginRight: 6, flexShrink: 0 }}>
                                      {row.leftNum ?? ''}
                                    </span>
                                    <span style={{ color: row.leftType === 'removed' ? '#fca5a5' : '#3a3a5c' }}>
                                      {row.leftText ?? ''}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                            {/* RIGHT — new */}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{
                                padding: '2px 8px', color: 'rgba(255,255,255,0.28)', fontSize: 9,
                                fontFamily: 'JetBrains Mono, monospace',
                                borderBottom: '1px solid rgba(255,255,255,0.06)', background: '#060606',
                              }}>DESPUÉS</div>
                              <div style={{
                                fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
                                lineHeight: 1.55, padding: '6px 4px',
                                whiteSpace: 'pre-wrap', overflowX: 'auto',
                              }}>
                                {pairs.map((row, i) => (
                                  <div key={i} style={{
                                    display: 'flex',
                                    background: row.rightType === 'added' ? 'rgba(34,197,94,0.08)' : 'transparent',
                                    minHeight: '1.55em',
                                  }}>
                                    <span style={{ color: 'rgba(255,255,255,0.12)', userSelect: 'none', minWidth: 32, textAlign: 'right', marginRight: 6, flexShrink: 0 }}>
                                      {row.rightNum ?? ''}
                                    </span>
                                    <span style={{ color: row.rightType === 'added' ? '#86efac' : '#3a3a5c' }}>
                                      {row.rightText ?? ''}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* AUTO run cost */}
                  {autoRunCost !== null && (
                    <div style={{
                      fontSize: 10, color: '#fb923c',
                      fontFamily: 'JetBrains Mono, monospace',
                      background: 'rgba(251,146,60,0.06)',
                      border: '1px solid rgba(249,115,22,0.2)',
                      borderRadius: 4, padding: '4px 8px',
                    }}>
                      💰 Costo de esta corrida: ${autoRunCost.toFixed(4)}
                    </div>
                  )}

                  {/* Incomplete agentic loop warning */}
                  {result.incomplete && (
                    <div style={{
                      background: 'rgba(245,158,11,0.1)',
                      border: '1px solid rgba(245,158,11,0.4)',
                      borderLeft: '3px solid #f59e0b',
                      borderRadius: 6, padding: '8px 12px',
                      color: '#fbbf24',
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 11, lineHeight: 1.5,
                    }}>
                      ⚠️ Cambio incompleto — el agente alcanzó el límite de turnos sin confirmar que la tarea terminó. Revisa cuidadosamente antes de aprobar; puede faltar parte del fix.
                    </div>
                  )}

                  {/* Editable commit message */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{
                      color: '#4c1d95', fontSize: 9,
                      fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.06em',
                    }}>
                      MENSAJE DEL COMMIT ({result.files.length} archivo(s))
                    </span>
                    <textarea
                      value={editableCommitMsg}
                      onChange={(e) => setEditableCommitMsg(e.target.value)}
                      disabled={committing}
                      rows={2}
                      style={{
                        background: 'rgba(124,58,237,0.06)',
                        border: '1px solid #4c1d95',
                        borderRadius: 6, padding: '7px 10px',
                        color: committing ? '#3a3a5c' : '#a78bfa',
                        fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
                        resize: 'vertical', width: '100%', boxSizing: 'border-box',
                        outline: 'none', lineHeight: 1.5,
                      }}
                    />
                  </div>

                  {/* Botones aprobar / cancelar */}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={commitToGitHub}
                      disabled={committing}
                      style={{
                        flex: 1,
                        background: committing ? '#1e1e3f' : 'rgba(124,58,237,0.12)',
                        border: `1px solid ${committing ? '#1e1e3f' : '#4c1d95'}`,
                        borderRadius: 6, color: committing ? '#3a3a5c' : '#a78bfa',
                        fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700,
                        padding: '9px 12px', cursor: committing ? 'not-allowed' : 'pointer',
                        letterSpacing: '0.04em', transition: 'background 0.15s',
                      }}
                      onMouseEnter={(e) => { if (!committing) e.currentTarget.style.background = 'rgba(124,58,237,0.22)'; }}
                      onMouseLeave={(e) => { if (!committing) e.currentTarget.style.background = 'rgba(124,58,237,0.12)'; }}
                    >
                      {committing ? '⟳ Committing…' : `✅ Aprobar y commitear ${result.files.length} archivo(s)`}
                    </button>
                    <button
                      onClick={() => {
                        setResult(null);
                        setFeed([]);
                        setCommitResult(null);
                        setFixResult(null);
                        saveSession([], null, null, null);
                      }}
                      disabled={committing}
                      style={{
                        background: 'rgba(239,68,68,0.08)',
                        border: '1px solid rgba(239,68,68,0.3)',
                        borderRadius: 6, color: committing ? '#3a3a5c' : '#f87171',
                        fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700,
                        padding: '9px 14px', cursor: committing ? 'not-allowed' : 'pointer',
                        letterSpacing: '0.04em', transition: 'background 0.15s', whiteSpace: 'nowrap',
                      }}
                      onMouseEnter={(e) => { if (!committing) e.currentTarget.style.background = 'rgba(239,68,68,0.18)'; }}
                      onMouseLeave={(e) => { if (!committing) e.currentTarget.style.background = 'rgba(239,68,68,0.08)'; }}
                    >
                      ✕ Cancelar
                    </button>
                  </div>
                </div>
              ) : (
                /* Read-only / diagnostic result — no files to commit */
                <div style={{
                  background: 'rgba(0,255,136,0.04)', border: '1px solid #1e3f2a',
                  borderRadius: 6, padding: '8px 12px',
                  color: 'rgba(255,255,255,0.42)', fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  ✅ Análisis completado
                </div>
              )
            )}

          </div>
        )}

        {/* ── CHAT MODE commit panel ─────────────────────────────────────────── */}
        {mode === 'chat' && chatPatches.length > 0 && !running && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            <button
              onClick={commitChatPatches}
              disabled={committing}
              style={{
                background: committing ? '#1e1e3f' : 'rgba(124,58,237,0.12)',
                border: `1px solid ${committing ? '#1e1e3f' : '#4c1d95'}`,
                borderRadius: 6, color: committing ? '#3a3a5c' : '#a78bfa',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700,
                padding: '9px 12px', cursor: committing ? 'not-allowed' : 'pointer',
                letterSpacing: '0.04em', transition: 'background 0.15s', width: '100%',
              }}
              onMouseEnter={(e) => { if (!committing) e.currentTarget.style.background = 'rgba(124,58,237,0.22)'; }}
              onMouseLeave={(e) => { if (!committing) e.currentTarget.style.background = 'rgba(124,58,237,0.12)'; }}
            >
              {committing ? '⟳ Committing patches…' : `✅ Aprobar y commitear ${chatPatches.length} patch(es)`}
            </button>
          </div>
        )}

        {/* ── Confidence hand-off buttons (FAST/DEEP analysis result) ─────── */}
        {confidencePayload && !running && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2,
            }}>
              <span style={{
                fontSize: 10, fontFamily: 'JetBrains Mono, monospace',
                color: confidencePayload.level === 'high' ? '#4ade80' : confidencePayload.level === 'medium' ? '#FFD93D' : '#FF6B6B',
                letterSpacing: '0.06em', textTransform: 'uppercase',
              }}>
                {confidencePayload.level === 'high' ? '● HIGH' : confidencePayload.level === 'medium' ? '◐ MEDIUM' : '○ LOW'} CONFIDENCE
              </span>
              <span style={{ color: '#4b5563', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}>
                — {confidencePayload.reason}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {/* DEEP button */}
              <button
                onClick={() => {
                  const deepText = `[DEEP][MODIFICAR] En ${confidencePayload.files[0] ?? 'el archivo'}, corrige: ${confidencePayload.diagnosis}`;
                  setMode('deep');
                  setPrompt(deepText);
                }}
                style={{
                  flex: 1, padding: '8px 10px',
                  background: confidencePayload.suggestedAction === 'deep'
                    ? 'rgba(124,58,237,0.18)' : 'rgba(124,58,237,0.07)',
                  border: confidencePayload.suggestedAction === 'deep'
                    ? '1px solid #7c3aed' : '1px solid #3b2a5a',
                  borderRadius: 7, color: 'rgba(255,255,255,0.55)',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 11, fontWeight: confidencePayload.suggestedAction === 'deep' ? 700 : 500,
                  cursor: 'pointer', letterSpacing: '0.04em', transition: 'background 0.15s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(124,58,237,0.26)'; }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = confidencePayload.suggestedAction === 'deep'
                    ? 'rgba(124,58,237,0.18)' : 'rgba(124,58,237,0.07)';
                }}
              >
                ⚡ Enviar a DEEP
              </button>
              {/* CHAT button */}
              <button
                onClick={() => {
                  const originalPrompt = currentPromptRef.current;
                  const isDeep = confidencePayload.suggestedAction === 'chat';
                  const hasEvidence = confidencePayload.files.length > 0;
                  const chatText = isDeep
                    ? hasEvidence
                      ? `La pregunta original fue: ${originalPrompt}\n\nDEEP encontró evidencia en: ${confidencePayload.files.join(', ')}. El findingId ya está cargado con los fragmentos literales y citas file:line exactas — analizá desde esa evidencia sin repetir la búsqueda.`
                      : `La pregunta original fue: ${originalPrompt}\n\nDEEP no pudo confirmar evidencia literal para este símbolo. El índice puede estar desactualizado o el símbolo puede tener un nombre diferente en el código. Explorá el codebase para ubicarlo antes de proponer un fix.`
                    : `La pregunta original fue: ${originalPrompt}\n\nFAST encontró contexto parcial en: ${confidencePayload.files.join(', ')}. Diagnóstico inicial: ${confidencePayload.diagnosis}. Verificá dependencias externas (timers, funciones que llaman a esto, loops que podrían apagar la condición) antes de proponer un fix.`;
                  pendingAutoSendRef.current = chatText;
                  setMode('chat');
                  setPrompt(chatText);
                }}
                style={{
                  flex: 1, padding: '8px 10px',
                  background: confidencePayload.suggestedAction === 'chat'
                    ? 'rgba(0,255,136,0.12)' : 'rgba(0,255,136,0.05)',
                  border: confidencePayload.suggestedAction === 'chat'
                    ? '1px solid #1e3f2a' : '1px solid #0f2a1a',
                  borderRadius: 7, color: '#4ade80',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 11, fontWeight: confidencePayload.suggestedAction === 'chat' ? 700 : 500,
                  cursor: 'pointer', letterSpacing: '0.04em', transition: 'background 0.15s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0,255,136,0.2)'; }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = confidencePayload.suggestedAction === 'chat'
                    ? 'rgba(0,255,136,0.12)' : 'rgba(0,255,136,0.05)';
                }}
              >
                💬 Enviar a CHAT
              </button>
              {/* Claude Code — placeholder */}
              <button
                disabled
                style={{
                  flex: 1, padding: '8px 10px',
                  background: 'rgba(75,85,99,0.07)',
                  border: '1px solid #1f2937',
                  borderRadius: 7, color: '#4b5563',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 11, fontWeight: 500,
                  cursor: 'not-allowed', letterSpacing: '0.04em',
                  opacity: 0.6,
                }}
              >
                🤖 Claude Code
              </button>
            </div>
          </div>
        )}

        {/* Enviar a War Room */}
        {result && onSendToWarRoom && (
          <button
            onClick={() => {
              const filesToSend = readFilesRef.current.length > 0
                ? readFilesRef.current
                : (result.files ?? []);
              onSendToWarRoom({
                challenge: currentPromptRef.current,
                appName: activeProject.name,
                repoContext: filesToSend.length ? {
                  tree: filesToSend.map((f) => f.path),
                  keyFiles: filesToSend.map((f) => ({ 
                    path: f.path, 
                    content: f.content 
                  })),
                } : undefined,
              });
            }}
            style={{
              width: '100%', padding: '10px 14px',
              background: 'rgba(0,255,136,0.07)',
              border: '1px solid #1e3f2a',
              borderRadius: 7, color: 'rgba(255,255,255,0.82)',
              fontFamily: 'JetBrains Mono, monospace', 
              fontSize: 12, fontWeight: 700,
              cursor: 'pointer', letterSpacing: '0.05em', 
              transition: 'background 0.15s',
              display: 'flex', alignItems: 'center', 
              justifyContent: 'center', gap: 8,
              marginTop: 8,
            }}
            onMouseEnter={(e) => { 
              e.currentTarget.style.background = 'rgba(0,255,136,0.14)'; 
            }}
            onMouseLeave={(e) => { 
              e.currentTarget.style.background = 'rgba(0,255,136,0.07)'; 
            }}
          >
            🏛 Enviar a War Room
          </button>
        )}

        {/* ── UI PROJECT result panel ───────────────────────────────────────── */}
        {result && !running && !isBackend && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>

            {/* READ-ONLY: no commitMessage → show file content viewer, no commit button */}
            {!result.commitMessage && result.files?.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {result.files.map((file, idx) => {
                  const lines = file.content.split('\n');
                  return (
                    <div key={idx} style={{
                      border: '1px solid #1e3a2a', borderLeft: '2px solid #00ff88',
                      borderRadius: 6, overflow: 'hidden', background: '#080808',
                    }}>
                      <div style={{
                        padding: '5px 10px', borderBottom: '1px solid #1e3a2a',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        background: '#060606',
                      }}>
                        <span style={{ color: 'rgba(255,255,255,0.82)', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}>
                          📄 {file.path}
                        </span>
                        <span style={{ color: 'rgba(255,255,255,0.28)', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}>
                          {lines.length} líneas
                        </span>
                      </div>
                      <div style={{
                        fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
                        lineHeight: 1.55, padding: '6px 8px',
                        whiteSpace: 'pre-wrap', overflowX: 'auto',
                      }}>
                        {lines.map((line, i) => (
                          <div key={i} style={{ display: 'flex' }}>
                            <span style={{
                              color: 'rgba(255,255,255,0.12)', userSelect: 'none',
                              minWidth: 32, textAlign: 'right', marginRight: 10, flexShrink: 0,
                            }}>
                              {i + 1}
                            </span>
                            <span style={{ color: 'rgba(255,255,255,0.55)' }}>{line || ' '}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              /* GENERATE mode: full 2-column diff viewer + commit */
              <>
                {/* Per-file diff */}
                {result.files?.map((file, idx) => {
                  const origLines = (file.originalContent ?? '').split('\n');
                  const newLines  = file.content.split('\n');
                  const isNew     = file.originalContent === undefined;
                  const diff      = isNew ? [] : computeLineDiff(origLines, newLines);
                  const pairs     = isNew ? [] : toPairedRows(diff);
                  const added     = isNew ? newLines.length : diff.filter((d) => d.type === 'added').length;
                  const removed   = isNew ? 0 : diff.filter((d) => d.type === 'removed').length;
                  return (
                    <div key={idx} style={{
                      border: '1px solid rgba(255,255,255,0.07)', borderLeft: '2px solid #7c3aed',
                      borderRadius: 6, overflow: 'hidden', background: '#080808',
                    }}>
                      {/* header */}
                      <div style={{
                        padding: '5px 10px', borderBottom: '1px solid rgba(255,255,255,0.07)',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      }}>
                        <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}>
                          📄 {file.path}
                        </span>
                        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, display: 'flex', gap: 8 }}>
                          {removed > 0 && <span style={{ color: '#f87171' }}>−{removed}</span>}
                          {added   > 0 && <span style={{ color: '#86efac' }}>+{added}</span>}
                          {isNew && <span style={{ color: 'rgba(255,255,255,0.55)' }}>nuevo archivo</span>}
                          {!isNew && removed === 0 && added === 0 && <span style={{ color: 'rgba(255,255,255,0.28)' }}>sin cambios</span>}
                        </span>
                      </div>
                      {/* columns */}
                      {isNew ? (
                        <div style={{
                          fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
                          lineHeight: 1.55, padding: '6px 8px',
                          whiteSpace: 'pre-wrap', overflowX: 'auto',
                        }}>
                          {newLines.map((line, i) => (
                            <div key={i} style={{ display: 'flex', background: 'rgba(34,197,94,0.06)' }}>
                              <span style={{ color: 'rgba(255,255,255,0.12)', userSelect: 'none', minWidth: 32, textAlign: 'right', marginRight: 8, flexShrink: 0 }}>
                                {i + 1}
                              </span>
                              <span style={{ color: '#86efac' }}>{line || ' '}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: 0 }}>
                          {/* LEFT — original */}
                          <div style={{ flex: 1, minWidth: 0, borderRight: '1px solid rgba(255,255,255,0.06)' }}>
                            <div style={{
                              padding: '2px 8px', color: 'rgba(255,255,255,0.28)', fontSize: 9,
                              fontFamily: 'JetBrains Mono, monospace',
                              borderBottom: '1px solid rgba(255,255,255,0.06)', background: '#060606',
                            }}>ANTES</div>
                            <div style={{
                              fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
                              lineHeight: 1.55, padding: '6px 4px',
                              whiteSpace: 'pre-wrap', overflowX: 'auto',
                            }}>
                              {pairs.map((row, i) => (
                                <div key={i} style={{
                                  display: 'flex',
                                  background: row.leftType === 'removed' ? 'rgba(239,68,68,0.12)' : 'transparent',
                                  minHeight: '1.55em',
                                }}>
                                  <span style={{ color: 'rgba(255,255,255,0.12)', userSelect: 'none', minWidth: 32, textAlign: 'right', marginRight: 6, flexShrink: 0 }}>
                                    {row.leftNum ?? ''}
                                  </span>
                                  <span style={{ color: row.leftType === 'removed' ? '#fca5a5' : '#3a3a5c' }}>
                                    {row.leftText ?? ''}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                          {/* RIGHT — new */}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{
                              padding: '2px 8px', color: 'rgba(255,255,255,0.28)', fontSize: 9,
                              fontFamily: 'JetBrains Mono, monospace',
                              borderBottom: '1px solid rgba(255,255,255,0.06)', background: '#060606',
                            }}>DESPUÉS</div>
                            <div style={{
                              fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
                              lineHeight: 1.55, padding: '6px 4px',
                              whiteSpace: 'pre-wrap', overflowX: 'auto',
                            }}>
                              {pairs.map((row, i) => (
                                <div key={i} style={{
                                  display: 'flex',
                                  background: row.rightType === 'added' ? 'rgba(34,197,94,0.08)' : 'transparent',
                                  minHeight: '1.55em',
                                }}>
                                  <span style={{ color: 'rgba(255,255,255,0.12)', userSelect: 'none', minWidth: 32, textAlign: 'right', marginRight: 6, flexShrink: 0 }}>
                                    {row.rightNum ?? ''}
                                  </span>
                                  <span style={{ color: row.rightType === 'added' ? '#86efac' : '#3a3a5c' }}>
                                    {row.rightText ?? ''}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Incomplete agentic loop warning */}
                {result?.incomplete && (
                  <div style={{
                    background: 'rgba(245,158,11,0.1)',
                    border: '1px solid rgba(245,158,11,0.4)',
                    borderLeft: '3px solid #f59e0b',
                    borderRadius: 6, padding: '8px 12px',
                    color: '#fbbf24',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 11, lineHeight: 1.5,
                  }}>
                    ⚠️ Cambio incompleto — el agente alcanzó el límite de turnos sin confirmar que la tarea terminó. Revisa cuidadosamente antes de aprobar; puede faltar parte del fix.
                  </div>
                )}

                {/* Commit button */}
                <div style={{ display: 'flex', gap: 8 }}>
                  {!commitResult ? (
                    <button
                      onClick={commitToGitHub}
                      disabled={committing}
                      style={{
                        flex: 1,
                        background: committing ? '#1e1e3f' : 'rgba(124,58,237,0.12)',
                        border: `1px solid ${committing ? '#1e1e3f' : '#4c1d95'}`,
                        borderRadius: 6, color: committing ? '#3a3a5c' : '#a78bfa',
                        fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700,
                        padding: '9px 12px', cursor: committing ? 'not-allowed' : 'pointer',
                        letterSpacing: '0.04em', transition: 'background 0.15s',
                      }}
                      onMouseEnter={(e) => { if (!committing) e.currentTarget.style.background = 'rgba(124,58,237,0.22)'; }}
                      onMouseLeave={(e) => { if (!committing) e.currentTarget.style.background = 'rgba(124,58,237,0.12)'; }}
                    >
                      {committing ? '⟳ Committing…' : `✅ Aprobar y commitear ${result.files?.length} archivo(s)`}
                    </button>
                  ) : (
                    <a
                      href={githubUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'rgba(124,58,237,0.12)', border: '1px solid #4c1d95',
                        borderRadius: 6, color: 'rgba(255,255,255,0.55)', fontFamily: 'JetBrains Mono, monospace',
                        fontSize: 11, fontWeight: 700, padding: '9px 12px', textAlign: 'center',
                        letterSpacing: '0.04em', textDecoration: 'none',
                      }}
                    >
                      ✅ Commit {shortSha}
                    </a>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 12px',
        borderTop: '1px solid rgba(255,255,255,0.07)', flexShrink: 0, background: '#0a0a0a',
      }}>
        {/* Modo de razonamiento */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{
            color: 'rgba(255,255,255,0.25)', fontSize: 10, fontFamily: 'JetBrains Mono, monospace',
            letterSpacing: '0.06em',
          }}>
            MODO
          </span>
          <button
            onClick={() => setMode('fast')}
            style={{
              background: mode === 'fast' ? 'rgba(255,255,255,0.07)' : 'transparent',
              border: `1px solid ${mode === 'fast' ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.07)'}`,
              borderRadius: 4, color: mode === 'fast' ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.28)',
              fontSize: 10, fontWeight: 700, padding: '3px 8px', cursor: 'pointer',
              fontFamily: 'JetBrains Mono, monospace',
            }}
          >
            ⚡ FAST
          </button>
          <button
            onClick={() => setMode('deep')}
            style={{
              background: mode === 'deep' ? 'rgba(255,255,255,0.07)' : 'transparent',
              border: `1px solid ${mode === 'deep' ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.07)'}`,
              borderRadius: 4, color: mode === 'deep' ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.28)',
              fontSize: 10, fontWeight: 700, padding: '3px 8px', cursor: 'pointer',
              fontFamily: 'JetBrains Mono, monospace',
            }}
          >
            🧠 DEEP
          </button>
          <button
            onClick={() => setMode('chat')}
            style={{
              background: mode === 'chat' ? 'rgba(255,255,255,0.07)' : 'transparent',
              border: `1px solid ${mode === 'chat' ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.07)'}`,
              borderRadius: 4, color: mode === 'chat' ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.28)',
              fontSize: 10, fontWeight: 700, padding: '3px 8px', cursor: 'pointer',
              fontFamily: 'JetBrains Mono, monospace',
            }}
          >
            💬 CHAT
          </button>
          <button
            onClick={() => setMode('auto')}
            style={{
              background: mode === 'auto' ? 'rgba(255,255,255,0.07)' : 'transparent',
              border: `1px solid ${mode === 'auto' ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.07)'}`,
              borderRadius: 4, color: mode === 'auto' ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.28)',
              fontSize: 10, fontWeight: 700, padding: '3px 8px', cursor: 'pointer',
              fontFamily: 'JetBrains Mono, monospace',
            }}
          >
            🤖 AUTO
          </button>
        </div>

        {mode === 'auto' && (
          <div style={{
            fontSize: 10, color: 'rgba(255,255,255,0.38)',
            fontFamily: 'JetBrains Mono, monospace',
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 4, padding: '4px 8px', lineHeight: 1.5,
          }}>
            🤖 AUTO explora y edita de forma autónoma en un entorno aislado. Revisa el diff antes de aprobar.
          </div>
        )}

        {/* Repo selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            color: 'rgba(255,255,255,0.25)', fontSize: 10, fontFamily: 'JetBrains Mono, monospace',
            letterSpacing: '0.06em', whiteSpace: 'nowrap',
          }}>
            REPO
          </span>
          <select
            value={selectedRepo}
            onChange={(e) => {
              const newRepo = e.target.value;
              setSelectedRepo(newRepo);
              const project = PROJECTS.find(p => p.repo === newRepo);
              if (project) onProjectChange?.(project);
            }}
            disabled={running}
            style={{
              flex: 1, height: 26, background: '#0a0a0a', border: '1px solid rgba(255,255,255,0.07)',
              borderRadius: 4, color: 'rgba(255,255,255,0.7)', fontSize: 11,
              fontFamily: 'JetBrains Mono, monospace', padding: '0 6px',
              cursor: running ? 'not-allowed' : 'pointer', outline: 'none',
            }}
          >
            <option value="quark-ide">QUARK IDE (quark-ide)</option>
            <option value="Ahorar">Signal OS (Ahorar)</option>
            <option value="Trade-SnipeOS">Sniper OS (Trade-SnipeOS)</option>
            <option value="NEXUS-OS-app">Nexus OS (NEXUS-OS-app)</option>
            <option value="Code-Coretest">Core AI (Code-Coretest)</option>
          </select>
        </div>

        {/* Prompt row */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea
          ref={agentTextareaRef}
          className="quark-input"
          style={{
            flex: 1, minWidth: 0, fontSize: 12,
            resize: 'none', overflowY: 'auto',
            minHeight: 44, maxHeight: 200,
            lineHeight: '1.5', paddingTop: 8, paddingBottom: 8,
            boxSizing: 'border-box',
          }}
          placeholder="Describe lo que quieres generar..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              generate();
            }
          }}
          disabled={running}
        />
        <button
          className="quark-btn-primary"
          onClick={() => generate()}
          disabled={running || !prompt.trim()}
          style={{ flexShrink: 0, fontSize: 11 }}
        >
          {running ? '⟳' : mode === 'chat' ? '💬 SEND' : '⚡ GEN'}
        </button>
        </div>
      </div>
    </div>
  );
}
