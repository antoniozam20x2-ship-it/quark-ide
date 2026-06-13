import { useState } from 'react';
import QuarkMarkdown from '../shared/QuarkMarkdown';

const API_BASE = import.meta.env.VITE_API_URL ?? '';

type Mode = 'Quick Analysis' | 'Full Architecture' | 'MVP Plan';
const MODES: Mode[] = ['Quick Analysis', 'Full Architecture', 'MVP Plan'];

const SECTION_ICONS: Record<string, string> = {
  'Project Overview': '📋',
  'Recommended Architecture': '🏗',
  'Database Design': '🗄',
  'UI/UX Recommendations': '🎨',
  'Development Phases': '📅',
  'Potential Challenges': '⚠',
};

function parseSections(text: string) {
  const sections: { title: string; content: string }[] = [];
  const lines = text.split('\n');
  let current: { title: string; content: string } | null = null;

  for (const line of lines) {
    const match = line.match(/^##\s+(.+)/);
    if (match) {
      if (current) sections.push(current);
      current = { title: match[1].trim(), content: '' };
    } else if (current) {
      current.content += line + '\n';
    }
  }
  if (current) sections.push(current);
  return sections;
}

export default function WarRoomPanel() {
  const [idea, setIdea] = useState('');
  const [includeTechStack, setIncludeTechStack] = useState(true);
  const [includeDatabase, setIncludeDatabase] = useState(false);
  const [includeUX, setIncludeUX] = useState(true);
  const [mode, setMode] = useState<Mode>('MVP Plan');
  const [loading, setLoading] = useState(false);
  const [sections, setSections] = useState<{ title: string; content: string }[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [rawResult, setRawResult] = useState('');

  async function deepThink() {
    if (!idea.trim() || loading) return;
    setLoading(true);
    setSections([]);
    setRawResult('');
    try {
      const res = await fetch(`${API_BASE}/api/warroom/think`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idea: idea.trim(),
          options: { includeTechStack, includeDatabase, includeUX, mode },
        }),
      });
      const data = await res.json();
      const result: string = data.result ?? data.error ?? '';
      setRawResult(result);
      setSections(parseSections(result));
    } catch {
      setSections([{ title: 'Error', content: '⚠ Connection error. Is the backend running?' }]);
    } finally {
      setLoading(false);
    }
  }

  function toggleSection(title: string) {
    setCollapsed((prev) => ({ ...prev, [title]: !prev[title] }));
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%' }}>
      {/* Input */}
      <div style={{ background: '#0d0d1a', border: '1px solid #1e1e3f', borderRadius: 6, padding: 16 }}>
        <textarea
          className="quark-textarea"
          placeholder="Describe your project idea..."
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          disabled={loading}
          style={{ minHeight: 120 }}
        />

        {/* Options */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16, marginTop: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: '#e2e8f0', fontSize: 12 }}>
            <input type="checkbox" checked={includeTechStack} onChange={(e) => setIncludeTechStack(e.target.checked)}
              style={{ accentColor: '#00ff88' }} />
            Tech stack recommendations
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: '#e2e8f0', fontSize: 12 }}>
            <input type="checkbox" checked={includeDatabase} onChange={(e) => setIncludeDatabase(e.target.checked)}
              style={{ accentColor: '#00ff88' }} />
            Database design
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: '#e2e8f0', fontSize: 12 }}>
            <input type="checkbox" checked={includeUX} onChange={(e) => setIncludeUX(e.target.checked)}
              style={{ accentColor: '#00ff88' }} />
            UI/UX recommendations
          </label>

          <div style={{ display: 'flex', gap: 4 }}>
            {MODES.map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                style={{
                  background: mode === m ? 'rgba(0,255,136,0.1)' : 'transparent',
                  border: `1px solid ${mode === m ? '#00ff88' : '#1e1e3f'}`,
                  color: mode === m ? '#00ff88' : '#6b7280',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 11,
                  padding: '3px 10px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                }}
              >
                {m}
              </button>
            ))}
          </div>

          <div style={{ flex: 1 }} />
          <button className="quark-btn-primary" onClick={deepThink} disabled={loading || !idea.trim()}>
            {loading ? '⚛ THINKING...' : 'DEEP THINK ⚛'}
          </button>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: 32 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="particle"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: '#00ff88',
                  animationDelay: `${i * 0.3}s`,
                  boxShadow: '0 0 8px rgba(0,255,136,0.6)',
                }}
              />
            ))}
          </div>
          <span style={{ color: '#6b7280', fontSize: 13 }}>
            ⚛ QUARK is thinking<span className="thinking-dots" />
          </span>
        </div>
      )}

      {/* Results */}
      {sections.length > 0 && !loading && (
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sections.map((sec) => {
            const icon = SECTION_ICONS[sec.title] ?? '📌';
            const isCollapsed = collapsed[sec.title];
            return (
              <div key={sec.title} style={{ background: '#0d0d1a', border: '1px solid #1e1e3f', borderRadius: 6, overflow: 'hidden' }}>
                <button
                  onClick={() => toggleSection(sec.title)}
                  style={{
                    width: '100%',
                    background: '#111127',
                    border: 'none',
                    borderBottom: isCollapsed ? 'none' : '1px solid #1e1e3f',
                    padding: '10px 14px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    cursor: 'pointer',
                    fontFamily: 'JetBrains Mono, monospace',
                  }}
                >
                  <span style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 700 }}>
                    {icon} {sec.title}
                  </span>
                  <span style={{ color: '#6b7280', fontSize: 12 }}>{isCollapsed ? '▶' : '▼'}</span>
                </button>
                {!isCollapsed && (
                  <div style={{ padding: '12px 14px' }}>
                    <QuarkMarkdown>{sec.content}</QuarkMarkdown>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
