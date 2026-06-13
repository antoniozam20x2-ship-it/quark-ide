import { useState, useRef, useEffect } from 'react';

const API_BASE = (import.meta.env.VITE_API_URL ?? window.location.origin).replace(/\/$/, '');

type Status = 'idle' | 'open' | 'committing' | 'done' | 'error';

interface Props {
  code: string;
}

export default function GitHubApplyButton({ code }: Props) {
  const [status, setStatus] = useState<Status>('idle');
  const [path, setPath] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (status === 'open') {
      setTimeout(() => inputRef.current?.focus(), 40);
    }
  }, [status]);

  function reset() {
    setStatus('idle');
    setErrorMsg('');
  }

  async function commit() {
    const trimmed = path.trim();
    if (!trimmed) {
      inputRef.current?.focus();
      return;
    }
    setStatus('committing');
    const message = `AI: update ${trimmed}`;
    try {
      const res = await fetch(`${API_BASE}/github/file`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: trimmed, content: code, message }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setStatus('done');
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(reset, 3500);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
      setStatus('error');
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(reset, 4000);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') reset();
  }

  const baseBtn: React.CSSProperties = {
    background: 'rgba(0,255,136,0.07)',
    border: '1px solid #1e3f2a',
    borderRadius: 4,
    color: '#00ff88',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 10,
    fontWeight: 700,
    padding: '2px 8px',
    cursor: 'pointer',
    letterSpacing: '0.04em',
    whiteSpace: 'nowrap',
    transition: 'background 0.15s',
    flexShrink: 0,
  };

  if (status === 'idle') {
    return (
      <button style={baseBtn} onClick={() => setStatus('open')} title="Write this code to GitHub">
        ⚡ Apply
      </button>
    );
  }

  if (status === 'committing') {
    return (
      <span style={{ fontSize: 10, color: '#00ff88', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
        ⟳ Applying…
      </span>
    );
  }

  if (status === 'done') {
    return (
      <span style={{ fontSize: 10, color: '#00ff88', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
        ✅ Committed!
      </span>
    );
  }

  if (status === 'error') {
    return (
      <span
        style={{ fontSize: 10, color: '#ff4444', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap', cursor: 'pointer' }}
        onClick={reset}
        title={errorMsg}
      >
        ❌ Error
      </span>
    );
  }

  // status === 'open'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
      <input
        ref={inputRef}
        value={path}
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="path/to/file.ts"
        style={{
          background: '#08080f',
          border: '1px solid #00ff88',
          borderRadius: 4,
          color: '#e2e8f0',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 10,
          padding: '2px 7px',
          outline: 'none',
          width: 160,
          minWidth: 0,
        }}
      />
      <button
        style={baseBtn}
        onClick={commit}
        disabled={!path.trim()}
        title={`Commit to: ${path || '(enter path)'}\nMessage: AI: update ${path || '<path>'}`}
      >
        ⚡ Commit
      </button>
      <button
        style={{ ...baseBtn, background: 'transparent', color: '#6b7280', borderColor: '#1e1e3f' }}
        onClick={reset}
        title="Cancel"
      >
        ✕
      </button>
    </div>
  );
}
