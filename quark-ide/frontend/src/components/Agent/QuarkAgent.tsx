import { useState, useRef, useEffect } from 'react';
import type { Project } from '../../App';

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
  event: 'action' | 'file' | 'done' | 'error';
  text?: string;
  path?: string;
  files?: { path: string; content: string; originalContent?: string }[];
  commitMessage?: string;
  mainComponent?: string;
  mainContent?: string;
  repo?: string;
  branch?: string;
}

// Local feed items (superset — includes synthetic 'code' events)
interface FeedItem {
  event: 'action' | 'file' | 'done' | 'error' | 'code';
  text?: string;
  path?: string;
  content?: string;
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

const FIX_KEYWORDS = /\b(corrige|corrígeme|fix|arregla|repara|soluciona)\b/i;

interface Props {
  activeProject: Project;
  onApplyToEditor: (code: string) => void;
  onShowPreview: (html: string) => void;
  initialPrompt?: string;
}

const LS_REPO_KEY      = 'quark-agent-repo';
const LS_DEEPMODE_KEY  = 'quark-agent-deepmode';

export default function QuarkAgent({ activeProject, onApplyToEditor, onShowPreview, initialPrompt }: Props) {
  const [prompt, setPrompt]               = useState('');
  const [selectedRepo, setSelectedRepo]   = useState(
    () => localStorage.getItem(LS_REPO_KEY) ?? activeProject.repo ?? 'quark-ide',
  );
  const [running, setRunning]             = useState(false);
  const [feed, setFeed]                   = useState<FeedItem[]>([]);
  const [result, setResult]               = useState<AgentEvent | null>(null);
  const [committing, setCommitting]       = useState(false);
  const [commitResult, setCommitResult]   = useState<CommitResult | null>(null);
  const [isGeneratingHtml, setIsGeneratingHtml] = useState(false);
  const [fixResult, setFixResult]               = useState<FixResult | null>(null);
  const [deepMode, setDeepMode]                 = useState(
    () => localStorage.getItem(LS_DEEPMODE_KEY) === 'true',
  );
  const [sessionLoading, setSessionLoading] = useState(true);
  const [editableCommitMsg, setEditableCommitMsg] = useState('');
  const previewTriggeredRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const agentTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Keep a live ref so closures in useEffect always read the current value
  const isBackend = isBackendProject(activeProject.name);
  const isBackendRef = useRef(isBackend);
  isBackendRef.current = isBackend;

  // ── Session persistence ────────────────────────────────────────────────────

  // Persist repo + deepMode prefs immediately to localStorage
  useEffect(() => { localStorage.setItem(LS_REPO_KEY, selectedRepo); }, [selectedRepo]);
  useEffect(() => { localStorage.setItem(LS_DEEPMODE_KEY, String(deepMode)); }, [deepMode]);

  // Load feed + result from DB on mount
  useEffect(() => {
    async function loadSession() {
      try {
        const res = await fetch(`${API_BASE}/agent/session`);
        if (!res.ok) return;
        const data = await res.json() as { session: { feed: FeedItem[]; result: AgentEvent | null; commitResult: CommitResult | null; fixResult: FixResult | null } | null };
        if (data.session) {
          if (data.session.feed?.length)        setFeed(data.session.feed);
          if (data.session.result)              setResult(data.session.result);
          if (data.session.commitResult)        setCommitResult(data.session.commitResult);
          if (data.session.fixResult)           setFixResult(data.session.fixResult);
        }
      } catch {
        // fail silently — agent works without session
      } finally {
        setSessionLoading(false);
      }
    }
    loadSession();
  }, []);

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

  async function generate(promptOverride?: string) {
    const text = (promptOverride ?? prompt).trim();
    if (!text || running) return;
    if (agentTextareaRef.current) agentTextareaRef.current.style.height = '44px';
    setRunning(true);
    setFeed([]);
    setResult(null);
    setFixResult(null);
    setCommitResult(null);
    previewTriggeredRef.current = false;

    // ── FIX PATH — route to callFix when fix keyword + filename detected ──────
    const fileInPrompt = text.match(/[\w/\-\.]+\.(ts|tsx|js|jsx|json|py|md|yml|yaml)/);
    if (FIX_KEYWORDS.test(text) && fileInPrompt) {
      setRunning(false); // callFix manages its own running state
      await callFix(text, fileInPrompt[0]);
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
          deepMode,
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
              setResult(parsed);

              // For backend projects: inject code blocks into the feed from done.files
              if (isBackendRef.current && parsed.files?.length) {
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

            } else {
              setFeed((prev) => [...prev, { event: parsed.event, text: parsed.text }]);
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

  const shortSha    = commitResult?.sha.slice(0, 7) ?? '';
  const githubUrl   = commitResult
    ? `https://github.com/${commitResult.owner}/${commitResult.repo}/commit/${commitResult.sha}`
    : '';
  const railwayUrl  = `https://railway.app/project/${activeProject.railwayProjectId}`;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
      background: '#0d0d1a', overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '8px 12px', borderBottom: '1px solid #1e1e3f',
        display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, background: '#0d0d1a',
      }}>
        <span style={{ color: '#00ff88', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em' }}>
          🤖 QUARK AGENT
        </span>
        <span style={{ color: '#3a3a5c', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          — {activeProject.emoji} {activeProject.name}
          {isBackend && (
            <span style={{ color: '#f59e0b', marginLeft: 6, fontSize: 10 }}>backend</span>
          )}
        </span>
        {(feed.length > 0 || result || commitResult || fixResult) && !running && (
          <button
            onClick={() => {
              setResult(null);
              setFeed([]);
              setCommitResult(null);
              setFixResult(null);
              setEditableCommitMsg('');
              saveSession([], null, null, null);
            }}
            style={{
              background: 'rgba(0,255,136,0.06)', border: '1px solid #1e3f2a',
              borderRadius: 4, color: '#00ff88',
              fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 700,
              padding: '3px 8px', cursor: 'pointer', letterSpacing: '0.04em',
              whiteSpace: 'nowrap', transition: 'background 0.15s', flexShrink: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0,255,136,0.14)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(0,255,136,0.06)'; }}
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
          <p style={{ color: '#3a3a5c', fontSize: 11, margin: 0, fontFamily: 'JetBrains Mono, monospace' }}>
            ⚛ Cargando sesión...
          </p>
        )}
        {!sessionLoading && feed.length === 0 && !running && !result && (
          <p style={{ color: '#3a3a5c', fontSize: 12, margin: 0, lineHeight: 1.6 }}>
            Describe lo que quieres construir en{' '}
            <span style={{ color: '#00ff88' }}>{activeProject.name}</span>.
            El Agent leerá el repo, generará los archivos y te dará la opción de hacer commit.
          </p>
        )}

        {feed.map((ev, i) => {
          if (ev.event === 'action') return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: '#00ff88', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}>
                {ev.text}
              </span>
            </div>
          );

          if (ev.event === 'file') return (
            <div key={i} style={{
              background: '#0a0a16', border: '1px solid #1e1e3f', borderLeft: '2px solid #00ff88',
              borderRadius: 4, padding: '3px 10px',
              color: '#6b7280', fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
            }}>
              📄 {ev.path}
            </div>
          );

          if (ev.event === 'code') return (
            <div key={i} style={{
              background: '#0a0a16',
              border: '1px solid #1e1e3f',
              borderLeft: '2px solid #7c3aed',
              borderRadius: 6,
              overflow: 'hidden',
            }}>
              {/* file path header */}
              <div style={{
                padding: '4px 10px',
                borderBottom: '1px solid #1e1e3f',
                color: '#7c3aed',
                fontSize: 10,
                fontFamily: 'JetBrains Mono, monospace',
                letterSpacing: '0.05em',
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <span style={{ color: '#3a3a5c' }}>📄</span>
                {ev.path}
              </div>
              {/* code content */}
              <div style={{
                padding: '10px 12px',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 10,
                color: '#a0a0c0',
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
              background: 'rgba(255,68,68,0.08)', border: '1px solid #3f1e1e',
              borderRadius: 4, padding: '6px 10px',
              color: '#ff4444', fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
            }}>
              ❌ {ev.text}
            </div>
          );

          return null;
        })}

        {running && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: '#00ff88', fontSize: 18 }}>⚛</span>
            <span style={{ color: '#3a3a5c', fontSize: 12, fontFamily: 'JetBrains Mono, monospace' }}>
              procesando
              <span className="thinking-dots" />
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
                  <div style={{ color: '#6b7280', fontSize: 10, fontFamily: 'JetBrains Mono, monospace', padding: '2px 6px' }}>
                    ANTES
                  </div>
                  <div style={{
                    background: '#0a0a16', border: '1px solid #2d1515', borderRadius: 4,
                    fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: '#a0a0c0',
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
                  <div style={{ color: '#6b7280', fontSize: 10, fontFamily: 'JetBrains Mono, monospace', padding: '2px 6px' }}>
                    DESPUÉS
                  </div>
                  <div style={{
                    background: '#0a0a16', border: '1px solid #153015', borderRadius: 4,
                    fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: '#a0a0c0',
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
                  <span style={{ color: '#00ff88', fontSize: 12 }}>✅</span>
                  <span style={{ color: '#00ff88', fontSize: 11, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}>
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
                      borderRadius: 6, color: '#a78bfa', fontSize: 11, fontWeight: 700,
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
                      borderRadius: 6, overflow: 'hidden', background: '#080f0a',
                    }}>
                      {/* header */}
                      <div style={{
                        padding: '5px 10px', borderBottom: '1px solid #1e3a2a',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        background: '#060d08',
                      }}>
                        <span style={{ color: '#00ff88', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}>
                          📄 {file.path}
                        </span>
                        <span style={{ color: '#3a5c4a', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}>
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
                              color: '#1e3a2a', userSelect: 'none',
                              minWidth: 32, textAlign: 'right', marginRight: 10, flexShrink: 0,
                            }}>
                              {i + 1}
                            </span>
                            <span style={{ color: '#a0c0a8' }}>{line || ' '}</span>
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
                    const isNew     = !file.originalContent;
                    const diff      = isNew ? [] : computeLineDiff(origLines, newLines);
                    const pairs     = isNew ? [] : toPairedRows(diff);
                    const added     = isNew ? newLines.length : diff.filter((d) => d.type === 'added').length;
                    const removed   = isNew ? 0 : diff.filter((d) => d.type === 'removed').length;
                    return (
                      <div key={idx} style={{
                        border: '1px solid #1e1e3f',
                        borderLeft: '2px solid #7c3aed',
                        borderRadius: 6,
                        overflow: 'hidden',
                        background: '#0a0a16',
                      }}>
                        {/* header */}
                        <div style={{
                          padding: '5px 10px',
                          borderBottom: '1px solid #1e1e3f',
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        }}>
                          <span style={{ color: '#7c3aed', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}>
                            📄 {file.path}
                          </span>
                          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, display: 'flex', gap: 8 }}>
                            {removed > 0 && <span style={{ color: '#f87171' }}>−{removed}</span>}
                            {added   > 0 && <span style={{ color: '#86efac' }}>+{added}</span>}
                            {isNew && <span style={{ color: '#a78bfa' }}>nuevo archivo</span>}
                            {!isNew && removed === 0 && added === 0 && <span style={{ color: '#3a3a5c' }}>sin cambios</span>}
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
                                <span style={{ color: '#2a2a4a', userSelect: 'none', minWidth: 32, textAlign: 'right', marginRight: 8, flexShrink: 0 }}>
                                  {i + 1}
                                </span>
                                <span style={{ color: '#86efac' }}>{line || ' '}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div style={{ display: 'flex', gap: 0 }}>
                            {/* LEFT — original */}
                            <div style={{ flex: 1, minWidth: 0, borderRight: '1px solid #1a1a2e' }}>
                              <div style={{
                                padding: '2px 8px', color: '#3a3a5c', fontSize: 9,
                                fontFamily: 'JetBrains Mono, monospace',
                                borderBottom: '1px solid #1a1a2e', background: '#080810',
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
                                    <span style={{ color: '#2a2a4a', userSelect: 'none', minWidth: 32, textAlign: 'right', marginRight: 6, flexShrink: 0 }}>
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
                                padding: '2px 8px', color: '#3a3a5c', fontSize: 9,
                                fontFamily: 'JetBrains Mono, monospace',
                                borderBottom: '1px solid #1a1a2e', background: '#080810',
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
                                    <span style={{ color: '#2a2a4a', userSelect: 'none', minWidth: 32, textAlign: 'right', marginRight: 6, flexShrink: 0 }}>
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
                  color: '#4b6b58', fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
                }}>
                  ✅ Diagnóstico completado — sin archivos para commit
                </div>
              )
            )}
          </div>
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
                      borderRadius: 6, overflow: 'hidden', background: '#080f0a',
                    }}>
                      <div style={{
                        padding: '5px 10px', borderBottom: '1px solid #1e3a2a',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        background: '#060d08',
                      }}>
                        <span style={{ color: '#00ff88', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}>
                          📄 {file.path}
                        </span>
                        <span style={{ color: '#3a5c4a', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}>
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
                              color: '#1e3a2a', userSelect: 'none',
                              minWidth: 32, textAlign: 'right', marginRight: 10, flexShrink: 0,
                            }}>
                              {i + 1}
                            </span>
                            <span style={{ color: '#a0c0a8' }}>{line || ' '}</span>
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
                  const isNew     = !file.originalContent;
                  const diff      = isNew ? [] : computeLineDiff(origLines, newLines);
                  const pairs     = isNew ? [] : toPairedRows(diff);
                  const added     = isNew ? newLines.length : diff.filter((d) => d.type === 'added').length;
                  const removed   = isNew ? 0 : diff.filter((d) => d.type === 'removed').length;
                  return (
                    <div key={idx} style={{
                      border: '1px solid #1e1e3f', borderLeft: '2px solid #7c3aed',
                      borderRadius: 6, overflow: 'hidden', background: '#0a0a16',
                    }}>
                      {/* header */}
                      <div style={{
                        padding: '5px 10px', borderBottom: '1px solid #1e1e3f',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      }}>
                        <span style={{ color: '#7c3aed', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}>
                          📄 {file.path}
                        </span>
                        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, display: 'flex', gap: 8 }}>
                          {removed > 0 && <span style={{ color: '#f87171' }}>−{removed}</span>}
                          {added   > 0 && <span style={{ color: '#86efac' }}>+{added}</span>}
                          {isNew && <span style={{ color: '#a78bfa' }}>nuevo archivo</span>}
                          {!isNew && removed === 0 && added === 0 && <span style={{ color: '#3a3a5c' }}>sin cambios</span>}
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
                              <span style={{ color: '#2a2a4a', userSelect: 'none', minWidth: 32, textAlign: 'right', marginRight: 8, flexShrink: 0 }}>
                                {i + 1}
                              </span>
                              <span style={{ color: '#86efac' }}>{line || ' '}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: 0 }}>
                          {/* LEFT — original */}
                          <div style={{ flex: 1, minWidth: 0, borderRight: '1px solid #1a1a2e' }}>
                            <div style={{
                              padding: '2px 8px', color: '#3a3a5c', fontSize: 9,
                              fontFamily: 'JetBrains Mono, monospace',
                              borderBottom: '1px solid #1a1a2e', background: '#080810',
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
                                  <span style={{ color: '#2a2a4a', userSelect: 'none', minWidth: 32, textAlign: 'right', marginRight: 6, flexShrink: 0 }}>
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
                              padding: '2px 8px', color: '#3a3a5c', fontSize: 9,
                              fontFamily: 'JetBrains Mono, monospace',
                              borderBottom: '1px solid #1a1a2e', background: '#080810',
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
                                  <span style={{ color: '#2a2a4a', userSelect: 'none', minWidth: 32, textAlign: 'right', marginRight: 6, flexShrink: 0 }}>
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
                        borderRadius: 6, color: '#a78bfa', fontFamily: 'JetBrains Mono, monospace',
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
        borderTop: '1px solid #1e1e3f', flexShrink: 0, background: '#0d0d1a',
      }}>
        {/* Modo de razonamiento */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{
            color: '#3a3a5c', fontSize: 10, fontFamily: 'JetBrains Mono, monospace',
            letterSpacing: '0.06em',
          }}>
            MODO
          </span>
          <button
            onClick={() => setDeepMode(false)}
            style={{
              background: !deepMode ? 'rgba(0,255,136,0.15)' : 'transparent',
              border: `1px solid ${!deepMode ? '#00ff88' : '#1e1e3f'}`,
              borderRadius: 4, color: !deepMode ? '#00ff88' : '#3a3a5c',
              fontSize: 10, fontWeight: 700, padding: '3px 8px', cursor: 'pointer',
              fontFamily: 'JetBrains Mono, monospace',
            }}
          >
            ⚡ FAST
          </button>
          <button
            onClick={() => setDeepMode(true)}
            style={{
              background: deepMode ? 'rgba(124,58,237,0.15)' : 'transparent',
              border: `1px solid ${deepMode ? '#7c3aed' : '#1e1e3f'}`,
              borderRadius: 4, color: deepMode ? '#a78bfa' : '#3a3a5c',
              fontSize: 10, fontWeight: 700, padding: '3px 8px', cursor: 'pointer',
              fontFamily: 'JetBrains Mono, monospace',
            }}
          >
            🧠 DEEP
          </button>
        </div>

        {/* Repo selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            color: '#3a3a5c', fontSize: 10, fontFamily: 'JetBrains Mono, monospace',
            letterSpacing: '0.06em', whiteSpace: 'nowrap',
          }}>
            REPO
          </span>
          <select
            value={selectedRepo}
            onChange={(e) => setSelectedRepo(e.target.value)}
            disabled={running}
            style={{
              flex: 1, height: 26, background: '#0a0a16', border: '1px solid #1e1e3f',
              borderRadius: 4, color: '#00ff88', fontSize: 11,
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
          {running ? '⟳' : '⚡ GEN'}
        </button>
        </div>
      </div>
    </div>
  );
}
