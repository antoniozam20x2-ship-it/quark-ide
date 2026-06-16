import { useState, useRef, useEffect } from 'react';
import QuarkMarkdown from '../shared/QuarkMarkdown';
import type { Project } from '../../App';

// App → repo + keywords mapping for auto-detection
const APP_MAP: { label: string; repo: string; keywords: string[] }[] = [
  { label: 'Signal OS',  repo: 'Ahorar',         keywords: ['signal', 'ahorar', 'pnl', 'bias', 'circuit breaker', 'trailing', 'streak', 'funding', 'bot'] },
  { label: 'Sniper OS',  repo: 'Trade-SnipeOS',   keywords: ['sniper', 'señales', 'heatmap', 'radar', 'ttl', 'entry', 'p1', 'p2', 'p3', 'p4'] },
  { label: 'QUARK IDE',  repo: 'quark-ide',       keywords: ['quark', 'agent', 'war room', 'studio', 'debugger', 'preview'] },
  { label: 'Nexus OS',   repo: 'NEXUS-OS-app',    keywords: ['nexus', 'okx', 'spot', 'dca', 'conviction'] },
  { label: 'Core AI',    repo: 'Code-Coretest',   keywords: ['core ai', 'boardroom', 'atlas', 'oracle', 'helix', 'vega'] },
];

function detectApp(message: string): { label: string; repo: string } | null {
  const lower = message.toLowerCase();
  for (const app of APP_MAP) {
    if (app.keywords.some((kw) => lower.includes(kw))) return app;
  }
  return null;
}

interface RepoContextData {
  repo: string;
  tree: string[];
  keyFiles: { path: string; content: string }[];
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  type?: 'question' | 'suggestion' | 'confirmation';
  options?: string[];
  allowCustom?: boolean;
}

interface Props {
  fileContent: string;
  fileName: string;
  onApplyToEditor: (code: string) => void;
  onSendToBoard?: (brief: string) => void;
  onSendToStudio?: (brief: string) => void;
  layout?: 'panel' | 'fullscreen';
  activeProject?: Project;
}

const API_BASE = (import.meta.env.VITE_API_URL ?? window.location.origin).replace(/\/$/, '');

const MESSAGE_COLORS = {
  question:     '#7C3AED',
  suggestion:   '#06B6D4',
  confirmation: '#10B981',
  user:         '#F59E0B',
  system:       '#64748B',
} as const;

const JEFFERSON_PROJECTS = [
  { label: 'Signal OS',    prompt: 'Tell me about Signal OS — what areas of the trading bot logic can we improve next?' },
  { label: 'Snipe OS',     prompt: 'Tell me about Snipe OS — what features should we focus on for the signal intelligence PWA?' },
  { label: 'NEXUS Capital',prompt: 'Tell me about NEXUS Capital — how can we improve the Snipe Radar and Smart Concept indicators?' },
  { label: 'CORE AI',      prompt: 'Tell me about CORE AI — how should we architect the 6-agent trading council with Oracle verdict system?' },
  { label: 'QUARK IDE',    prompt: 'Tell me about QUARK IDE — what features should we add next to this development superapp?' },
];

function detectMessageType(content: string): 'question' | 'suggestion' | 'confirmation' | undefined {
  const c = content.toLowerCase();
  if (content.trimEnd().endsWith('?') || c.includes('¿')) return 'question';
  if (c.includes('sugiero') || c.includes('considera') || c.includes('podrías') || c.includes('recomiendo') || c.includes('podría ser')) return 'suggestion';
  if (c.includes('entendido') || c.includes('perfecto') || c.includes('listo') || c.includes('confirmo') || c.includes('de acuerdo') || c.includes('understood')) return 'confirmation';
  return undefined;
}

function parseOptions(content: string): { cleaned: string; options?: string[]; allowCustom?: boolean } {
  const optionsMatch = content.match(/OPTIONS:\s*(\[[\s\S]*?\])/);
  const allowCustom = /ALLOW_CUSTOM:\s*true/i.test(content);
  if (!optionsMatch) return { cleaned: content };
  try {
    const options = JSON.parse(optionsMatch[1]) as string[];
    const cleaned = content
      .replace(/\n?OPTIONS:\s*\[[\s\S]*?\]\n?/, '')
      .replace(/\n?ALLOW_CUSTOM:\s*true\n?/i, '')
      .trim();
    return { cleaned, options, allowCustom };
  } catch {
    return { cleaned: content };
  }
}

