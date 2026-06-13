import { useState } from 'react';
import QuarkMarkdown from '../shared/QuarkMarkdown';

const API_BASE = (import.meta.env.VITE_API_URL ?? window.location.origin).replace(/\/$/, '');

interface SearchResult {
  query: string;
  result: string;
  timestamp: string;
}

const PLACEHOLDER_SEARCHES = [
  'Railway deployment Node.js',
  'Gemini API rate limits',
];

export default function DeepSearch() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<SearchResult[]>([]);
  const [activeResult, setActiveResult] = useState<SearchResult | null>(null);

  async function doSearch(q?: string) {
    const searchQuery = (q ?? query).trim();
    if (!searchQuery || loading) return;
    setLoading(true);
    setQuery('');
    try {
      const res = await fetch(`${API_BASE}/api/warroom/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery }),
      });
      const data = await res.json();
      const result: SearchResult = {
        query: searchQuery,
        result: data.result ?? data.error ?? 'No result.',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setHistory((prev) => [result, ...prev.filter((h) => h.query !== searchQuery)]);
      setActiveResult(result);
    } catch {
      setActiveResult({ query: searchQuery, result: '⚠ Connection error. Is the backend running?', timestamp: '' });
    } finally {
      setLoading(false);
    }
  }

  const recentList = history.length > 0 ? history : null;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 0,
      height: '100%',
      minHeight: 0,
      width: '100%',
    }}>

      {/* ── Row 1: Search input + button ── */}
      <div style={{
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        width: '100%',
        marginBottom: 12,
      }}>
        <span style={{ color: '#6b7280', fontSize: 16, flexShrink: 0 }}>🔦</span>
        <input
          className="quark-input"
          style={{ flex: 1, minWidth: 0 }}
          placeholder="Search anything..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && doSearch()}
          disabled={loading}
        />
        <button
          className="quark-btn-primary"
          onClick={() => doSearch()}
          disabled={loading || !query.trim()}
          style={{ flexShrink: 0 }}
        >
          {loading ? '...' : 'SEARCH'}
        </button>
      </div>

      {/* ── Row 2: Recent searches list (full width) ── */}
      {(recentList || !activeResult) && (
        <div style={{
          borderTop: '1px solid #1e1e3f',
          borderBottom: '1px solid #1e1e3f',
          padding: '10px 0',
          marginBottom: 12,
          width: '100%',
        }}>
          <p style={{
            color: '#6b7280',
            fontSize: 11,
            margin: '0 0 6px',
            letterSpacing: '0.08em',
            fontWeight: 700,
          }}>
            RECENT SEARCHES
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {(recentList ?? PLACEHOLDER_SEARCHES.map((s) => ({ query: s, result: '', timestamp: '' }))).map((h, i) => (
              <button
                key={i}
                onClick={() => {
                  if ('result' in h && h.result) {
                    setActiveResult(h as SearchResult);
                  } else {
                    setQuery(h.query);
                  }
                }}
                style={{
                  background: activeResult?.query === h.query ? 'rgba(0,255,136,0.06)' : 'transparent',
                  border: 'none',
                  borderLeft: `2px solid ${activeResult?.query === h.query ? '#00ff88' : 'transparent'}`,
                  padding: '5px 10px',
                  cursor: 'pointer',
                  textAlign: 'left',
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: 8,
                  width: '100%',
                  borderRadius: 0,
                  transition: 'all 0.12s',
                }}
              >
                <span style={{
                  color: activeResult?.query === h.query ? '#00ff88' : '#e2e8f0',
                  fontSize: 12,
                  fontFamily: 'JetBrains Mono, monospace',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  minWidth: 0,
                }}>
                  · {h.query}
                </span>
                {'timestamp' in h && h.timestamp && (
                  <span style={{ color: '#3a3a5c', fontSize: 10, flexShrink: 0 }}>{h.timestamp}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Loading state ── */}
      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 0' }}>
          <span className="pulse-neon" style={{ color: '#00ff88', fontSize: 18 }}>⚛</span>
          <span style={{ color: '#6b7280', fontSize: 13 }}>
            QUARK is searching<span className="thinking-dots" />
          </span>
        </div>
      )}

      {/* ── Row 3: Full-width result card ── */}
      {activeResult && !loading && (
        <div style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          background: '#0d0d1a',
          border: '1px solid #1e1e3f',
          borderRadius: 6,
          padding: 16,
          width: '100%',
          boxSizing: 'border-box',
        }}>
          <p style={{
            color: '#00ff88',
            fontSize: 11,
            fontWeight: 700,
            margin: '0 0 14px',
            letterSpacing: '0.08em',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}>
            <span>🔦</span>
            <span style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {activeResult.query}
            </span>
            {activeResult.timestamp && (
              <span style={{ color: '#3a3a5c', fontWeight: 400, marginLeft: 'auto', flexShrink: 0 }}>
                {activeResult.timestamp}
              </span>
            )}
          </p>
          <div style={{ width: '100%', overflowX: 'hidden' }}>
            <QuarkMarkdown fontSize={14}>{activeResult.result}</QuarkMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}
