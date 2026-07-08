import { useState, useRef, useEffect } from 'react';

interface ChatMsg {
  role: 'user' | 'assistant' | 'action';
  text: string;
}

interface PendingPatch {
  path: string;
  old_str: string;
  new_str: string;
  reasoning: string;
}

export default function QuarkChat({ repo }: { repo: string }) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [pendingPatch, setPendingPatch] = useState<PendingPatch | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [sessionId] = useState(() => `session-${Date.now()}`);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, pendingPatch]);

  async function sendMessage() {
    if (!input.trim() || streaming) return;
    const userMsg = input;
    setMessages(m => [...m, { role: 'user', text: userMsg }]);
    setInput('');
    setStreaming(true);

    try {
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMsg, repo, sessionId }),
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
      setMessages(m => [...m, { role: 'action', text: `❌ Error de conexión: ${err instanceof Error ? err.message : String(err)}` }]);
    } finally {
      setStreaming(false);
    }
  }

  async function approvePatch() {
    if (!pendingPatch) return;
    setMessages(m => [...m, { role: 'action', text: `⏳ Aplicando patch en ${pendingPatch.path}...` }]);
    try {
      const res = await fetch('/api/agent/apply-patch', {
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
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #222', color: '#a78bfa', fontWeight: 600 }}>
        💬 QUARK CHAT — {repo}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {messages.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
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
      <div style={{ display: 'flex', padding: '10px', borderTop: '1px solid #222', gap: '8px' }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && sendMessage()}
          placeholder="Escribe un mensaje..."
          disabled={streaming}
          style={{ flex: 1, background: '#141420', color: 'white', border: '1px solid #333', borderRadius: '8px', padding: '10px 12px', fontSize: '15px' }}
        />
        <button onClick={sendMessage} disabled={streaming} style={{ background: '#7c3aed', color: 'white', border: 'none', borderRadius: '8px', padding: '0 18px', fontSize: '15px' }}>➤</button>
      </div>
    </div>
  );
}
