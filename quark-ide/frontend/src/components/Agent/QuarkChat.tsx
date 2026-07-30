import { useState, useRef, useEffect } from 'react';
import ProjectSwitcher from '../Projects/ProjectSwitcher';
import type { Project } from '../../App';

const API_BASE = (import.meta.env.VITE_API_URL ?? 'https://backend-production-0d77.up.railway.app').replace(/\/$/, '');

// ── Interfaces ─────────────────────────────────────────────────────────────────

interface ChatMsg {
  role: 'user' | 'assistant' | 'action' | 'deep_search';
  text: string;
  /** true only for messages received live during this session — drives FileActivityCard animation */
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

// ── CSS animations — injected once into <head> ─────────────────────────────────
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

// ── File-activity detector ─────────────────────────────────────────────────────
const FILE_ACTIVITY_RE = /🔎|📖|📂|📌|⚡|buscando|leyendo|símbolo|evidencia/i;
function isFileActivity(text: string) { return FILE_ACTIVITY_RE.test(text); }

// ── ModelIndicator ─────────────────────────────────────────────────────────────
// Shows a CSS-3D shape (diamond / hexagon / sphere) for the active model tier.
// Spins while running; stays visible and settled when idle.

function ModelIndicator({ model, tier, running }: { model: string; tier: 'fast' | 'balanced' | 'deep'; running: boolean }) {
  const base: React.CSSProperties = {
    width: 20,
    height: 20,
    flexShrink: 0,
    boxShadow: '0 2px 8px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.14)',
    animation: running ? 'qk-spin-y 3s linear infinite' : 'none',
    transformStyle: 'preserve-3d',
    willChange: 'transform',
    transition: 'animation 0.3s',
  };

  let shapeStyle: React.CSSProperties;
  if (tier === 'fast') {
    shapeStyle = {
      ...base,
      background: 'linear-gradient(135deg, rgba(255,255,255,0.38) 0%, rgba(255,255,255,0.10) 100%)',
      clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
    };
  } else if (tier === 'balanced') {
    shapeStyle = {
      ...base,
      background: 'linear-gradient(135deg, rgba(255,255,255,0.32) 0%, rgba(255,255,255,0.09) 100%)',
      clipPath: 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)',
    };
  } else {
    // deep → sphere via radial-gradient + border-radius
    shapeStyle = {
      ...base,
      background: 'radial-gradient(circle at 34% 34%, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.18) 45%, rgba(255,255,255,0.04) 100%)',
      borderRadius: '50%',
    };
  }

