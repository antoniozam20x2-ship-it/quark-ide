import { useState, useRef, useEffect } from 'react';
import ProjectSwitcher from '../Projects/ProjectSwitcher';
import type { Project } from '../../App';

const API_BASE = (import.meta.env.VITE_API_URL ?? 'https://backend-production-0d77.up.railway.app').replace(/\/$/, '');

interface ChatMsg {
  role: 'user' | 'assistant' | 'action' | 'deep_search';
  text: string;
}

interface PendingPatch {
  path: string;
  old_str: string;
  new_str: string;
  reasoning: string;
}

type ModelTier = 'fast' | 'balanced' | 'deep';

interface ActiveModel {
  model: string;
  tier: ModelTier;
}

interface QuarkChatProps {
  repo: string;
  activeProject: Project;
  onProjectChange: (p: Project) => void;
  initialMessage?: string;
}

// ── Design tokens ──────────────────────────────────────────────────────────────
// Dark minimalist: black background, high-contrast white text, opacity-based
// hierarchy instead of a palette of grays, one restrained accent. Semantic
// colors (success/danger/warning) are kept but desaturated — they carry real
// information (apply/reject/fast-mode), not brand decoration.
const T = {
  bg: '#0a0a0a',
  bgPanel: '#0d0d0d',
  border: 'rgba(255,255,255,0.08)',
  borderStrong: 'rgba(255,255,255,0.16)',
  textPrimary: 'rgba(255,255,255,0.92)',
  textSecondary: 'rgba(255,255,255,0.45)',
  textTertiary: 'rgba(255,255,255,0.28)',
  fillSubtle: 'rgba(255,255,255,0.04)',
  fillHover: 'rgba(255,255,255,0.07)',
  userBubble: 'rgba(255,255,255,0.09)',
  success: '#4d9a6a',
  danger: '#c14b4b',
  warning: '#c9a227',
};

// ── localStorage helpers ──────────────────────────────────────────────────────

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