export default function ClaudeChat({
  fileContent,
  fileName,
  onApplyToEditor,
  onSendToBoard,
  onSendToStudio,
  layout = 'panel',
  activeProject,
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
  const [customOptionInput, setCustomOptionInput] = useState('');
  const [loadedContext, setLoadedContext] = useState<string | null>(null);
  const [loadedContextLabel, setLoadedContextLabel] = useState<string | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextLoadingLabel, setContextLoadingLabel] = useState('');

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const projectsRef = useRef<HTMLDivElement>(null);
  const contextDataRef = useRef<RepoContextData | null>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [input]);

  async function loadRepoContext(repo: string, label: string) {
    if (loadedContext === repo) return;
    setContextLoading(true);
    setContextLoadingLabel(label);
    try {
      const res = await fetch(`${API_BASE}/api/agent/repo-context?repo=${encodeURIComponent(repo)}`);
      if (res.ok) {
        const data: RepoContextData = await res.json();
        contextDataRef.current = data;
        setLoadedContext(repo);
        setLoadedContextLabel(label);
      }
    } catch {
      // fail silently — chat continues without context
    } finally {
      setContextLoading(false);
    }
  }

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

    // Auto-detect app and load repo context before sending
    const detected = detectApp(text);
    if (detected && detected.repo !== loadedContext) {
      await loadRepoContext(detected.repo, detected.label);
    }

    const userMsg: Message = {
      role: 'user',
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setCustomOptionInput('');
    if (inputRef.current) inputRef.current.style.height = '44px';
    setLoading(true);

    const assistantMsg: Message = {
      role: 'assistant',
      content: '',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    setMessages([...newMessages, assistantMsg]);

    // Últimos 5 exchanges (10 mensajes) como contexto
    const historyToSend = newMessages.slice(-10).map((m) => ({ role: m.role, content: m.content }));

    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: historyToSend,
          fileContent,
          fileName,
          activeProject: activeProject ? { name: activeProject.name, repo: activeProject.repo } : undefined,
          contextData: contextDataRef.current ?? undefined,
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

      // Post-proceso: detectar tipo y extraer opciones del mensaje completo
      const { cleaned, options, allowCustom } = parseOptions(assistantContent);
      const type = detectMessageType(cleaned);
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = { ...assistantMsg, content: cleaned, type, options, allowCustom };
        return updated;
      });
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
        {activeProject && (
          <span style={{ fontSize: 10, color: '#7C3AED', fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
            {activeProject.emoji} {activeProject.name}
          </span>
        )}
        <span style={{ color: '#6b7280', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginLeft: 'auto' }}>
          {fileName}
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
          const isLastAssistant = !loading && i === messages.length - 1 && msg.role === 'assistant';
          const accentColor = msg.role === 'user'
            ? MESSAGE_COLORS.user
            : msg.type === 'question'     ? MESSAGE_COLORS.question
            : msg.type === 'suggestion'   ? MESSAGE_COLORS.suggestion
            : msg.type === 'confirmation' ? MESSAGE_COLORS.confirmation
            : '#00ff88';

          return (
            <div key={i} style={{ width: '100%', minWidth: 0 }}>
              {/* Label row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: accentColor, letterSpacing: '0.1em', flexShrink: 0 }}>
                  {msg.role === 'user' ? 'YOU' : 'QUARK'}
                </span>
                {msg.type && msg.role === 'assistant' && (
                  <span style={{
                    fontSize: 9, color: accentColor, border: `1px solid ${accentColor}55`,
                    borderRadius: 3, padding: '1px 5px', fontFamily: 'JetBrains Mono, monospace',
                    opacity: 0.85, letterSpacing: '0.05em',
                  }}>
                    {msg.type}
                  </span>
                )}
                <span style={{ fontSize: 10, color: '#3a3a5c' }}>{msg.timestamp}</span>
                {isStreamingThis && (
                  <span style={{ fontSize: 10, color: '#3a3a5c' }} className="thinking-dots">thinking</span>
                )}
              </div>

              {/* Content with accent left border */}
              <div style={{
                borderLeft: msg.role === 'assistant' && msg.type ? `2px solid ${accentColor}55` : '2px solid transparent',
                paddingLeft: msg.role === 'assistant' && msg.type ? 8 : 0,
                width: '100%', minWidth: 0,
              }}>
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

              {/* Opciones interactivas */}
              {isLastAssistant && msg.options && msg.options.length > 0 && (
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {msg.options.map((opt, oi) => (
                      <button
                        key={oi}
                        onClick={() => sendMessage(opt)}
                        style={{
                          background: `${accentColor}11`,
                          border: `1px solid ${accentColor}44`,
                          borderRadius: 6,
                          color: accentColor,
                          fontFamily: 'JetBrains Mono, monospace',
                          fontSize: 11,
                          fontWeight: 600,
                          padding: '6px 12px',
                          cursor: 'pointer',
                          transition: 'background 0.15s',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = `${accentColor}22`)}
                        onMouseLeave={(e) => (e.currentTarget.style.background = `${accentColor}11`)}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                  {msg.allowCustom && (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        className="quark-input"
                        style={{ flex: 1, height: 30, fontSize: 11, minWidth: 0 }}
                        placeholder="O escribe tu preferencia..."
                        value={customOptionInput}
                        onChange={(e) => setCustomOptionInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && customOptionInput.trim()) sendMessage(customOptionInput.trim());
                        }}
                      />
                      <button
                        className="quark-btn-primary"
                        style={{ fontSize: 11, padding: '0 12px', height: 30, flexShrink: 0 }}
                        onClick={() => customOptionInput.trim() && sendMessage(customOptionInput.trim())}
                        disabled={!customOptionInput.trim()}
                      >
                        →
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Acciones del último mensaje del asistente */}
              {isLastAssistant && onSendToBoard && msg.content && (
                <button
                  onClick={() => onSendToBoard(msg.content)}
                  style={{
                    marginTop: 8,
                    background: 'rgba(124,58,237,0.12)',
                    border: '1px solid #4c1d95',
                    borderRadius: 4,
                    color: '#a78bfa',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 10,
                    fontWeight: 700,
                    padding: '4px 10px',
                    cursor: 'pointer',
                    letterSpacing: '0.04em',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(124,58,237,0.22)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(124,58,237,0.12)')}
                >
                  📋 Enviar al Board
                </button>
              )}
              {isLastAssistant && onSendToStudio && msg.content && (
                <button
                  onClick={() => onSendToStudio(msg.content)}
                  style={{
                    marginTop: 8,
                    padding: '6px 14px',
                    background: 'rgba(6,182,212,0.12)',
                    border: '1px solid rgba(6,182,212,0.3)',
                    borderRadius: 6,
                    color: '#06B6D4',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(6,182,212,0.22)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(6,182,212,0.12)')}
                >
                  🎨 Enviar a Studio
                </button>
              )}
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
          {searchResults.map((r, ri) => (
            <div
              key={ri}
              onClick={() => insertSearchResult(r)}
              style={{
                background: '#0d0d1a', border: '1px solid #1e1e3f', borderRadius: 4,
                padding: '6px 8px', cursor: 'pointer', fontSize: 11,
                color: '#a0a0c0', fontFamily: 'JetBrains Mono, monospace',
                whiteSpace: 'pre-wrap', overflow: 'hidden', maxHeight: 60,
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
          style={{ ...btnStyle, background: showSearch ? 'rgba(0,255,136,0.15)' : btnStyle.background, borderColor: showSearch ? '#00ff88' : '#1e3f2a' }}
          onClick={() => { setShowSearch((v) => !v); setShowProjects(false); }}
          title="Search QUARK Memory"
        >
          🔍 Search
        </button>
        <div ref={projectsRef} style={{ position: 'relative' }}>
          <button
            style={{ ...btnStyle, background: showProjects ? 'rgba(0,255,136,0.15)' : btnStyle.background, borderColor: showProjects ? '#00ff88' : '#1e3f2a' }}
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
        display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 12px',
        borderTop: '1px solid #1e1e3f', flexShrink: 0, background: '#0d0d1a',
      }}>
        {/* Context status row */}
        {(contextLoading || loadedContextLabel) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 16 }}>
            {contextLoading && (
              <span style={{
                fontSize: 10, color: '#00ff88', fontFamily: 'JetBrains Mono, monospace',
                opacity: 0.8, letterSpacing: '0.03em',
              }}>
                ⚡ Cargando contexto de {contextLoadingLabel}...
              </span>
            )}
            {!contextLoading && loadedContextLabel && (
              <span style={{
                fontSize: 10, color: '#7C3AED', fontFamily: 'JetBrains Mono, monospace',
                background: 'rgba(124,58,237,0.12)', border: '1px solid rgba(124,58,237,0.3)',
                borderRadius: 4, padding: '1px 7px', fontWeight: 700, letterSpacing: '0.03em',
              }}>
                📁 {loadedContextLabel}
              </span>
            )}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea
            ref={inputRef}
            className="quark-input"
            style={{ flex: 1, minWidth: 0, minHeight: 44, maxHeight: 200, resize: 'none', overflowY: 'auto' }}
            placeholder="Ask QUARK about this code..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            disabled={loading || contextLoading}
          />
          <button
            className="quark-btn-primary"
            onClick={() => sendMessage()}
            disabled={loading || contextLoading || !input.trim()}
            style={{ flexShrink: 0 }}
          >
            SEND
          </button>
        </div>
      </div>
    </div>
  );
}
