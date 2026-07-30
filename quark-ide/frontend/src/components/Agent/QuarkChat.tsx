import { useState, useRef, useEffect } from 'react';
import ProjectSwitcher from '../Projects/ProjectSwitcher';
import type { Project } from '../../App';

const API_BASE = (import.meta.env.VITE_API_URL ?? 'https://backend-production-0d77.up.railway.app').replace(/\/$/, '');

// ── Design tokens ──────────────────────────────────────────────────────────────
const T = {
  // Tier accent colors (ModelIndicator shape + model name text)
  tierFast:     '#f5a623',   // amber  — Groq
  tierBalanced: '#22d3ee',   // cyan   — Haiku
  tierDeep:     '#a855f7',   // violet — Sonnet

  // Semantic action message colors (map real backend emojis)
  actionFound:    '#34d399',              // emerald — evidence / found
  actionSynthesis:'#38bdf8',              // sky     — reasoning / synthesis
  actionWarn:     '#f5a623',              // amber   — warning
  actionError:    '#ef4444',              // red     — error
  actionNeutral:  'rgba(255,255,255,0.45)', // gray  — in-progress, steps

  // Keyword highlight (bold terms in assistant messages)
  keyword: '#f2c14e',

  // Text hierarchy
  textPrimary:   'rgba(255,255,255,0.92)',
  textSecondary: 'rgba(255,255,255,0.50)',
  textTertiary:  'rgba(255,255,255,0.28)',

  // Liquid glass material
  glassBg:        'rgba(255,255,255,0.06)',
  glassBorder:    'rgba(255,255,255,0.12)',
  glassBorderHi:  'rgba(255,255,255,0.20)',
  glassHighlight: 'rgba(255,255,255,0.15)',  // inset top shine
  glassBlur:      'blur(20px) saturate(180%)',

  // User bubble tint — deep/violet at low opacity over glass
  userTint: 'rgba(168,85,247,0.11)',
} as const;

// ── CSS animations injected once ───────────────────────────────────────────────
if (typeof document !== 'undefined' && !document.getElementById('quark-chat-anims')) {
  const s = document.createElement('style');
  s.id = 'quark-chat-anims';
  s.textContent = `
    @keyframes qk-spin-y {
      from { transform: rotateY(0deg); }
      to   { transform: rotateY(360deg); }
    }
    @keyframes qk-flip-x {
      0%   { transform: rotateX(0deg); }
      100% { transform: rotateX(360deg); }
    }
  `;
  document.head.appendChild(s);
}

// ── Interfaces ─────────────────────────────────────────────────────────────────

interface ChatMsg {
  role: 'user' | 'assistant' | 'action' | 'deep_search';
  text: string;
  isNew?: boolean;
}

interface PendingPatch {
  path: string;
  old_str: string;
  new_str: string;
  reasoning: string;
}

interface QuarkChatProps {
  repo: string;
  activeProject: Project;
  onProjectChange: (p: Project) => void;
  initialMessage?: string;
}

