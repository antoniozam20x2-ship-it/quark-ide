import { useState, useRef, useEffect } from 'react';
import type { Project } from '../../App';

const API_BASE = (import.meta.env.VITE_API_URL ?? window.location.origin).replace(/\/$/, '');

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

interface Props {
  activeProject: Project;
  onApplyToEditor: (code: string) => void;
  onShowPreview: () => void;
}

function cleanCodeForPreview(code: string): string {
  return code
    .split('\n')
    .filter((line) => !line.trim().startsWith('import'))
    .join('\n')
    .replace(/:\s*(string|number|boolean|null|undefined|void|any|React\.FC|FC|React\.ReactNode|ReactNode)(\s*[,)\{=])/g, '$2')
    .replace(/\(([^)]*)\):\s*\w+/g, '($1)')
    .replace(/<(string|number|boolean|null|any)>/g, '')
    .replace(/:\s*React\.FC\s*=/g, '=')
    .replace(/:\s*FC\s*=/g, '=')
    .replace(/export default /g, '')
    .replace(/export const /g, 'const ')
    .replace(/^(interface|type)\s+\w+[^{]*\{[^}]*\}/gm, '');
}

export default function QuarkAgent({ activeProject, onApplyToEditor, onShowPreview }: Props) {
  const [prompt, setPrompt]         = useState('');
  const [running, setRunning]       = useState(false);
  const [feed, setFeed]             = useState<AgentEvent[]>([]);
  const [result, setResult]         = useState<AgentEvent | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitSha, setCommitSha]   = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [feed, result]);

  async function generate() {
    if (!prompt.trim() || running) return;
    setRunning(true);
    setFeed([]);
    setResult(null);
    setCommitSha('');

    try {
      const res = await fetch(`${API_BASE}/agent/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt:      prompt.trim(),
          repo:        activeProject.repo,
          branch:      activeProject.branch,
          projectName: activeProject.name,
        }),
      });

      const reader  = res.body!.getReader();
      const decoder = new TextDecoder();
      // Buffer acumula entre reads — evita que eventos grandes (done ~10KB)
      // queden partidos entre chunks y fallen el JSON.parse
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Partir por \n\n: cada bloque es un evento SSE completo
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? ''; // el último puede estar incompleto

        for (const block of blocks) {
          for (const line of block.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              const parsed = JSON.parse(line.slice(6)) as AgentEvent;
              console.log('[Agent] Event:', parsed.event);
              setFeed((prev) => [...prev, parsed]);
              if (parsed.event === 'done') {
                console.log('[Agent] Done — files:', parsed.files?.length, 'mainContent:', parsed.mainContent?.length);
                setResult(parsed);
                setRunning(false);
              }
              if (parsed.event === 'error') {
                setRunning(false);
              }
            } catch (e) {
              console.warn('[Agent] Parse error on line:', line.slice(0, 100), e);
            }
          }
        }
      }
    } catch (err) {
      setFeed((prev) => [...prev, { event: 'error', text: err instanceof Error ? err.message : String(err) }]);
    } finally {
      setRunning(false);
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
          repo:    result.repo,
          branch:  result.branch,
        }),
      });
      const data = await res.json() as { sha?: string; error?: string };
      if (data.sha) setCommitSha(data.sha.slice(0, 7));
      else throw new Error(data.error ?? 'Commit failed');
    } catch (err) {
      setFeed((prev) => [...prev, { event: 'error', text: err instanceof Error ? err.message : String(err) }]);
    } finally {
      setCommitting(false);
    }
  }

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

        {/* Result actions — aparecen cuando result está seteado y running es false */}
        {result && !running && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            <div style={{
              background: 'rgba(0,255,136,0.06)', border: '1px solid #1e3f2a',
              borderRadius: 6, padding: '8px 12px',
              color: '#00ff88', fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
            }}>
              ✅ {result.files?.length} archivos listos · {result.commitMessage}
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              {result.mainContent && (
                <button
                  onClick={() => {
                    onApplyToEditor(cleanCodeForPreview(result.mainContent!));
                    onShowPreview();
                  }}
                  style={{
                    flex: 1, background: 'rgba(0,255,136,0.1)', border: '1px solid #1e3f2a',
                    borderRadius: 6, color: '#00ff88', fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 11, fontWeight: 700, padding: '8px 12px', cursor: 'pointer',
                    letterSpacing: '0.04em', transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(0,255,136,0.18)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(0,255,136,0.1)')}
                >
                  ▶️ Ver Preview
                </button>
              )}

              {!commitSha ? (
                <button
                  onClick={commitToGitHub}
                  disabled={committing}
                  style={{
                    flex: 1,
                    background: committing ? '#1e1e3f' : 'rgba(124,58,237,0.12)',
                    border: `1px solid ${committing ? '#1e1e3f' : '#4c1d95'}`,
                    borderRadius: 6,
                    color: committing ? '#3a3a5c' : '#a78bfa',
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
                <div style={{
                  flex: 1, background: 'rgba(124,58,237,0.12)', border: '1px solid #4c1d95',
                  borderRadius: 6, color: '#a78bfa', fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 11, fontWeight: 700, padding: '8px 12px', textAlign: 'center',
                  letterSpacing: '0.04em',
                }}>
                  ✅ Commit {commitSha}
                </div>
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
        <input
          className="quark-input"
          style={{ flex: 1, height: 36, minWidth: 0, fontSize: 12 }}
          placeholder="Describe lo que quieres generar..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && generate()}
          disabled={running}
        />
        <button
          className="quark-btn-primary"
          onClick={generate}
          disabled={running || !prompt.trim()}
          style={{ flexShrink: 0, fontSize: 11 }}
        >
          {running ? '⟳' : '⚡ GEN'}
        </button>
      </div>
    </div>
  );
}
