import { useEffect, useRef, useState } from 'react';

const API_BASE = (import.meta.env.VITE_API_URL ?? window.location.origin).replace(/\/$/, '');

interface ApiKeyStatus {
  name: string;
  status: 'ok' | 'rate_limited' | 'error' | 'not_configured';
  remaining?: number;
  reset?: string;
  resetAt?: number;
  balance?: string;
  latency?: number;
}

interface HealthResponse {
  results: ApiKeyStatus[];
  cachedAt: number;
  fromCache: boolean;
}

function fmtCountdown(resetAt: number): string {
  const diff = Math.max(0, resetAt - Date.now());
  const s = Math.ceil(diff / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}:${String(rem).padStart(2, '0')}` : `0:${String(rem).padStart(2, '0')}`;
}

function fmtAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5)  return 'ahora mismo';
  if (diff < 60) return `hace ${diff}s`;
  return `hace ${Math.floor(diff / 60)}m`;
}

function StatusBadge({ status }: { status: ApiKeyStatus['status'] }) {
  const cfg = {
    ok:             { icon: '✅', label: 'OK',         color: '#00ff88' },
    rate_limited:   { icon: '⚠',  label: 'Rate limit', color: '#f59e0b' },
    error:          { icon: '❌', label: 'Error',       color: '#ff4444' },
    not_configured: { icon: '—',  label: 'No config',  color: '#3a3a5c' },
  }[status];

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      color: cfg.color,
      fontSize: 12,
      fontWeight: 600,
    }}>
      {cfg.icon} {cfg.label}
    </span>
  );
}

function CountdownTick({ resetAt }: { resetAt: number }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const val = fmtCountdown(resetAt);
  return <span style={{ color: '#f59e0b', fontVariantNumeric: 'tabular-nums' }}>⏱ {val}</span>;
}

function MetaCell({ item }: { item: ApiKeyStatus }) {
  const parts: React.ReactNode[] = [];

  if (item.remaining !== undefined) {
    parts.push(
      <span key="rem" style={{ color: item.remaining === 0 ? '#ff4444' : '#a0aec0' }}>
        {item.remaining.toLocaleString()} {item.name.startsWith('Anthropic') ? 'tok' : 'req'}
      </span>,
    );
  }

  if (item.balance) {
    parts.push(<span key="bal" style={{ color: '#00ff88' }}>{item.balance}</span>);
  }

  if (item.resetAt && item.resetAt > Date.now()) {
    parts.push(<CountdownTick key="cd" resetAt={item.resetAt} />);
  } else if (item.reset && !item.resetAt) {
    parts.push(<span key="rst" style={{ color: '#6b7280' }}>reset {item.reset}</span>);
  }

  if (item.status === 'ok' && item.name === 'Railway') {
    parts.push(<span key="rail" style={{ color: '#00ff88' }}>Token configurado</span>);
  }

  if (item.latency !== undefined) {
    parts.push(
      <span key="lat" style={{ color: '#3a3a5c', fontSize: 11 }}>{item.latency}ms</span>,
    );
  }

  if (parts.length === 0) {
    parts.push(<span key="dash" style={{ color: '#3a3a5c' }}>—</span>);
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      {parts.map((p, i) => (
        <span key={i}>{p}{i < parts.length - 1 && <span style={{ color: '#1e1e3f', margin: '0 2px' }}>·</span>}</span>
      ))}
    </div>
  );
}

function RowBorderColor(status: ApiKeyStatus['status']): string {
  return { ok: '#00ff88', rate_limited: '#f59e0b', error: '#ff4444', not_configured: '#1e1e3f' }[status];
}

export default function HealthPage() {
  const [data, setData]       = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [, setTick]           = useState(0);

  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetchHealth(false);
    tickRef.current = setInterval(() => setTick((n) => n + 1), 1000);
    return () => { if (tickRef.current) clearInterval(tickRef.current); };
  }, []);

  async function fetchHealth(forceRefresh: boolean) {
    setLoading(true);
    setError(null);
    try {
      const url = `${API_BASE}/api/health${forceRefresh ? '?refresh=true' : ''}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as HealthResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }

  const agoLabel = data ? fmtAgo(data.cachedAt) : '';

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
        gap: 16,
      }}>
        <span style={{
          color: '#00ff88',
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: '0.1em',
          textShadow: '0 0 8px rgba(0,255,136,0.4)',
        }}>
          🔑 API HEALTH MONITOR
        </span>

        {data && (
          <span style={{ color: '#3a3a5c', fontSize: 11 }}>
            {data.fromCache ? `Último check: ${agoLabel}` : `Actualizado ${agoLabel}`}
          </span>
        )}

        <div style={{ flex: 1 }} />

        <button
          onClick={() => fetchHealth(true)}
          disabled={loading}
          style={{
            background: loading ? '#1e1e3f' : 'transparent',
            color: loading ? '#3a3a5c' : '#00ff88',
            border: '1px solid',
            borderColor: loading ? '#1e1e3f' : '#00ff8844',
            borderRadius: 6,
            padding: '5px 14px',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12,
            cursor: loading ? 'not-allowed' : 'pointer',
            letterSpacing: '0.06em',
            transition: 'all 0.15s ease',
          }}
        >
          {loading ? '⟳ Checkeando…' : '↻ Refresh'}
        </button>
      </div>

      {/* Body */}
      <div style={{
        flex: 1,
        overflow: 'auto',
        padding: '24px 32px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        maxWidth: 860,
        width: '100%',
        alignSelf: 'center',
      }}>
        {error && (
          <div style={{
            background: '#ff444412',
            border: '1px solid #ff444444',
            borderRadius: 6,
            padding: '10px 16px',
            color: '#ff4444',
            fontSize: 12,
          }}>
            ❌ {error}
          </div>
        )}

        {loading && !data && (
          <div style={{ color: '#3a3a5c', fontSize: 12, textAlign: 'center', paddingTop: 40 }}>
            ⟳ Haciendo ping a todas las APIs…
          </div>
        )}

        {data && (
          <div style={{
            background: '#0d0d1a',
            border: '1px solid #1e1e3f',
            borderRadius: 8,
            overflow: 'hidden',
          }}>
            {/* Table header */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '180px 140px 1fr',
              padding: '8px 20px',
              borderBottom: '1px solid #1e1e3f',
              background: '#0a0a15',
            }}>
              {['API / KEY', 'ESTADO', 'DETALLES'].map((h) => (
                <span key={h} style={{ color: '#3a3a5c', fontSize: 10, letterSpacing: '0.1em' }}>{h}</span>
              ))}
            </div>

            {/* Rows */}
            {data.results.map((item, i) => (
              <div
                key={i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '180px 140px 1fr',
                  alignItems: 'center',
                  padding: '10px 20px',
                  borderBottom: i < data.results.length - 1 ? '1px solid #1e1e3f' : 'none',
                  borderLeft: `2px solid ${RowBorderColor(item.status)}`,
                  transition: 'background 0.1s ease',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#0a0a15')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <span style={{ color: '#e2e8f0', fontSize: 12, fontWeight: 600 }}>
                  {item.name}
                </span>
                <StatusBadge status={item.status} />
                <MetaCell item={item} />
              </div>
            ))}
          </div>
        )}

        {/* Legend */}
        <div style={{
          display: 'flex',
          gap: 20,
          marginTop: 4,
        }}>
          {[
            { color: '#00ff88', label: 'OK' },
            { color: '#f59e0b', label: 'Rate limited' },
            { color: '#ff4444', label: 'Error' },
            { color: '#3a3a5c', label: 'No configurado' },
          ].map(({ color, label }) => (
            <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: '#3a3a5c' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }} />
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
