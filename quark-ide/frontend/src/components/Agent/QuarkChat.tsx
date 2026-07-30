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

interface QuarkChatProps {
  repo: string;
  activeProject: Project;
  onProjectChange: (p: Project) => void;
  initialMessage?: string;
}

// ── localStorage helpers ──────────────────────────────────────────────────────

// Devuelve un sessionId estable para el repo — sobrevive remounts del componente
// porque se persiste en localStorage. Si no hay uno previo, genera uno nuevo.
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

// Key para el historial completo de UI (todos los roles: user, assistant, action,
// deep_search). Persiste los "archivos encontrados" y otros action messages que
// el backend no guarda — solo guarda user/assistant para continuidad del modelo.
function uiHistoryKey(sessionId: string) {
  return `quark-chat-ui:${sessionId}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function QuarkChat({ repo, activeProject, onProjectChange, initialMessage }: QuarkChatProps) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [pendingPatch, setPendingPatch] = useState<PendingPatch | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  // forceGroq: cuando está activo, el próximo mensaje se procesa directo por Groq
  // saltando la continuidad de sesión Haiku. Se resetea automáticamente tras el envío.
  const [forceGroq, setForceGroq] = useState(false);
  // sessionId es estable entre remounts — vive en localStorage keyado por repo.
  // Tiene setter para que resetConversation() pueda generar uno nuevo.
  const [sessionId, setSessionId] = useState(() => getOrCreateSessionId(repo));
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Auto-resize del textarea al escribir
  const adjustTextareaHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = 150; // ~6 líneas
    el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px';
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  };

  // Resetear altura del textarea a una línea
  const resetTextareaHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.overflowY = 'hidden';
  };

  // ── Rehidratar historial al montar (o al cambiar sessionId por reset) ────────
  // Orden de prioridad:
  //   1. localStorage (uiHistoryKey) — contiene TODOS los roles (action, deep_search)
  //      incluyendo los "archivos encontrados" que el backend no persiste.
  //   2. Backend GET /api/agent/chat/history/:sessionId — fallback cuando localStorage
  //      está vacío (sesión nueva, distinto navegador, etc.); solo user/assistant.
  useEffect(() => {
    let cancelled = false;
    setHistoryLoading(true);

    // Intento 1: localStorage (historial completo de UI)
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

    // Intento 2: backend (solo user/assistant, sin action/deep_search)
    fetch(`${API_BASE}/api/agent/chat/history/${encodeURIComponent(sessionId)}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then((data: { messages: ChatMsg[] }) => {
        if (!cancelled && data.messages.length > 0) {
          setMessages(data.messages);
          // Persistir en localStorage para futuros remounts sin fetch
          localStorage.setItem(uiHistoryKey(sessionId), JSON.stringify(data.messages));
        }
      })
      .catch(() => { /* sin historial previo — arrancar limpio */ })
      .finally(() => { if (!cancelled) setHistoryLoading(false); });

    return () => { cancelled = true; };
  }, [sessionId]);

  // ── Persistir historial UI en localStorage cada vez que cambia messages ──────
  // Guarda todos los roles (incluido action/deep_search) para que sobrevivan
  // cambios de pestaña sin llamada al backend.
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

  // ── Reset de conversación ─────────────────────────────────────────────────────
  // Limpia el historial visible, genera un nuevo sessionId y lo persiste en
  // localStorage. El historial backend del sessionId anterior queda huérfano
  // (no se borra — no molesta que queden filas en la DB).
  function resetConversation() {
    if (messages.length > 0 && !window.confirm('¿Borrar la conversación actual y empezar de cero?')) return;
    // Limpiar UI history del sessionId viejo
    localStorage.removeItem(uiHistoryKey(sessionId));
    // Nuevo sessionId (se persiste automáticamente en getOrCreateSessionId/createFreshSessionId)
    const newId = createFreshSessionId(repo);
    // Reset de todo el estado de UI
    setSessionId(newId);
    setMessages([]);
    setPendingPatch(null);
    setForceGroq(false);
  }

  async function sendMessage() {
    if (!input.trim() || streaming) return;
    const userMsg = input;
    // Capturar y resetear forceGroq ANTES del envío — aplica solo a este mensaje
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0a0a0f' }}>
      <div style={{ borderBottom: '1px solid #222', display: 'flex', alignItems: 'center' }}>
        <div style={{ flex: 1 }}>
          <ProjectSwitcher activeProject={activeProject} onSwitch={onProjectChange} />
        </div>
        <div style={{ padding: '0 16px', color: '#a78bfa', fontWeight: 600, fontSize: 13, flexShrink: 0 }}>
          💬 BROUS
        </div>
        {/* Botón reiniciar conversación */}
        <button
          onClick={resetConversation}
          disabled={streaming}
          title="Reiniciar conversación — borra el historial visible y empieza de cero"
          style={{
            flexShrink: 0,
            marginRight: 12,
            background: 'transparent',
            border: '1px solid #333',
            borderRadius: '6px',
            color: '#6b7280',
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
              e.currentTarget.style.borderColor = '#ef4444';
              e.currentTarget.style.color = '#ef4444';
            }
          }}
          onMouseLeave={e => {
            e.currentTarget.style.borderColor = '#333';
            e.currentTarget.style.color = '#6b7280';
          }}
        >
          <span style={{ fontSize: '12px' }}>↺</span>
          <span>Reiniciar</span>
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {historyLoading && (
          <div style={{ color: '#6b7280', fontSize: '13px', alignSelf: 'center', marginTop: '8px' }}>
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
                background: 'linear-gradient(90deg, #1e1040 0%, #2d1060 100%)',
                border: '1px solid #7c3aed',
                color: '#c4b5fd',
                letterSpacing: '0.02em',
              }}>
                <span style={{ fontSize: '14px' }}>🔭</span>
                <span>DEEP</span>
                <span style={{ color: '#a78bfa', fontWeight: 400, maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.text}
                </span>
              </div>
            ) : (
              <div style={{
                padding: '8px 12px',
                borderRadius: '10px',
                fontSize: m.role === 'action' ? '13px' : '15px',
                background: m.role === 'user' ? '#6d28d9' : m.role === 'action' ? 'transparent' : '#1a1a24',
                color: m.role === 'action' ? '#38bdf8' : '#e5e7eb',
                opacity: m.role === 'action' ? 0.8 : 1,
              }}>
                {m.text}
              </div>
            )}
          </div>
        ))}

        {pendingPatch && (
          <div style={{ border: '1px solid #7c3aed', borderRadius: '10px', padding: '12px', background: '#141420' }}>
            <div style={{ color: '#c4b5fd', fontSize: '13px', marginBottom: '4px' }}>📝 {pendingPatch.path}</div>
            <div style={{ color: '#9ca3af', fontSize: '13px', marginBottom: '10px' }}>{pendingPatch.reasoning}</div>
            <details style={{ marginBottom: '10px' }}>
              <summary style={{ color: '#818cf8', fontSize: '12px', cursor: 'pointer' }}>Ver diff</summary>
              <pre style={{ fontSize: '11px', color: '#f87171', whiteSpace: 'pre-wrap', marginTop: '6px' }}>- {pendingPatch.old_str}</pre>
              <pre style={{ fontSize: '11px', color: '#4ade80', whiteSpace: 'pre-wrap' }}>+ {pendingPatch.new_str}</pre>
            </details>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={approvePatch} style={{ background: '#16a34a', color: 'white', border: 'none', padding: '6px 14px', borderRadius: '6px', fontSize: '13px' }}>✅ Aplicar</button>
              <button onClick={() => setPendingPatch(null)} style={{ background: '#dc2626', color: 'white', border: 'none', padding: '6px 14px', borderRadius: '6px', fontSize: '13px' }}>❌ Rechazar</button>
            </div>
          </div>
        )}

        {streaming && <div style={{ color: '#6b7280', fontSize: '13px' }}>Quark está pensando...</div>}
        <div ref={bottomRef} />
      </div>
      <div style={{ borderTop: '1px solid #222', padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {/* Modo rápido indicator — visible solo cuando está activo */}
        {forceGroq && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            fontSize: '11px', color: '#fbbf24',
            fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.04em',
          }}>
            <span>⚡</span>
            <span>Modo rápido activado — próximo mensaje va directo a Groq</span>
          </div>
        )}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
          {/* Toggle "Modo rápido" — fuerza Groq para el próximo mensaje solamente */}
          <button
            onClick={() => setForceGroq(v => !v)}
            disabled={streaming}
            title={forceGroq ? 'Modo rápido activo — click para desactivar' : 'Activar modo rápido (Groq directo para este mensaje)'}
            style={{
              flexShrink: 0,
              background: forceGroq ? 'rgba(251,191,36,0.18)' : 'rgba(255,255,255,0.04)',
              border: forceGroq ? '1px solid #fbbf24' : '1px solid #333',
              borderRadius: '8px',
              color: forceGroq ? '#fbbf24' : '#6b7280',
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
              background: '#141420',
              color: 'white',
              border: '1px solid #333',
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
              style={{ background: '#dc2626', color: 'white', border: 'none', borderRadius: '8px', padding: '0 18px', fontSize: '15px', height: '40px', flexShrink: 0, cursor: 'pointer' }}
            >
              ⏸️
            </button>
          ) : (
            <button
              onClick={sendMessage}
              disabled={!input.trim()}
              title="Enviar mensaje"
              style={{ background: '#7c3aed', color: 'white', border: 'none', borderRadius: '8px', padding: '0 18px', fontSize: '15px', height: '40px', flexShrink: 0, cursor: input.trim() ? 'pointer' : 'not-allowed', opacity: input.trim() ? 1 : 0.5 }}
            >
              ➤
            </button>
          )}
        </div>
      </div>
    </div>
  );
}