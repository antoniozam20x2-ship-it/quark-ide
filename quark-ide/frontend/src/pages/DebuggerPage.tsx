import { useState } from 'react';

const API_BASE = (import.meta.env.VITE_API_URL ?? window.location.origin).replace(/\/$/, '');

interface DebugResult {
  fixed?: boolean;
  attempts?: number;
  lastError?: string;
  commits?: string[];
  error?: string;
}

type Status = 'idle' | 'analyzing' | 'done' | 'error';

interface Props {
  railwayProjectId: string;
  projectName: string;
  repo: string;
}

export default function DebuggerPage({ railwayProjectId, projectName, repo }: Props) {
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<DebugResult | null>(null);

  async function runDebugger() {
    if (!railwayProjectId) return;
    setStatus('analyzing');
    setResult(null);

    try {
      const res = await fetch(`${API_BASE}/debugger/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: railwayProjectId, projectName, repo }),
      });

      const data = (await res.json()) as DebugResult;

      if (!res.ok) {
        setStatus('error');
        setResult(data);
        return;
      }

      setStatus(data.error ? 'error' : 'done');
      setResult(data);
    } catch (err) {
      setStatus('error');
      setResult({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: '#08080f',
      color: '#e2e8f0',
      fontFamily: 'JetBrains Mono, monospace',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '14px 24px',
        borderBottom: '1px solid #1e1e3f',
        background: '#0d0d1a',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}>
        <span style={{
          color: '#00ff88',
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: '0.1em',
          textShadow: '0 0 8px rgba(0,255,136,0.4)',
        }}>
          🔧 DEBUGGER — {projectName}
        </span>
        <span style={{ color: '#3a3a5c', fontSize: 11 }}>
          Railway logs → AI analysis → auto-fix
        </span>
      </div>

      {/* Body */}
      <div style={{
        flex: 1,
        overflow: 'auto',
        padding: '28px 32px',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
        maxWidth: 800,
        width: '100%',
        alignSelf: 'center',
      }}>
        {/* Project info */}
        <div style={{
          background: '#0d0d1a',
          border: '1px solid #1e1e3f',
          borderRadius: 6,
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}>
          <span style={{ color: '#3a3a5c', fontSize: 11, letterSpacing: '0.08em' }}>PROJECT ID</span>
          <span style={{ color: '#00ff88', fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {railwayProjectId}
          </span>
        </div>

        {/* Run button */}
        <button
          onClick={runDebugger}
          disabled={!railwayProjectId || status === 'analyzing'}
          style={{
            background: status === 'analyzing' ? '#1e1e3f' : '#00ff88',
            color: status === 'analyzing' ? '#3a3a5c' : '#08080f',
            border: 'none',
            borderRadius: 8,
            padding: '12px 24px',
            fontFamily: 'JetBrains Mono, monospace',
            fontWeight: 700,
            fontSize: 14,
            cursor: status === 'analyzing' ? 'not-allowed' : 'pointer',
            letterSpacing: '0.06em',
            alignSelf: 'flex-start',
            transition: 'all 0.15s ease',
          }}
        >
          {status === 'analyzing' ? '⟳ ANALIZANDO…' : '🤖 RUN DEBUGGER'}
        </button>

        {/* Status banners */}
        {status === 'analyzing' && (
          <StatusBanner color="#00ff88" text="⟳ Analizando logs de Railway..." />
        )}
        {status === 'done' && result?.fixed === true && (
          <StatusBanner color="#00ff88" text={`✅ Fix aplicado en ${result.attempts} intento${result.attempts === 1 ? '' : 's'}`} />
        )}
        {status === 'done' && result?.fixed === false && (
          <StatusBanner color="#f59e0b" text={`⚠ No se pudo resolver después de ${result.attempts} intentos`} />
        )}
        {status === 'error' && (
          <StatusBanner color="#ff4444" text={`❌ ${result?.error ?? 'Error desconocido'}`} />
        )}

        {/* Commits list */}
        {result?.commits && result.commits.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ color: '#3a3a5c', fontSize: 11, letterSpacing: '0.08em' }}>COMMITS</span>
            {result.commits.map((c, i) => (
              <div key={i} style={{
                background: '#0d0d1a',
                border: '1px solid #1e1e3f',
                borderLeft: '2px solid #00ff88',
                borderRadius: 4,
                padding: '6px 12px',
                color: '#a0aec0',
                fontSize: 11,
              }}>
                {c}
              </div>
            ))}
          </div>
        )}

        {/* Result JSON */}
        {result && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ color: '#3a3a5c', fontSize: 11, letterSpacing: '0.08em' }}>RESPUESTA</span>
            <pre style={{
              background: '#000',
              border: '1px solid #1e1e3f',
              borderRadius: 8,
              padding: '16px 20px',
              color: '#00ff88',
              fontSize: 12,
              lineHeight: 1.7,
              overflowX: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              margin: 0,
              textShadow: '0 0 6px rgba(0,255,136,0.3)',
            }}>
              {JSON.stringify(result, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBanner({ color, text }: { color: string; text: string }) {
  return (
    <div style={{
      background: `${color}12`,
      border: `1px solid ${color}44`,
      borderRadius: 6,
      padding: '10px 16px',
      color,
      fontSize: 12,
      letterSpacing: '0.04em',
    }}>
      {text}
    </div>
  );
}