interface ActiveModel {
  model: string;
  tier: 'fast' | 'balanced' | 'deep';
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Map real backend emojis/patterns to a semantic color. */
function categorizeActionMessage(text: string): string {
  if (/^❌/.test(text))                          return T.actionError;
  if (/^⚠️/.test(text))                         return T.actionWarn;
  if (/^(📌|📂|⚡|✅)/.test(text))             return T.actionFound;
  if (/^(💡|📚)/.test(text))                    return T.actionSynthesis;
  if (/Plan ejecutado/i.test(text))              return T.actionSynthesis;
  // 🧠 Paso X  → neutral step; 🧠 [anything else] → synthesis
  if (/^🧠\s+Paso/.test(text))                  return T.actionNeutral;
  if (/^🧠/.test(text))                         return T.actionSynthesis;
  // 🔎 🔬 🗺️ ⏳ ⏸️ and everything else → neutral/in-progress
  return T.actionNeutral;
}

/** Parse **bold** markdown into golden <span>s; rest stays neutral. */
function parseMarkdownBold(text: string): React.ReactNode {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return parts.map((part, i) =>
    i % 2 === 1
      ? <span key={i} style={{ color: T.keyword, fontWeight: 600 }}>{part}</span>
      : part
  );
}

/** File-activity events (trigger FileActivityCard flip). */
const FILE_ACTIVITY_RE = /🔎|📖|📂|📌|⚡|buscando|leyendo|símbolo|evidencia/i;
function isFileActivity(text: string) { return FILE_ACTIVITY_RE.test(text); }

// ── ModelIndicator ─────────────────────────────────────────────────────────────
// Geometry: diamond (fast) / hexagon (balanced) / sphere (deep) — unchanged.
// Material: each tier now uses ITS OWN color gradient.

function ModelIndicator({ model, tier, running }: { model: string; tier: 'fast' | 'balanced' | 'deep'; running: boolean }) {
  const color = tier === 'fast' ? T.tierFast : tier === 'balanced' ? T.tierBalanced : T.tierDeep;

  const base: React.CSSProperties = {
    width: 20,
    height: 20,
    flexShrink: 0,
    animation: running ? 'qk-spin-y 3s linear infinite' : 'none',
    transformStyle: 'preserve-3d',
    willChange: 'transform',
    // Subtle glow matching the tier color
    boxShadow: `0 0 8px ${color}55, 0 2px 6px rgba(0,0,0,0.6), inset 0 1px 0 ${color}88`,
  };

  let shapeStyle: React.CSSProperties;
  if (tier === 'fast') {
    // Diamond — amber
    shapeStyle = {
      ...base,
      background: `linear-gradient(135deg, ${color} 0%, ${color}66 100%)`,
      clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
    };
  } else if (tier === 'balanced') {
    // Hexagon — cyan
    shapeStyle = {
      ...base,
      background: `linear-gradient(135deg, ${color} 0%, ${color}55 100%)`,
      clipPath: 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)',
    };
  } else {
    // Sphere — violet, radial for volume
    shapeStyle = {
      ...base,
      background: `radial-gradient(circle at 34% 34%, ${color}ee 0%, ${color}88 45%, ${color}22 100%)`,
      borderRadius: '50%',
    };
  }

  const shortModel = model.split('-').slice(0, 2).join('-');

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
      <div style={shapeStyle} />
      <span style={{
        fontSize: 10,
        color,
        opacity: 0.85,
        letterSpacing: '0.05em',
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
        textTransform: 'uppercase',
      }}>
        {shortModel}
      </span>
    </div>
  );
}

// ── FileActivityCard ───────────────────────────────────────────────────────────
// Tiny 3D document-card that flips once when a live file-activity event arrives.

function FileActivityCard({ isNew }: { isNew: boolean }) {
  return (
    <div
      style={{
        width: 13,
        height: 17,
        flexShrink: 0,
        alignSelf: 'center',
        borderRadius: 2,
        background: `linear-gradient(160deg, ${T.actionFound}55 0%, ${T.actionFound}18 100%)`,
        boxShadow: `0 1px 5px rgba(0,0,0,0.5), inset 0 1px 0 ${T.actionFound}66`,
        border: `1px solid ${T.actionFound}44`,
        transformStyle: 'preserve-3d',
        animation: isNew ? 'qk-flip-x 0.6s ease forwards' : 'none',
      }}
    />
  );
}

// ── localStorage helpers ───────────────────────────────────────────────────────

function getOrCreateSessionId(repo: string): string {
  const key = `quark-chat-session:${repo}`;
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const fresh = `session-${Date.now()}`;
  localStorage.setItem(key, fresh);
  return fresh;
}

function createFreshSessionId(repo: string): string {
  const key = `quark-chat-session:${repo}`;
  const fresh = `session-${Date.now()}`;
  localStorage.setItem(key, fresh);
  return fresh;
}

function uiHistoryKey(sessionId: string) {
  return `quark-chat-ui:${sessionId}`;
}