  // Show only first two dash-segments so it stays compact ("claude-haiku", "llama3-8b", etc.)
  const shortModel = model.split('-').slice(0, 2).join('-');

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
      <div style={shapeStyle} />
      <span style={{
        fontSize: 10,
        color: 'rgba(255,255,255,0.38)',
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
// Small 3D-card (rectangle = "file" metaphor) that flips once on mount when
// isNew===true. Shown inline next to the action message text.

function FileActivityCard({ isNew }: { isNew: boolean }) {
  return (
    <div
      style={{
        width: 13,
        height: 17,
        flexShrink: 0,
        alignSelf: 'center',
        borderRadius: 2,
        background: 'linear-gradient(160deg, rgba(255,255,255,0.28) 0%, rgba(255,255,255,0.07) 100%)',
        boxShadow: '0 1px 5px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.14)',
        transformStyle: 'preserve-3d',
        animation: isNew ? 'qk-flip-x 0.6s ease forwards' : 'none',
        border: '1px solid rgba(255,255,255,0.12)',
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

// Strip isNew before persisting — prevents stale animation flags on reload
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

  // Auto-resize textarea
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

  // ── Persistir historial UI (sin isNew) ───────────────────────────────────────
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0a0a0a' }}>

      {/* ── Header ── */}
      <div style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center' }}>
        <div style={{ flex: 1 }}>
          <ProjectSwitcher activeProject={activeProject} onSwitch={onProjectChange} />
        </div>

        {/* Brand label */}
        <div style={{
          padding: '0 14px',
          color: 'rgba(255,255,255,0.45)',
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
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '6px',
            color: 'rgba(255,255,255,0.28)',
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
              e.currentTarget.style.borderColor = '#c14b4b';
              e.currentTarget.style.color = '#c14b4b';
            }
          }}
          onMouseLeave={e => {
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
            e.currentTarget.style.color = 'rgba(255,255,255,0.28)';
          }}
        >
          <span style={{ fontSize: '12px' }}>↺</span>
          <span>Reiniciar</span>
        </button>
      </div>

      {/* ── Message feed ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>

        {historyLoading && (
          <div style={{ color: 'rgba(255,255,255,0.28)', fontSize: '13px', alignSelf: 'center', marginTop: '8px' }}>
            Cargando historial...
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>

            {m.role === 'deep_search' ? (
              /* DEEP SEARCH pill */
              <div style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '7px',
                padding: '5px 12px',
                borderRadius: '20px',
                fontSize: '12px',
                fontWeight: 600,
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.16)',
                color: 'rgba(255,255,255,0.65)',
                letterSpacing: '0.03em',
              }}>
                <span style={{ fontSize: '14px' }}>🔭</span>
                <span style={{ color: 'rgba(255,255,255,0.45)', fontWeight: 700, letterSpacing: '0.06em' }}>DEEP</span>
                <span style={{ color: 'rgba(255,255,255,0.45)', fontWeight: 400, maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.text}
                </span>
              </div>

            ) : m.role === 'action' ? (
              /* ACTION message — inline FileActivityCard for file events */
              <div style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '7px',
                padding: '6px 10px',
                borderRadius: '8px',
                fontSize: '13px',
                color: 'rgba(255,255,255,0.45)',
                opacity: 0.85,
              }}>
                {isFileActivity(m.text) && <FileActivityCard isNew={!!m.isNew} />}
                <span style={{ lineHeight: '1.45' }}>{m.text}</span>
              </div>

            ) : m.role === 'user' ? (
              /* USER bubble */
              <div style={{
                padding: '9px 13px',
                borderRadius: '12px',
                fontSize: '15px',
                background: 'rgba(255,255,255,0.09)',
                border: '1px solid rgba(255,255,255,0.16)',
                color: 'rgba(255,255,255,0.92)',
                lineHeight: '1.55',
              }}>
                {m.text}
              </div>

            ) : (
              /* ASSISTANT bubble */
              <div style={{
                padding: '9px 13px',
                borderRadius: '10px',
                fontSize: '15px',
                background: '#0d0d0d',
                border: '1px solid rgba(255,255,255,0.08)',
                color: 'rgba(255,255,255,0.92)',
                lineHeight: '1.6',
              }}>
                {m.text}
              </div>
            )}
          </div>
        ))}

        {/* ── Pending patch proposal ── */}
        {pendingPatch && (
          <div style={{
            border: '1px solid rgba(255,255,255,0.16)',
            borderRadius: '10px',
            padding: '14px',
            background: '#0d0d0d',
          }}>
            <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: '13px', marginBottom: '4px', fontWeight: 500 }}>
              📝 {pendingPatch.path}
            </div>
            <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: '13px', marginBottom: '10px' }}>
              {pendingPatch.reasoning}
            </div>
            <details style={{ marginBottom: '10px' }}>
              <summary style={{ color: 'rgba(255,255,255,0.35)', fontSize: '12px', cursor: 'pointer' }}>
                Ver diff
              </summary>
              <pre style={{ fontSize: '11px', color: 'rgba(193,75,75,0.9)', whiteSpace: 'pre-wrap', marginTop: '6px' }}>
                - {pendingPatch.old_str}
              </pre>
              <pre style={{ fontSize: '11px', color: 'rgba(77,154,106,0.9)', whiteSpace: 'pre-wrap' }}>
                + {pendingPatch.new_str}
              </pre>
            </details>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={approvePatch}
                style={{
                  background: '#4d9a6a',
                  color: 'rgba(255,255,255,0.92)',
                  border: 'none',
                  padding: '6px 14px',
                  borderRadius: '6px',
                  fontSize: '13px',
                  cursor: 'pointer',
                }}
              >
                ✅ Aplicar
              </button>
              <button
                onClick={() => setPendingPatch(null)}
                style={{
                  background: '#c14b4b',
                  color: 'rgba(255,255,255,0.92)',
                  border: 'none',
                  padding: '6px 14px',
                  borderRadius: '6px',
                  fontSize: '13px',
                  cursor: 'pointer',
                }}
              >
                ❌ Rechazar
              </button>
            </div>
          </div>
        )}

        {streaming && (
          <div style={{ color: 'rgba(255,255,255,0.28)', fontSize: '13px' }}>
            Quark está pensando...
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* ── Input area ── */}
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>

        {/* Fast mode indicator */}
        {forceGroq && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            fontSize: '11px', color: '#c9a227',
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
              background: forceGroq ? 'rgba(201,162,39,0.14)' : 'rgba(255,255,255,0.04)',
              border: forceGroq ? '1px solid #c9a227' : '1px solid rgba(255,255,255,0.08)',
              borderRadius: '8px',
              color: forceGroq ? '#c9a227' : 'rgba(255,255,255,0.28)',
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
              background: '#0d0d0d',
              color: 'rgba(255,255,255,0.92)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '8px',
              padding: '10px 12px',
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
            onFocus={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.22)'; }}
            onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; }}
          />

          {/* Cancel / Send button */}
          {streaming ? (
            <button
              onClick={cancelSend}
              title="Cancelar envío"
              style={{
                background: '#c14b4b',
                color: 'rgba(255,255,255,0.92)',
                border: 'none',
                borderRadius: '8px',
                padding: '0 18px',
                fontSize: '15px',
                height: '40px',
                flexShrink: 0,
                cursor: 'pointer',
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
                background: input.trim() ? 'rgba(255,255,255,0.12)' : 'transparent',
                color: input.trim() ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.22)',
                border: input.trim() ? '1px solid rgba(255,255,255,0.25)' : '1px solid rgba(255,255,255,0.08)',
                borderRadius: '8px',
                padding: '0 18px',
                fontSize: '15px',
                height: '40px',
                flexShrink: 0,
                cursor: input.trim() ? 'pointer' : 'not-allowed',
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
