import { useState, useRef, useEffect } from 'react';
import QuarkMarkdown from '../shared/QuarkMarkdown';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

interface Props {
  fileContent: string;
  fileName: string;
  onApplyToEditor: (code: string) => void;
  layout?: 'panel' | 'fullscreen';
}

const API_BASE = import.meta.env.VITE_API_URL ?? '';

const JEFFERSON_PROJECTS = [
  { label: 'Signal OS', prompt: 'Tell me about Signal OS — what areas of the trading bot logic can we improve next?' },
  { label: 'Snipe OS', prompt: 'Tell me about Snipe OS — what features should we focus on for the signal intelligence PWA?' },
  { label: 'NEXUS Capital', prompt: 'Tell me about NEXUS Capital — how can we improve the Snipe Radar and Smart Concept indicators?' },
  { label: 'CORE AI', prompt: 'Tell me about CORE AI — how should we architect the 6-agent trading council with Oracle verdict system?' },
  { label: 'QUARK IDE', prompt: 'Tell me about QUARK IDE — what features should we add next to this development superapp?' },
];

export default function ClaudeChat({
  fileContent,
  fileName,
  onApplyToEditor,
  layout = 'panel',
}: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  const [saving, setSaving] = useState(false);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const projectsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (projectsRef.current && !projectsRef.current.contains(e.target as Node)) {
        setShowProjects(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  function showToast(msg: string) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(''), 2500);
  }

  function applyCode(code: string) {
    console.log('[QUARK] Applying code to editor — length:', code.length, 'chars\n', code);
    onApplyToEditor(code);
    showToast('⚛ Applied to editor');
  }

  async function saveFile() {
    if (!fileContent || saving) return;
    setSaving(true);
    try {
      await fetch(`${API_BASE}/api/memory/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: fileName, content: fileContent, namespace: 'quark-ide' }),
      });
      showToast('⚛ Saved to QUARK Memory');
    } catch {
      showToast('⚠ Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function runSearch() {
    if (!searchQuery.trim() || searching) return;
    setSearching(true);
    try {
      const res = await fetch(`${API_BASE}/api/memory/search?q=${encodeURIComponent(searchQuery)}&ns=quark-ide`);
      const data = await res.json();
      setSearchResults(data.results ?? []);
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }

  function insertSearchResult(result: string) {
    setInput((prev) => (prev ? prev + '\n\n' + result : result));
    setShowSearch(false);
    setSearchResults([]);
    setSearchQuery('');
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function loadProject(prompt: string) {
    setInput(prompt);
    setShowProjects(false);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  async function sendMessage(overrideInput?: string) {
    const text = (overrideInput ?? input).trim();
    if (!text || loading) return;

    const userMsg: Message = {
      role: 'user',
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setLoading(true);

    const assistantMsg: Message = {
      role: 'assistant',
      content: '',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    setMessages([...newMessages, assistantMsg]);

    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages.map((m) => ({ role: m.role, content: m.content })),
          fileContent,
          fileName,
        }),
      });

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let assistantContent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') break;
          try {
            const parsed = JSON.parse(data);
            if (parsed.text) {
              assistantContent += parsed.text;
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = { ...assistantMsg, content: assistantContent };
                return updated;
              });
            }
          } catch {}
        }
      }
    } catch {
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          ...assistantMsg,
          content: '⚠ Connection error. Is the backend running?',
        };
        return updated;
      });
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  const isFullscreen = layout === 'fullscreen';

  const containerStyle: React.CSSProperties = isFullscreen
    ? { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, height: '100%', background: '#08080f', overflow: 'hidden', position: 'relative' }
    : { width: 320, flexShrink: 0, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: '#0d0d1a', borderLeft: '1px solid #1e1e3f', overflow: 'hidden', position: 'relative' };

  const btnStyle: React.CSSProperties = {
    background: 'rgba(0,255,136,0.07)',
    border: '1px solid #1e3f2a',
    borderRadius: 4,
    color: '#00ff88',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 10,
    fontWeight: 700,
    padding: '3px 8px',
    cursor: 'pointer',
    letterSpacing: '0.04em',
    whiteSpace: 'nowrap' as const,
    transition: 'background 0.15s',
  };

  return (
    <div style={containerStyle}>

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'absolute', bottom: 68, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(0,255,136,0.12)', border: '1px solid #00ff88', borderRadius: 6,
          padding: '6px 14px', color: '#00ff88', fontSize: 12, fontWeight: 700,
          fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap',
          zIndex: 100, pointerEvents: 'none', letterSpacing: '0.05em',
        }}>
          {toast}
        </div>
      )}

      {/* Header */}
      <div style={{
        padding: '8px 12px', borderBottom: '1px solid #1e1e3f',
        display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, background: '#0d0d1a',
      }}>
        <span style={{ color: '#00ff88', fontSize: 11, fontWeight: 700 }}>⚛ QUARK CHAT</span>
        <span style={{ color: '#6b7280', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          — {fileName}
        </span>
      </div>

      {/* Messages */}
      <div style={{
        flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
        padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        {messages.length === 0 && !loading && (
          <p style={{ color: '#6b7280', fontSize: 12, margin: 0, lineHeight: 1.6 }}>
            Ask QUARK about{' '}
            <span style={{ color: '#00ff88' }}>{fileName}</span>{' '}
            — it has full context of your file and Jefferson's entire project ecosystem.
          </p>
        )}

        {messages.map((msg, i) => {
          const isStreamingThis = loading && i === messages.length - 1 && msg.role === 'assistant';
          return (
            <div key={i} style={{ width: '100%', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: msg.role === 'user' ? '#6b7280' : '#00ff88', letterSpacing: '0.1em', flexShrink: 0 }}>
                  {msg.role === 'user' ? 'YOU' : 'QUARK'}
                </span>
                <span style={{ fontSize: 10, color: '#3a3a5c' }}>{msg.timestamp}</span>
                {isStreamingThis && (
                  <span style={{ fontSize: 10, color: '#3a3a5c' }} className="thinking-dots">thinking</span>
                )}
              </div>
              <div style={{ width: '100%', minWidth: 0 }}>
                {msg.content ? (
                  <QuarkMarkdown
                    onApplyCode={msg.role === 'assistant' ? applyCode : undefined}
                    allowApply={!isStreamingThis}
                  >
                    {msg.content}
                  </QuarkMarkdown>
                ) : msg.role === 'assistant' && (
                  <span style={{ color: '#3a3a5c', fontSize: 12 }}>
                    ⚛ thinking<span className="thinking-dots" />
                  </span>
                )}
              </div>
            </div>
          );
        })}

        <div ref={bottomRef} />
      </div>

      {/* Memory Search Panel */}
      {showSearch && (
        <div style={{
          borderTop: '1px solid #1e1e3f', background: '#08080f',
          padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0,
        }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className="quark-input"
              style={{ flex: 1, height: 30, fontSize: 11, minWidth: 0 }}
              placeholder="Search QUARK Memory..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runSearch()}
            />
            <button
              className="quark-btn-primary"
              style={{ fontSize: 10, padding: '0 10px', height: 30, flexShrink: 0 }}
              onClick={runSearch}
              disabled={searching || !searchQuery.trim()}
            >
              {searching ? '...' : 'GO'}
            </button>
          </div>
          {searchResults.length === 0 && !searching && searchQuery && (
            <span style={{ color: '#3a3a5c', fontSize: 11 }}>No results found.</span>
          )}
          {searchResults.map((r, i) => (
            <div
              key={i}
              onClick={() => insertSearchResult(r)}
              style={{
                background: '#0d0d1a', border: '1px solid #1e1e3f', borderRadius: 4,
                padding: '6px 8px', cursor: 'pointer', fontSize: 11,
                color: '#a0a0c0', fontFamily: 'JetBrains Mono, monospace',
                whiteSpace: 'pre-wrap', lineClamp: 3,
                overflow: 'hidden', maxHeight: 60,
              }}
            >
              {r.split('\n')[0]}
            </div>
          ))}
        </div>
      )}

      {/* Memory Toolbar */}
      <div style={{
        display: 'flex', gap: 6, padding: '6px 12px',
        borderTop: '1px solid #1e1e3f', background: '#0a0a16', flexShrink: 0,
        alignItems: 'center',
      }}>
        <button
          style={btnStyle}
          onClick={saveFile}
          disabled={saving || !fileContent}
          title="Save current file to QUARK Memory"
        >
          {saving ? '...' : '💾 Save'}
        </button>

        <button
          style={{
            ...btnStyle,
            background: showSearch ? 'rgba(0,255,136,0.15)' : btnStyle.background,
            borderColor: showSearch ? '#00ff88' : '#1e3f2a',
          }}
          onClick={() => { setShowSearch((v) => !v); setShowProjects(false); }}
          title="Search QUARK Memory"
        >
          🔍 Search
        </button>

        <div ref={projectsRef} style={{ position: 'relative' }}>
          <button
            style={{
              ...btnStyle,
              background: showProjects ? 'rgba(0,255,136,0.15)' : btnStyle.background,
              borderColor: showProjects ? '#00ff88' : '#1e3f2a',
            }}
            onClick={() => { setShowProjects((v) => !v); setShowSearch(false); }}
            title="Load project context into chat"
          >
            📚 Projects
          </button>
          {showProjects && (
            <div style={{
              position: 'absolute', bottom: '100%', left: 0, marginBottom: 4,
              background: '#0d0d1a', border: '1px solid #1e3f2a', borderRadius: 6,
              overflow: 'hidden', zIndex: 50, minWidth: 180,
              boxShadow: '0 -4px 20px rgba(0,0,0,0.6)',
            }}>
              {JEFFERSON_PROJECTS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => loadProject(p.prompt)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    background: 'none', border: 'none', borderBottom: '1px solid #1e1e3f',
                    color: '#e2e8f0', fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 11, padding: '8px 12px', cursor: 'pointer',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(0,255,136,0.07)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                >
                  <span style={{ color: '#00ff88', marginRight: 6 }}>⚛</span>
                  {p.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Input bar */}
      <div style={{
        display: 'flex', gap: 8, padding: '8px 12px',
        borderTop: '1px solid #1e1e3f', flexShrink: 0, background: '#0d0d1a',
      }}>
        <input
          ref={inputRef}
          className="quark-input"
          style={{ flex: 1, height: 36, minWidth: 0 }}
          placeholder="Ask QUARK about this code..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && sendMessage()}
          disabled={loading}
        />
        <button
          className="quark-btn-primary"
          onClick={() => sendMessage()}
          disabled={loading || !input.trim()}
          style={{ flexShrink: 0 }}
        >
          SEND
        </button>
      </div>
    </div>
  );
}