// ── 3D model indicator ─────────────────────────────────────────────────────────
// One geometry per tier so the state reads at a glance without relying on color:
//   fast (Groq)      → diamond  — quick, angular
//   balanced (Haiku) → hexagon  — a faceted middle ground
//   deep (Sonnet)     → sphere   — more surface, more shading, "deeper" processing
// Spins while a turn is running, settles to its resting face when it completes.
// Stays mounted between turns — the last active model remains visible.
function ModelIndicator({ activeModel, running }: { activeModel: ActiveModel | null; running: boolean }) {
  if (!activeModel) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
      <div
        className={`quark-model-shape quark-model-shape--${activeModel.tier}${running ? ' quark-model-shape--spinning' : ''}`}
        aria-hidden="true"
      />
      <span
        style={{
          fontSize: '11px',
          color: T.textSecondary,
          letterSpacing: '0.03em',
          fontFamily: 'JetBrains Mono, monospace',
          whiteSpace: 'nowrap',
        }}
      >
        {activeModel.model}
      </span>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function QuarkChat({ repo, activeProject, onProjectChange, initialMessage }: QuarkChatProps) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [pendingPatch, setPendingPatch] = useState<PendingPatch | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [forceGroq, setForceGroq] = useState(false);
  const [activeModel, setActiveModel] = useState<ActiveModel | null>(null);
  const [sessionId, setSessionId] = useState(() => getOrCreateSessionId(repo));
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
      .catch(() => { /* sin historial previo — arrancar limpio */ })
      .finally(() => { if (!cancelled) setHistoryLoading(false); });

    return () => { cancelled = true; };
  }, [sessionId]);

  useEffect(() => {
    if (messages.length > 0) {
      localStorage.setItem(uiHistoryKey(sessionId), JSON.stringify(messages));
    }
  }, [messages, sessionId]);

  useEffect(() => {
    if (initialMessage) setInput(initialMessage);
  }, [initialMessage]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, pendingPatch]);

  function resetConversation() {
    if (messages.length > 0 && !window.confirm('¿Borrar la conversación actual y empezar de cero?')) return;
    localStorage.removeItem(uiHistoryKey(sessionId));
    const newId = createFreshSessionId(repo);
    setSessionId(newId);
    setMessages([]);
    setPendingPatch(null);
    setForceGroq(false);
    setActiveModel(null);
  }

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
            setActiveModel({ model: evt.model, tier: evt.tier });
          }
          if (evt.event === 'action') {
            setMessages(m => [...m, { role: 'action', text: evt.text }]);
          }
          if (evt.event === 'deep_search') {
            setMessages(m => [...m, { role: 'deep_search', text: evt.query ?? '' }]);
          }
          if (evt.event === 'chat_message') {
            setMessages(m => [...m, { role: 'assistant', text: evt.text }]);
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
            setMessages(m => [...m, { role: 'action', text: `❌ ${evt.text}` }]);
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setMessages(m => [...m, { role: 'action', text: '⏸️ Mensaje cancelado' }]);
      } else {
        setMessages(m => [...m, { role: 'action', text: `❌ Error de conexión: ${err instanceof Error ? err.message : String(err)}` }]);
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
    setMessages(m => [...m, { role: 'action', text: `⏳ Aplicando patch en ${pendingPatch.path}...` }]);
    try {
      const res = await fetch(`${API_BASE}/api/agent/apply-patch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, ...pendingPatch }),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      setMessages(m => [...m, { role: 'action', text: data.ok ? `✅ Patch aplicado y commiteado en ${pendingPatch.path}` : `❌ ${data.error ?? 'Error al aplicar'}` }]);
    } catch (err) {
      setMessages(m => [...m, { role: 'action', text: `❌ Error al aplicar patch: ${err instanceof Error ? err.message : String(err)}` }]);
    }
    setPendingPatch(null);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: T.bg }}>
      <style>{`
        .quark-model-shape {
          width: 16px;
          height: 16px;
          flex-shrink: 0;
          transform-style: preserve-3d;
          transition: transform 0.4s ease;
          box-shadow: 0 1px 4px rgba(0,0,0,0.6);
        }
        .quark-model-shape--spinning {
          animation: quark-spin 3.2s linear infinite;
        }
        @keyframes quark-spin {
          from { transform: rotateY(0deg) rotateX(6deg); }
          to   { transform: rotateY(360deg) rotateX(6deg); }
        }
        .quark-model-shape--fast {
          background: linear-gradient(135deg, rgba(255,255,255,0.9), rgba(255,255,255,0.3));
          clip-path: polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%);
        }
        .quark-model-shape--balanced {
          background: linear-gradient(135deg, rgba(255,255,255,0.85), rgba(255,255,255,0.28));
          clip-path: polygon(25% 3%, 75% 3%, 100% 50%, 75% 97%, 25% 97%, 0% 50%);
        }
        .quark-model-shape--deep {
          border-radius: 50%;
          background: radial-gradient(circle at 32% 28%, rgba(255,255,255,0.98), rgba(255,255,255,0.18) 72%);
        }
      `}</style>

      <div style={{ borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center' }}>
        <div style={{ flex: 1 }}>
          <ProjectSwitcher activeProject={activeProject} onSwitch={onProjectChange} />
        </div>
        <div style={{ padding: '0 16px', color: T.textPrimary, fontWeight: 600, fontSize: 13, letterSpacing: '0.04em', flexShrink: 0 }}>
          💬 BROUS
        </div>
        <button
          onClick={resetConversation}
          disabled={streaming}
          title="Reiniciar conversación — borra el historial visible y empieza de cero"
          style={{
            flexShrink: 0,
            marginRight: 12,
            background: 'transparent',
            border: `1px solid ${T.border}`,
            borderRadius: '6px',
            color: T.textSecondary,
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
              e.currentTarget.style.borderColor = T.danger;
              e.currentTarget.style.color = T.danger;
            }
          }}
          onMouseLeave={e => {
            e.currentTarget.style.borderColor = T.border;
            e.currentTarget.style.color = T.textSecondary;
          }}
        >
          <span style={{ fontSize: '12px' }}>↺</span>
          <span>Reiniciar</span>
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {historyLoading && (
          <div style={{ color: T.textSecondary, fontSize: '13px', alignSelf: 'center', marginTop: '8px' }}>
            Cargando historial...
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
            {m.role === 'deep_search' ? (
              <div style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '7px',
                padding: '5px 11px',
                borderRadius: '20px',
                fontSize: '12px',
                fontWeight: 600,
                background: T.fillSubtle,
                border: `1px solid ${T.borderStrong}`,
                color: T.textPrimary,
                letterSpacing: '0.02em',
              }}>
                <span style={{ fontSize: '14px' }}>🔭</span>
                <span>DEEP</span>
                <span style={{ color: T.textSecondary, fontWeight: 400, maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.text}
                </span>
              </div>
            ) : (
              <div style={{
                padding: '8px 12px',
                borderRadius: '10px',
                fontSize: m.role === 'action' ? '13px' : '15px',
                background: m.role === 'user' ? T.userBubble : m.role === 'action' ? 'transparent' : T.fillSubtle,
                border: m.role === 'user' ? `1px solid ${T.border}` : 'none',
                color: m.role === 'action' ? T.textSecondary : T.textPrimary,
                opacity: m.role === 'action' ? 0.85 : 1,
              }}>
                {m.text}
              </div>
            )}
          </div>
        ))}

        {pendingPatch && (
          <div style={{ border: `1px solid ${T.borderStrong}`, borderRadius: '10px', padding: '12px', background: T.bgPanel }}>
            <div style={{ color: T.textPrimary, fontSize: '13px', marginBottom: '4px' }}>📝 {pendingPatch.path}</div>
            <div style={{ color: T.textSecondary, fontSize: '13px', marginBottom: '10px' }}>{pendingPatch.reasoning}</div>
            <details style={{ marginBottom: '10px' }}>
              <summary style={{ color: T.textSecondary, fontSize: '12px', cursor: 'pointer' }}>Ver diff</summary>
              <pre style={{ fontSize: '11px', color: '#e08a8a', whiteSpace: 'pre-wrap', marginTop: '6px' }}>- {pendingPatch.old_str}</pre>
              <pre style={{ fontSize: '11px', color: '#8fcaa3', whiteSpace: 'pre-wrap' }}>+ {pendingPatch.new_str}</pre>
            </details>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={approvePatch} style={{ background: T.success, color: 'white', border: 'none', padding: '6px 14px', borderRadius: '6px', fontSize: '13px' }}>✅ Aplicar</button>
              <button onClick={() => setPendingPatch(null)} style={{ background: T.danger, color: 'white', border: 'none', padding: '6px 14px', borderRadius: '6px', fontSize: '13px' }}>❌ Rechazar</button>
            </div>
          </div>
        )}

        {streaming && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <ModelIndicator activeModel={activeModel} running={streaming} />
            <span style={{ color: T.textSecondary, fontSize: '13px' }}>Quark está pensando...</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div style={{ borderTop: `1px solid ${T.border}`, padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {!streaming && activeModel && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '0 2px' }}>
            <ModelIndicator activeModel={activeModel} running={false} />
          </div>
        )}
        {forceGroq && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            fontSize: '11px', color: T.warning,
            fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.04em',
          }}>
            <span>⚡</span>
            <span>Modo rápido activado — próximo mensaje va directo a Groq</span>
          </div>
        )}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
          <button
            onClick={() => setForceGroq(v => !v)}
            disabled={streaming}
            title={forceGroq ? 'Modo rápido activo — click para desactivar' : 'Activar modo rápido (Groq directo para este mensaje)'}
            style={{
              flexShrink: 0,
              background: forceGroq ? 'rgba(201,162,39,0.14)' : T.fillSubtle,
              border: forceGroq ? `1px solid ${T.warning}` : `1px solid ${T.border}`,
              borderRadius: '8px',
              color: forceGroq ? T.warning : T.textSecondary,
              padding: '0 10px',
              height: '40px',
              fontSize: '14px',
              cursor: streaming ? 'not-allowed' : 'pointer',
              transition: 'all 0.15s',
            }}
          >
            ⚡
          </button>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => { setInput(e.target.value); adjustTextareaHeight(); }}
            placeholder="Escribe un mensaje..."
            disabled={streaming}
            rows={1}
            style={{
              flex: 1,
              background: T.bgPanel,
              color: T.textPrimary,
              border: `1px solid ${T.border}`,
              borderRadius: '8px',
              padding: '10px 12px',
              fontSize: '15px',
              resize: 'none',
              overflowY: 'hidden',
              lineHeight: '1.5',
              minHeight: '40px',
              maxHeight: '150px',
              fontFamily: 'inherit',
            }}
          />
          {streaming ? (
            <button
              onClick={cancelSend}
              title="Cancelar envío"
              style={{ background: T.danger, color: 'white', border: 'none', borderRadius: '8px', padding: '0 18px', fontSize: '15px', height: '40px', flexShrink: 0, cursor: 'pointer' }}
            >
              ⏸️
            </button>
          ) : (
            <button
              onClick={sendMessage}
              disabled={!input.trim()}
              title="Enviar mensaje"
              style={{
                background: input.trim() ? 'rgba(255,255,255,0.14)' : T.fillSubtle,
                color: T.textPrimary,
                border: `1px solid ${T.borderStrong}`,
                borderRadius: '8px',
                padding: '0 18px',
                fontSize: '15px',
                height: '40px',
                flexShrink: 0,
                cursor: input.trim() ? 'pointer' : 'not-allowed',
                opacity: input.trim() ? 1 : 0.5,
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