function stripIsNew(msgs: ChatMsg[]): ChatMsg[] {
  return msgs.map(({ role, text }) => ({ role, text }));
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function QuarkChat({ repo, activeProject, onProjectChange, initialMessage }: QuarkChatProps) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [pendingPatch, setPendingPatch] = useState<PendingPatch | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [forceGroq, setForceGroq] = useState(false);
  const [sessionId, setSessionId] = useState(() => getOrCreateSessionId(repo));
  const [activeModel, setActiveModel] = useState<ActiveModel | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const adjustTextareaHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = 150;
    el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px';
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  };

  const resetTextareaHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.overflowY = 'hidden';
  };

  // ── Rehidratar historial ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setHistoryLoading(true);

    const localRaw = localStorage.getItem(uiHistoryKey(sessionId));
    if (localRaw) {
      try {
        const localMsgs = JSON.parse(localRaw) as ChatMsg[];
        if (localMsgs.length > 0 && !cancelled) {
          setMessages(localMsgs);
          setHistoryLoading(false);
          return;
        }
      } catch {
        // JSON inválido — seguir al fallback
      }
    }

    fetch(`${API_BASE}/api/agent/chat/history/${encodeURIComponent(sessionId)}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then((data: { messages: ChatMsg[] }) => {
        if (!cancelled && data.messages.length > 0) {
          setMessages(data.messages);
          localStorage.setItem(uiHistoryKey(sessionId), JSON.stringify(data.messages));
        }
      })
      .catch(() => { /* sin historial previo */ })
      .finally(() => { if (!cancelled) setHistoryLoading(false); });

    return () => { cancelled = true; };
  }, [sessionId]);

  useEffect(() => {
    if (messages.length > 0) {
      localStorage.setItem(uiHistoryKey(sessionId), JSON.stringify(stripIsNew(messages)));
    }
  }, [messages, sessionId]);

  useEffect(() => {
    if (initialMessage) setInput(initialMessage);
  }, [initialMessage]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, pendingPatch]);

  // ── Reset de conversación ─────────────────────────────────────────────────────
  function resetConversation() {
    if (messages.length > 0 && !window.confirm('¿Borrar la conversación actual y empezar de cero?')) return;
    localStorage.removeItem(uiHistoryKey(sessionId));
    const newId = createFreshSessionId(repo);
    setSessionId(newId);
    setMessages([]);
    setPendingPatch(null);
    setForceGroq(false);
  }

  // ── sendMessage ───────────────────────────────────────────────────────────────
  async function sendMessage() {
    if (!input.trim() || streaming) return;
    const userMsg = input;
    const useForceGroq = forceGroq;
    setForceGroq(false);
    setMessages(m => [...m, { role: 'user', text: userMsg }]);
    setInput('');
    resetTextareaHeight();
    setStreaming(true);

    try {
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const res = await fetch(`${API_BASE}/api/agent/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMsg, repo, sessionId, forceGroq: useForceGroq }),
        signal: controller.signal,
      });

      if (!res.ok) {
        let errText = `HTTP ${res.status}`;
        try { const d = await res.json() as { error?: string }; if (d.error) errText = d.error; } catch {}
        throw new Error(errText);
      }
      if (!res.body) throw new Error('Sin respuesta del servidor');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          if (!part.startsWith('data: ')) continue;
          const evt = JSON.parse(part.slice(6));

          if (evt.event === 'model_active') {
            setActiveModel({ model: evt.model as string, tier: evt.tier as 'fast' | 'balanced' | 'deep' });
          }
          if (evt.event === 'action') {
            setMessages(m => [...m, { role: 'action', text: evt.text, isNew: true }]);
          }
          if (evt.event === 'deep_search') {
            setMessages(m => [...m, { role: 'deep_search', text: evt.query ?? '', isNew: true }]);
          }
          if (evt.event === 'chat_message') {
            setMessages(m => [...m, { role: 'assistant', text: evt.text, isNew: true }]);
          }
          if (evt.event === 'patch_proposal') {
            setPendingPatch({
              path: evt.path,
              old_str: evt.old_str,
              new_str: evt.new_str,
              reasoning: evt.reasoning,
            });
          }
          if (evt.event === 'error') {
            setMessages(m => [...m, { role: 'action', text: `❌ ${evt.text}`, isNew: true }]);
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setMessages(m => [...m, { role: 'action', text: '⏸️ Mensaje cancelado', isNew: true }]);
      } else {
        setMessages(m => [...m, { role: 'action', text: `❌ Error de conexión: ${err instanceof Error ? err.message : String(err)}`, isNew: true }]);
      }
    } finally {
      setStreaming(false);
      abortControllerRef.current = null;
    }
  }

  function cancelSend() {
    abortControllerRef.current?.abort();
  }

  async function approvePatch() {
    if (!pendingPatch) return;
    setMessages(m => [...m, { role: 'action', text: `⏳ Aplicando patch en ${pendingPatch.path}...`, isNew: true }]);
    try {
      const res = await fetch(`${API_BASE}/api/agent/apply-patch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, ...pendingPatch }),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      setMessages(m => [...m, {
        role: 'action',
        text: data.ok
          ? `✅ Patch aplicado y commiteado en ${pendingPatch.path}`
          : `❌ ${data.error ?? 'Error al aplicar'}`,
        isNew: true,
      }]);
    } catch (err) {
      setMessages(m => [...m, { role: 'action', text: `❌ Error al aplicar patch: ${err instanceof Error ? err.message : String(err)}`, isNew: true }]);
    }
    setPendingPatch(null);
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  // Fast-mode button uses tier amber — coincidence is intentional
  const fastModeColor = T.tierFast;

  return (
    // Outer shell — deep radial gradient background
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: 'radial-gradient(ellipse at 50% 20%, #0d0d12 0%, #050506 100%)',
      position: 'relative',
    }}>

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      {/* position + zIndex here are REQUIRED: backdrop-filter creates a stacking
          context, and without an explicit z-index the message feed (later in DOM)
          paints over the absolutely-positioned ProjectSwitcher dropdown. */}
      <div style={{
        position: 'relative',
        zIndex: 10,
        display: 'flex',
        alignItems: 'center',
        background: T.glassBg,
        backdropFilter: T.glassBlur,
        WebkitBackdropFilter: T.glassBlur,
        borderBottom: `1px solid ${T.glassBorder}`,
        boxShadow: `inset 0 1px 0 ${T.glassHighlight}`,
      }}>
        <div style={{ flex: 1 }}>
          <ProjectSwitcher activeProject={activeProject} onSwitch={onProjectChange} />
        </div>

        {/* Brand label */}
        <div style={{
          padding: '0 14px',
          color: T.textSecondary,
          fontWeight: 600,
          fontSize: 12,
          flexShrink: 0,
          letterSpacing: '0.08em',
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          textTransform: 'uppercase',
        }}>
          💬 BROUS
        </div>

        {/* Model indicator — persists between turns */}
        {activeModel && (
          <div style={{ padding: '0 10px', flexShrink: 0 }}>
            <ModelIndicator model={activeModel.model} tier={activeModel.tier} running={streaming} />
          </div>
        )}

        {/* Reset button */}
        <button
          onClick={resetConversation}
          disabled={streaming}
          title="Reiniciar conversación — borra el historial visible y empieza de cero"
          style={{
            flexShrink: 0,
            marginRight: 12,
            background: 'transparent',
            border: `1px solid ${T.glassBorder}`,
            borderRadius: '6px',
            color: T.textTertiary,
            padding: '4px 10px',
            fontSize: '11px',
            cursor: streaming ? 'not-allowed' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            transition: 'all 0.15s',
            letterSpacing: '0.02em',
          }}
          onMouseEnter={e => {
            if (!streaming) {
              e.currentTarget.style.borderColor = T.actionError;
              e.currentTarget.style.color = T.actionError;
            }
          }}
          onMouseLeave={e => {
            e.currentTarget.style.borderColor = T.glassBorder;
            e.currentTarget.style.color = T.textTertiary;
          }}
        >
          <span style={{ fontSize: '12px' }}>↺</span>
          <span>Reiniciar</span>
        </button>
      </div>

      {/* ── Message feed ────────────────────────────────────────────────────── */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      }}>

        {historyLoading && (
          <div style={{ color: T.textTertiary, fontSize: '13px', alignSelf: 'center', marginTop: '8px' }}>
            Cargando historial...
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>

            {m.role === 'deep_search' ? (
              // ── DEEP SEARCH pill ──────────────────────────────────────────
              <div style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '7px',
                padding: '5px 14px',
                borderRadius: '999px',
                fontSize: '12px',
                fontWeight: 600,
                background: `rgba(168,85,247,0.08)`,
                backdropFilter: T.glassBlur,
                WebkitBackdropFilter: T.glassBlur,
                border: `1px solid rgba(168,85,247,0.28)`,
                boxShadow: `inset 0 1px 0 rgba(168,85,247,0.20)`,
                color: T.tierDeep,
                letterSpacing: '0.03em',
              }}>
                <span style={{ fontSize: '14px' }}>🔭</span>
                <span style={{ fontWeight: 700, letterSpacing: '0.07em' }}>DEEP</span>
                <span style={{
                  color: T.textSecondary,
                  fontWeight: 400,
                  maxWidth: '260px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {m.text}
                </span>
              </div>

            ) : m.role === 'action' ? (
              // ── ACTION message ────────────────────────────────────────────
              <div style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '7px',
                padding: '4px 8px',
                borderRadius: '8px',
                fontSize: '13px',
                color: categorizeActionMessage(m.text),
                lineHeight: '1.45',
              }}>
                {isFileActivity(m.text) && <FileActivityCard isNew={!!m.isNew} />}
                <span>{m.text}</span>
              </div>

            ) : m.role === 'user' ? (
              // ── USER bubble — glass + violet tint ────────────────────────
              <div style={{
                padding: '10px 14px',
                borderRadius: '16px 16px 4px 16px',
                fontSize: '15px',
                background: `linear-gradient(135deg, ${T.userTint} 0%, rgba(255,255,255,0.05) 100%)`,
                backdropFilter: T.glassBlur,
                WebkitBackdropFilter: T.glassBlur,
                border: `1px solid ${T.glassBorderHi}`,
                boxShadow: `inset 0 1px 0 ${T.glassHighlight}, 0 2px 12px rgba(0,0,0,0.3)`,
                color: T.textPrimary,
                lineHeight: '1.55',
              }}>
                {m.text}
              </div>

            ) : (
              // ── ASSISTANT bubble — glass, bold terms highlighted ──────────
              <div style={{
                padding: '10px 14px',
                borderRadius: '4px 16px 16px 16px',
                fontSize: '15px',
                background: T.glassBg,
                backdropFilter: T.glassBlur,
                WebkitBackdropFilter: T.glassBlur,
                border: `1px solid ${T.glassBorder}`,
                boxShadow: `inset 0 1px 0 ${T.glassHighlight}, 0 2px 12px rgba(0,0,0,0.3)`,
                color: T.textPrimary,
                lineHeight: '1.65',
              }}>
                {parseMarkdownBold(m.text)}
              </div>
            )}
          </div>
        ))}

        {/* ── Pending patch proposal ────────────────────────────────────────── */}
        {pendingPatch && (
          <div style={{
            borderRadius: '16px',
            padding: '16px',
            background: `rgba(168,85,247,0.06)`,
            backdropFilter: T.glassBlur,
            WebkitBackdropFilter: T.glassBlur,
            border: `1px solid rgba(168,85,247,0.25)`,
            boxShadow: `inset 0 1px 0 rgba(168,85,247,0.18), 0 4px 20px rgba(0,0,0,0.4)`,
          }}>
            <div style={{ color: T.textPrimary, fontSize: '13px', marginBottom: '4px', fontWeight: 500 }}>
              📝 {pendingPatch.path}
            </div>
            <div style={{ color: T.textSecondary, fontSize: '13px', marginBottom: '10px', lineHeight: '1.5' }}>
              {pendingPatch.reasoning}
            </div>
            <details style={{ marginBottom: '12px' }}>
              <summary style={{ color: T.textTertiary, fontSize: '12px', cursor: 'pointer', userSelect: 'none' }}>
                Ver diff
              </summary>
              <pre style={{ fontSize: '11px', color: `${T.actionError}cc`, whiteSpace: 'pre-wrap', marginTop: '6px' }}>
                - {pendingPatch.old_str}
              </pre>
              <pre style={{ fontSize: '11px', color: `${T.actionFound}cc`, whiteSpace: 'pre-wrap' }}>
                + {pendingPatch.new_str}
              </pre>
            </details>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={approvePatch}
                style={{
                  background: `${T.actionFound}22`,
                  color: T.actionFound,
                  border: `1px solid ${T.actionFound}55`,
                  padding: '6px 16px',
                  borderRadius: '8px',
                  fontSize: '13px',
                  cursor: 'pointer',
                  fontWeight: 500,
                  transition: 'all 0.15s',
                }}
              >
                ✅ Aplicar
              </button>
              <button
                onClick={() => setPendingPatch(null)}
                style={{
                  background: `${T.actionError}22`,
                  color: T.actionError,
                  border: `1px solid ${T.actionError}55`,
                  padding: '6px 16px',
                  borderRadius: '8px',
                  fontSize: '13px',
                  cursor: 'pointer',
                  fontWeight: 500,
                  transition: 'all 0.15s',
                }}
              >
                ❌ Rechazar
              </button>
            </div>
          </div>
        )}

        {streaming && (
          <div style={{ color: T.textTertiary, fontSize: '13px', paddingLeft: '8px' }}>
            Quark está pensando...
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* ── Input area ──────────────────────────────────────────────────────── */}
      <div style={{
        borderTop: `1px solid ${T.glassBorder}`,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        background: T.glassBg,
        backdropFilter: T.glassBlur,
        WebkitBackdropFilter: T.glassBlur,
        boxShadow: `inset 0 1px 0 ${T.glassHighlight}`,
      }}>

        {/* Fast mode indicator */}
        {forceGroq && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            fontSize: '11px', color: fastModeColor,
            fontFamily: 'JetBrains Mono, ui-monospace, monospace',
            letterSpacing: '0.04em',
          }}>
            <span>⚡</span>
            <span>Modo rápido activado — próximo mensaje va directo a Groq</span>
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>

          {/* Fast-mode toggle */}
          <button
            onClick={() => setForceGroq(v => !v)}
            disabled={streaming}
            title={forceGroq ? 'Modo rápido activo — click para desactivar' : 'Activar modo rápido (Groq directo para este mensaje)'}
            style={{
              flexShrink: 0,
              background: forceGroq ? `${fastModeColor}18` : 'rgba(255,255,255,0.04)',
              border: forceGroq ? `1px solid ${fastModeColor}88` : `1px solid ${T.glassBorder}`,
              borderRadius: '10px',
              color: forceGroq ? fastModeColor : T.textTertiary,
              padding: '0 10px',
              height: '40px',
              fontSize: '14px',
              cursor: streaming ? 'not-allowed' : 'pointer',
              transition: 'all 0.15s',
            }}
          >
            ⚡
          </button>

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => { setInput(e.target.value); adjustTextareaHeight(); }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
            }}
            placeholder="Escribe un mensaje..."
            disabled={streaming}
            rows={1}
            style={{
              flex: 1,
              background: 'rgba(255,255,255,0.04)',
              color: T.textPrimary,
              border: `1px solid ${T.glassBorder}`,
              borderRadius: '10px',
              padding: '10px 13px',
              fontSize: '15px',
              resize: 'none',
              overflowY: 'hidden',
              lineHeight: '1.5',
              minHeight: '40px',
              maxHeight: '150px',
              fontFamily: 'inherit',
              outline: 'none',
              transition: 'border-color 0.15s',
            }}
            onFocus={e => { e.currentTarget.style.borderColor = T.glassBorderHi; }}
            onBlur={e => { e.currentTarget.style.borderColor = T.glassBorder; }}
          />

          {/* Cancel / Send */}
          {streaming ? (
            <button
              onClick={cancelSend}
              title="Cancelar envío"
              style={{
                background: `${T.actionError}22`,
                color: T.actionError,
                border: `1px solid ${T.actionError}55`,
                borderRadius: '10px',
                padding: '0 18px',
                fontSize: '15px',
                height: '40px',
                flexShrink: 0,
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
            >
              ⏸️
            </button>
          ) : (
            <button
              onClick={sendMessage}
              disabled={!input.trim()}
              title="Enviar mensaje"
              style={{
                background: input.trim() ? 'rgba(255,255,255,0.10)' : 'transparent',
                color: input.trim() ? T.textPrimary : T.textTertiary,
                border: input.trim() ? `1px solid ${T.glassBorderHi}` : `1px solid ${T.glassBorder}`,
                borderRadius: '10px',
                padding: '0 18px',
                fontSize: '15px',
                height: '40px',
                flexShrink: 0,
                cursor: input.trim() ? 'pointer' : 'not-allowed',
                boxShadow: input.trim() ? `inset 0 1px 0 ${T.glassHighlight}` : 'none',
                transition: 'all 0.15s',
              }}
            >
              ➤
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
