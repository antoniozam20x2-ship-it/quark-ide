import { useState, useRef, useEffect } from 'react';
import type { Project } from '../../App';

const API_BASE = (import.meta.env.VITE_API_URL ?? window.location.origin).replace(/\/$/, '');

const BACKEND_PROJECTS = ['Signal OS', 'Sniper OS', 'Nexus OS'];

function isBackendProject(name: string): boolean {
  return BACKEND_PROJECTS.some((b) => name.includes(b));
}

// Server-sent event shape
interface AgentEvent {
  event: 'action' | 'file' | 'done' | 'error';
  text?: string;
  path?: string;
  files?: { path: string; content: string }[];
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

export default function QuarkAgent({ activeProject, onApplyToEditor, onShowPreview, initialPrompt }: Props) {
  const [prompt, setPrompt]               = useState('');
  const [running, setRunning]             = useState(false);
  const [feed, setFeed]                   = useState<FeedItem[]>([]);
  const [result, setResult]               = useState<AgentEvent | null>(null);
  const [committing, setCommitting]       = useState(false);
  const [commitResult, setCommitResult]   = useState<CommitResult | null>(null);
  const [isGeneratingHtml, setIsGeneratingHtml] = useState(false);
  const [fixResult, setFixResult]               = useState<FixResult | null>(null);
  const previewTriggeredRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Keep a live ref so closures in useEffect always read the current value
  const isBackend = isBackendProject(activeProject.name);
  const isBackendRef = useRef(isBackend);
  isBackendRef.current = isBackend;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [feed, result, commitResult]);

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
          repo:             activeProject.repo,
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
      setFixResult({
        filePath:        data.filePath!,
        fixedContent:    data.fixedContent,
        originalContent: data.originalContent ?? '',
        branch:          data.branch ?? activeProject.branch,
      });
      setFeed((prev) => [...prev, { event: 'action', text: '✅ Corrección lista — revisa el diff antes de hacer commit' }]);
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
          repo:    activeProject.repo,
          branch:  fixResult.branch,
        }),
      });
      const data = await res.json() as { sha?: string; owner?: string; error?: string };
      if (!data.sha) throw new Error(data.error ?? 'Commit failed');
      setCommitResult({
        sha:     data.sha,
        owner:   data.owner ?? '',
        repo:    activeProject.repo,
        files:   [{ path: fixResult.filePath, content: fixResult.fixedContent }],
        message: `fix: ${fixResult.filePath}`,
      });
    } catch (err) {
      setFeed((prev) => [...prev, { event: 'error', text: err instanceof Error ? err.message : String(err) }]);
    } finally {
      setCommitting(false);
    }
  }

  async function generate(promptOverride?: string) {
    const text = (promptOverride ?? prompt).trim();
    if (!text || running) return;
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
          repo:        activeProject.repo,
          branch:      activeProject.branch,
          projectName: activeProject.name,
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
                setFeed((prev) => [
                  ...prev,
                  // separator
                  { event: 'action', text: `📂 ${parsed.files!.length} archivo(s) generados:` },
                  // one code block per file
                  ...parsed.files!.map((f) => ({
                    event: 'code' as const,
                    path: f.path,
                    content: f.content,
                  })),
                ]);
              } else {
                setFeed((prev) => [...prev, { event: parsed.event }]);
              }

              if (!isBackendRef.current && parsed.mainContent) {
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
  useEffect(() => {
    if (result && !isBackendRef.current && !isGeneratingHtml && !previewTriggeredRef.current) {
      previewTriggeredRef.current = true;
      generateHtml();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  async function generateHtml() {
    if (!result || isBackendRef.current) return; // hard guard: never for backend
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
          message: result.commitMessage,
          repo:    result.repo ?? activeProject.repo,
          branch:  result.branch ?? activeProject.branch,
        }),
      });
      const data = await res.json() as { sha?: string; owner?: string; error?: string };
      if (!data.sha) throw new Error(data.error ?? 'Commit failed');
      setCommitResult({
        sha:     data.sha,
        owner:   data.owner ?? '',
        repo:    result.repo ?? activeProject.repo,
        files:   result.files ?? [],
        message: result.commitMessage ?? '',
      });
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
        <span style={{ color: '#3a3a5c', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          — {activeProject.emoji} {activeProject.name}
          {isBackend && (
            <span style={{ color: '#f59e0b', marginLeft: 6, fontSize: 10 }}>backend</span>
          )}
        </span>
      </div>

      {/* Feed */}
      <div style={{
        flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 12px',
        display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        {feed.length === 0 && !running && !result && (
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
            ) : (
              /* Commit button — shown before commit */
              result.files?.length ? (
                <button
                  onClick={commitToGitHub}
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
                  {committing ? '⟳ Committing…' : `⚡ Commit ${result.files.length} archivo(s) a GitHub`}
                </button>
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
            <div style={{
              background: 'rgba(0,255,136,0.06)', border: '1px solid #1e3f2a',
              borderRadius: 6, padding: '8px 12px',
              color: '#00ff88', fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
            }}>
              ✅ {result.files?.length} archivos listos · {result.commitMessage}
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={generateHtml}
                disabled={isGeneratingHtml}
                style={{
                  flex: 1,
                  background: isGeneratingHtml ? '#1e1e3f' : 'rgba(0,255,136,0.1)',
                  border: '1px solid #1e3f2a',
                  borderRadius: 6, color: isGeneratingHtml ? '#3a3a5c' : '#00ff88',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 11, fontWeight: 700, padding: '8px 12px',
                  cursor: isGeneratingHtml ? 'not-allowed' : 'pointer',
                  letterSpacing: '0.04em', transition: 'background 0.15s',
                }}
                onMouseEnter={(e) => { if (!isGeneratingHtml) e.currentTarget.style.background = 'rgba(0,255,136,0.18)'; }}
                onMouseLeave={(e) => { if (!isGeneratingHtml) e.currentTarget.style.background = 'rgba(0,255,136,0.1)'; }}
              >
                {isGeneratingHtml ? '⚡ Generando…' : '▶️ Ver Preview'}
              </button>

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
                    padding: '8px 12px', cursor: committing ? 'not-allowed' : 'pointer',
                    letterSpacing: '0.04em', transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => { if (!committing) e.currentTarget.style.background = 'rgba(124,58,237,0.22)'; }}
                  onMouseLeave={(e) => { if (!committing) e.currentTarget.style.background = 'rgba(124,58,237,0.12)'; }}
                >
                  {committing ? '⟳ Committing…' : '⚡ Commit a GitHub'}
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
                    fontSize: 11, fontWeight: 700, padding: '8px 12px', textAlign: 'center',
                    letterSpacing: '0.04em', textDecoration: 'none',
                  }}
                >
                  ✅ Commit {shortSha}
                </a>
              )}
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{
        display: 'flex', gap: 8, padding: '8px 12px',
        borderTop: '1px solid #1e1e3f', flexShrink: 0, background: '#0d0d1a',
      }}>
        <textarea
          className="quark-input"
          rows={1}
          style={{
            flex: 1, minWidth: 0, fontSize: 12,
            resize: 'none', overflowY: 'hidden',
            minHeight: 36, maxHeight: 120,
            lineHeight: '1.5', paddingTop: 8, paddingBottom: 8,
            boxSizing: 'border-box',
          }}
          placeholder="Describe lo que quieres generar..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = 'auto';
            el.style.height = Math.min(el.scrollHeight, 120) + 'px';
            el.style.overflowY = el.scrollHeight > 120 ? 'auto' : 'hidden';
          }}
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
  );
}
