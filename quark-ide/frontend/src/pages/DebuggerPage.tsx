import { useState } from 'react';

const API_BASE = (import.meta.env.VITE_API_URL ?? window.location.origin).replace(/\/$/, '');

interface DebugResult {
  hasError: boolean;
  errorMessage?: string;
  affectedFile?: string;
  fixed?: boolean;
  commitMessage?: string;
  fix?: string;
  rawAnalysis?: string;
  error?: string;
}

type Status = 'idle' | 'analyzing' | 'fixing' | 'done' | 'error';

export default function DebuggerPage() {
  const [projectId, setProjectId] = useState(
    import.meta.env.VITE_RAILWAY_PROJECT_ID ?? '',
  );
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<DebugResult | null>(null);

  async function runDebugger() {
    if (!projectId.trim()) return;
    setStatus('analyzing');
    setResult(null);

    try {
      const res = await fetch(`${API_BASE}/debugger/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: projectId.trim() }),
      });

      const data = (await res.json()) as DebugResult;

      if (!res.ok) {
        setStatus('error');
        setResult(data);
        return;
      }

      if (data.hasError && !data.fixed) {
        setStatus('fixing');
        setResult(data);
      } else {
        setStatus('done');
        setResult(data);
      }
    } catch (err) {
      setStatus('error');
      setResult({ hasError: true, error: err instanceof Error ? err.message : String(err) });
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
      }}>
        <span style={{
          color: '#00ff88',
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: '0.1em',
          textShadow: '0 0 8px rgba(0,255,136,0.4)',
        }}>
          🤖 QUARK DEBUGGER
        </span>
        <span style={{ color: '#3a3a5c', fontSize: 11, marginLeft: 12 }}>
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
        {/* Project ID input */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ color: '#6b7280', fontSize: 11, letterSpacing: '0.08em' }}>
            RAILWAY PROJECT ID
          </label>
          <input
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            style={{
              background: '#0d0d1a',
              border: '1px solid #1e1e3f',
              borderRadius: 6,
              color: '#00ff88',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 13,
              padding: '10px 14px',
              outline: 'none',
              width: '100%',
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = '#00ff88'; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = '#1e1e3f'; }}
          />
        </div>

        {/* Run button */}
        <button
          onClick={runDebugger}
          disabled={!projectId.trim() || status === 'analyzing' || status === 'fixing'}
          style={{
            background: (status === 'analyzing' || status === 'fixing') ? '#1e1e3f' : '#00ff88',
            color: (status === 'analyzing' || status === 'fixing') ? '#3a3a5c' : '#08080f',
            border: 'none',
            borderRadius: 8,
            padding: '12px 24px',
            fontFamily: 'JetBrains Mono, monospace',
            fontWeight: 700,
            fontSize: 14,
            cursor: (status === 'analyzing' || status === 'fixing') ? 'not-allowed' : 'pointer',
            letterSpacing: '0.06em',
            alignSelf: 'flex-start',
            transition: 'all 0.15s ease',
          }}
        >
          🤖 RUN DEBUGGER
        </button>

        {/* Status banner */}
        {status === 'analyzing' && (
          <StatusBanner color="#00ff88" text="⟳ Analizando logs de Railway..." />
        )}
        {status === 'fixing' && (
          <StatusBanner color="#f59e0b" text="🔴 Error detectado — aplicando fix..." />
        )}
        {status === 'done' && result && !result.hasError && (
          <StatusBanner color="#00ff88" text="✅ Sin errores detectados" />
        )}
        {status === 'done' && result?.fixed && (
          <StatusBanner color="#00ff88" text={`✅ Fix aplicado — commit realizado: ${result.commitMessage ?? ''}`} />
        )}
        {status === 'error' && (
          <StatusBanner color="#ff4444" text={`❌ ${result?.error ?? 'Error desconocido'}`} />
        )}

        {/* Result JSON */}
        {result && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ color: '#3a3a5c', fontSize: 11, letterSpacing: '0.08em' }}>
              RESPUESTA
            </span>
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
