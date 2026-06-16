import { useState, useEffect, useRef } from 'react';

const LANGUAGES = ['typescript', 'javascript', 'python', 'html', 'css', 'json', 'markdown'];
const API_BASE = (import.meta.env.VITE_API_URL ?? window.location.origin).replace(/\/$/, '');

interface Props {
  fileName: string;
  language: string;
  onLanguageChange: (lang: string) => void;
  onRun: () => void;
  onPreview: () => void;
  previewOpen: boolean;
}

interface CostSummary {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUSD: number;
}

interface APICall {
  timestamp: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUSD: number;
  endpoint: string;
}

interface CostData {
  today: CostSummary;
  total: CostSummary;
  session: CostSummary;
  history: APICall[];
}

export default function TopBar({ fileName, language, onLanguageChange, onRun, onPreview, previewOpen }: Props) {
  const [costData, setCostData] = useState<CostData | null>(null);
  const [showCostModal, setShowCostModal] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  async function fetchCosts() {
    try {
      const res = await fetch(`${API_BASE}/api/costs`);
      if (res.ok) setCostData(await res.json());
    } catch {}
  }

  useEffect(() => {
    fetchCosts();
    intervalRef.current = setInterval(fetchCosts, 30_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        setShowCostModal(false);
      }
    }
    if (showCostModal) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showCostModal]);

  function fmt(n: number) {
    return `$${n.toFixed(4)}`;
  }

  function fmtK(n: number) {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }

  const todayCost = costData?.today.costUSD ?? 0;

  return (
    <div
      className="flex items-center gap-3 px-4"
      style={{ height: 40, background: '#0d0d1a', borderBottom: '1px solid #1e1e3f', flexShrink: 0, position: 'relative' }}
    >
      {/* Logo */}
      <div className="flex flex-col mr-2">
        <span style={{
          color: '#00ff88', fontFamily: 'JetBrains Mono, monospace',
          fontWeight: 700, fontSize: 14, textShadow: '0 0 8px rgba(0,255,136,0.4)',
          letterSpacing: '0.05em',
        }}>
          ⚛ QUARK
        </span>
      </div>

      <div style={{ width: 1, height: 20, background: '#1e1e3f' }} />

      {/* Filename */}
      <span style={{ color: '#e2e8f0', fontSize: 13, fontFamily: 'JetBrains Mono, monospace' }}>
        {fileName}
      </span>

      <div className="flex-1" />

      {/* Cost Indicator */}
      <button
        onClick={() => { setShowCostModal(true); fetchCosts(); }}
        title="API cost tracker — click for breakdown"
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: todayCost > 0.1 ? '#ffaa44' : '#3a3a5c',
          fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
          padding: '2px 6px', borderRadius: 4,
          transition: 'color 0.2s',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = '#00ff88')}
        onMouseLeave={(e) => (e.currentTarget.style.color = todayCost > 0.1 ? '#ffaa44' : '#3a3a5c')}
      >
        ⚛ {fmt(todayCost)}
      </button>

      {/* Language Selector */}
      <select
        value={language}
        onChange={(e) => onLanguageChange(e.target.value)}
        style={{
          background: '#111127', border: '1px solid #1e1e3f', color: '#e2e8f0',
          fontFamily: 'JetBrains Mono, monospace', fontSize: 12,
          padding: '3px 8px', borderRadius: 4, cursor: 'pointer', outline: 'none',
        }}
      >
        {LANGUAGES.map((l) => (
          <option key={l} value={l}>{l}</option>
        ))}
      </select>

      {/* Preview Button */}
      <button
        onClick={onPreview}
        style={{
          background: previewOpen ? 'rgba(0,255,136,0.12)' : 'rgba(0,255,136,0.07)',
          border: `1px solid ${previewOpen ? '#00ff88' : '#1e3f2a'}`,
          borderRadius: 4,
          color: '#00ff88',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11,
          fontWeight: 700,
          padding: '3px 10px',
          cursor: 'pointer',
          letterSpacing: '0.04em',
          transition: 'all 0.15s',
        }}
      >
        {previewOpen ? '✕ Preview' : '▶ Preview'}
      </button>

      {/* Run Button */}
      <button className="quark-btn-primary" onClick={onRun} style={{ fontSize: 11 }}>
        ▶ RUN
      </button>

      {/* Cost Modal */}
      {showCostModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end',
          paddingTop: 48, paddingRight: 16,
        }}>
          <div
            ref={modalRef}
            style={{
              background: '#0d0d1a', border: '1px solid #1e3f2a',
              borderRadius: 8, width: 480, maxHeight: '80vh',
              overflow: 'hidden', display: 'flex', flexDirection: 'column',
              boxShadow: '0 0 40px rgba(0,255,136,0.12)',
            }}
          >
            {/* Modal header */}
            <div style={{
              padding: '12px 16px', borderBottom: '1px solid #1e1e3f',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <span style={{ color: '#00ff88', fontFamily: 'JetBrains Mono, monospace', fontSize: 13, fontWeight: 700 }}>
                ⚛ API Cost Tracker
              </span>
              <button
                onClick={() => setShowCostModal(false)}
                style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 16 }}
              >
                ✕
              </button>
            </div>

            {/* Summary cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1, background: '#1e1e3f' }}>
              {[
                { label: 'Today', data: costData?.today },
                { label: 'Session', data: costData?.session },
                { label: 'Total', data: costData?.total },
              ].map(({ label, data }) => (
                <div key={label} style={{ background: '#0d0d1a', padding: '12px 14px' }}>
                  <div style={{ color: '#6b7280', fontSize: 10, fontFamily: 'JetBrains Mono, monospace', marginBottom: 4 }}>{label.toUpperCase()}</div>
                  <div style={{ color: '#00ff88', fontSize: 18, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}>
                    {fmt(data?.costUSD ?? 0)}
                  </div>
                  <div style={{ color: '#3a3a5c', fontSize: 10, fontFamily: 'JetBrains Mono, monospace', marginTop: 3 }}>
                    {data?.calls ?? 0} calls · {fmtK(data?.tokensIn ?? 0)} in · {fmtK(data?.tokensOut ?? 0)} out
                  </div>
                </div>
              ))}
            </div>

            {/* History table */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '12px 0' }}>
              <div style={{ padding: '0 16px 8px', color: '#6b7280', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}>
                RECENT CALLS
              </div>
              {(!costData?.history || costData.history.length === 0) && (
                <div style={{ padding: '8px 16px', color: '#3a3a5c', fontSize: 12, fontFamily: 'JetBrains Mono, monospace' }}>
                  No API calls yet this session.
                </div>
              )}
              {costData?.history.map((call, i) => (
                <div
                  key={i}
                  style={{
                    display: 'grid', gridTemplateColumns: '1fr auto auto',
                    gap: 8, padding: '6px 16px', alignItems: 'center',
                    borderBottom: '1px solid rgba(30,30,63,0.5)',
                  }}
                >
                  <div>
                    <div style={{ color: '#a0a0c0', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}>
                      {call.endpoint}
                    </div>
                    <div style={{ color: '#3a3a5c', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}>
                      {new Date(call.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      {' · '}{fmtK(call.tokensIn)}↑ {fmtK(call.tokensOut)}↓
                    </div>
                  </div>
                  <div style={{ color: '#00ff88', fontSize: 11, fontFamily: 'JetBrains Mono, monospace', textAlign: 'right' }}>
                    {fmt(call.costUSD)}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ padding: '8px 16px', borderTop: '1px solid #1e1e3f' }}>
              <span style={{ color: '#3a3a5c', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}>
                Model: gemini-1.5-flash · Pricing: $0.075/1M in · $0.30/1M out · Tokens estimated for streaming
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
