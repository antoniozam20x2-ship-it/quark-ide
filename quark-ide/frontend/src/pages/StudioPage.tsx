import { useState, useEffect } from 'react'

const API_BASE = (import.meta.env.VITE_API_URL ?? window.location.origin).replace(/\/$/, '')

interface Props {
  initialBrief?: string
  onBriefConsumed?: () => void
  onSendToAgent?: (prompt: string) => void
}

interface AgentResult {
  role: 'architect' | 'designer' | 'qa' | 'engineer'
  label: string
  icon: string
  color: string
  content: string
  status: 'idle' | 'thinking' | 'done' | 'error'
}

const AGENTS: AgentResult[] = [
  { role: 'architect', label: 'Director Creativo', icon: '🎭', color: '#7C3AED', content: '', status: 'idle' },
  { role: 'designer',  label: 'Designer',          icon: '🎨', color: '#06B6D4', content: '', status: 'idle' },
  { role: 'qa',        label: 'Critic',            icon: '🔍', color: '#F59E0B', content: '', status: 'idle' },
  { role: 'engineer',  label: 'Engineer',          icon: '⚙️', color: '#10B981', content: '', status: 'idle' },
]

export default function StudioPage({ initialBrief, onBriefConsumed }: Props) {
  const [brief, setBrief] = useState('')
  const [agents, setAgents] = useState<AgentResult[]>(AGENTS)
  const [running, setRunning] = useState(false)
  const [engineeredPrompt, setEngineeredPrompt] = useState('')
  const [designPrototype, setDesignPrototype] = useState<string>('')
  const [fullscreenPreview, setFullscreenPreview] = useState(false)

  useEffect(() => {
    if (initialBrief) {
      setBrief(initialBrief)
      onBriefConsumed?.()
      runStudio(initialBrief)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialBrief])

  function updateAgent(role: string, update: Partial<AgentResult>) {
    setAgents(prev => prev.map(a => a.role === role ? { ...a, ...update } : a))
  }

  async function runStudio(text?: string) {
    const input = (text ?? brief).trim()
    if (!input || running) return

    setRunning(true)
    setEngineeredPrompt('')
    setDesignPrototype('')
    setAgents(AGENTS.map(a => ({ ...a, content: '', status: 'idle' })))

    let architectResult = ''
    let finalHtml = ''

    // ── Step 1: Architect (Director Creativo) ──────────────────────────────────
    updateAgent('architect', { status: 'thinking' })
    try {
      const res = await fetch(`${API_BASE}/api/studio/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief: input, role: 'architect' }),
      })
      const data = await res.json()
      architectResult = data.result ?? ''
      updateAgent('architect', { content: architectResult, status: 'done' })
    } catch {
      updateAgent('architect', { status: 'error', content: 'Error al analizar' })
    }

    // ── Step 2: Designer ───────────────────────────────────────────────────────
    updateAgent('designer', { status: 'thinking' })
    try {
      const res = await fetch(`${API_BASE}/api/studio/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief: input, role: 'designer', architectResult }),
      })
      const data = await res.json()
      finalHtml = data.result ?? ''
      setDesignPrototype(finalHtml)
      updateAgent('designer', { content: finalHtml, status: 'done' })
    } catch {
      updateAgent('designer', { status: 'error', content: 'Error al generar prototipo' })
    }

    // ── Step 3: Critic ─────────────────────────────────────────────────────────
    updateAgent('qa', { status: 'thinking' })
    try {
      const res = await fetch(`${API_BASE}/api/studio/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief: input, role: 'qa', architectResult, designerResult: finalHtml }),
      })
      const data = await res.json()
      const criticNote = data.result ?? ''
      if (data.revisedHtml) {
        finalHtml = data.revisedHtml
        setDesignPrototype(finalHtml)
      }
      updateAgent('qa', { content: criticNote, status: 'done' })
    } catch {
      updateAgent('qa', { status: 'error', content: 'Error en crítica' })
    }

    // ── Step 4: Engineer ───────────────────────────────────────────────────────
    updateAgent('engineer', { status: 'thinking' })
    try {
      const res = await fetch(`${API_BASE}/api/studio/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief: input, role: 'engineer', architectResult, designerResult: finalHtml }),
      })
      const data = await res.json()
      const spec = data.result ?? ''
      setEngineeredPrompt(spec)
      updateAgent('engineer', { content: spec, status: 'done' })
    } catch {
      updateAgent('engineer', { status: 'error', content: 'Error al generar spec' })
    }

    setRunning(false)
  }

  const mono = 'JetBrains Mono, monospace'

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#0A0A0F' }}>

      {/* Header */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #1E1E2E', background: '#12121A', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 16 }}>🎨</span>
        <span style={{ fontFamily: mono, fontSize: 12, fontWeight: 700, color: '#7C3AED', letterSpacing: '0.08em' }}>QUARK STUDIO</span>
        <span style={{ fontFamily: mono, fontSize: 10, color: '#64748B' }}>// design → build pipeline</span>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* Input */}
        <div style={{ background: '#12121A', border: '1px solid #1E1E2E', borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ fontFamily: mono, fontSize: 10, color: '#64748B' }}>// describe lo que quieres construir</span>
          <textarea
            value={brief}
            onChange={e => setBrief(e.target.value)}
            placeholder="Ej: Una página de tienda con productos, carrito y checkout. Fondo oscuro, estilo moderno."
            rows={3}
            style={{ background: 'transparent', border: 'none', outline: 'none', color: '#E2E8F0', fontFamily: mono, fontSize: 12, resize: 'none', lineHeight: 1.6 }}
          />
          <button
            onClick={() => runStudio()}
            disabled={running || !brief.trim()}
            style={{
              alignSelf: 'flex-end', padding: '8px 16px',
              background: running ? '#1E1E2E' : 'linear-gradient(135deg, #7C3AED, #6D28D9)',
              border: 'none', borderRadius: 8,
              color: running ? '#64748B' : '#fff',
              fontFamily: mono, fontSize: 11, fontWeight: 700,
              cursor: running ? 'not-allowed' : 'pointer',
            }}
          >
            {running ? '⏳ Analizando...' : '⚡ Analizar'}
          </button>
        </div>

        {/* Agent cards */}
        {agents.map(agent => agent.status !== 'idle' && (
          <div
            key={agent.role}
            style={{
              background: '#12121A',
              border: `1px solid ${agent.status === 'done' ? agent.color + '44' : '#1E1E2E'}`,
              borderLeft: `3px solid ${agent.color}`,
              borderRadius: 12,
              overflow: 'hidden',
            }}
          >
            {/* Card header */}
            <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>{agent.icon}</span>
              <span style={{ fontFamily: mono, fontSize: 11, fontWeight: 700, color: agent.color }}>{agent.label}</span>
              {agent.status === 'thinking' && (
                <span style={{ fontFamily: mono, fontSize: 10, color: '#64748B' }}>analizando...</span>
              )}
              {agent.status === 'done' && (
                <span style={{ fontSize: 10, color: agent.color }}>✓</span>
              )}
            </div>

            {/* Card body */}
            {(agent.status === 'done' || agent.status === 'error') && agent.content && (
              <div style={{ padding: '0 12px 12px' }}>

                {/* Designer — iframe preview */}
                {agent.role === 'designer' && designPrototype ? (
                  <div>
                    <div style={{ fontFamily: mono, fontSize: 10, color: '#64748B', marginBottom: 8 }}>
                      // prototipo visual
                    </div>
                    <div
                      style={{ position: 'relative', cursor: 'pointer' }}
                      onClick={() => setFullscreenPreview(true)}
                      title="Ver en pantalla completa"
                    >
                      <iframe
                        srcDoc={designPrototype}
                        style={{ width: '100%', height: 320, border: '1px solid #1E1E2E', borderRadius: 8, background: '#000', pointerEvents: 'none' }}
                        sandbox="allow-scripts"
                        title="Design Prototype"
                      />
                      <div style={{
                        position: 'absolute', top: 8, right: 8,
                        background: 'rgba(0,0,0,0.6)', borderRadius: 4, padding: '4px 8px',
                        fontSize: 11, color: '#aaa', fontFamily: mono, pointerEvents: 'none',
                      }}>
                        ⛶ expandir
                      </div>
                    </div>
                    <button
                      onClick={() => setDesignPrototype('')}
                      style={{ marginTop: 8, background: 'transparent', border: '1px solid #1E1E2E', borderRadius: 6, color: '#64748B', fontFamily: mono, fontSize: 10, padding: '4px 10px', cursor: 'pointer' }}
                    >
                      ver código
                    </button>
                  </div>

                ) : agent.role === 'qa' ? (
                  /* Critic — green for APROBADO, amber for REVISAR */
                  <div style={{
                    fontFamily: mono, fontSize: 11, lineHeight: 1.7, whiteSpace: 'pre-wrap',
                    color: agent.content.trim().startsWith('APROBADO') ? '#00ff88' : '#F59E0B',
                  }}>
                    {agent.content}
                  </div>

                ) : (
                  /* Architect + Engineer — plain text */
                  <div style={{ fontFamily: mono, fontSize: 11, color: '#94A3B8', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
                    {agent.content}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Footer */}
      <div style={{ padding: '10px 14px', borderTop: '1px solid #1E1E2E', background: '#12121A', fontFamily: mono, fontSize: 10, color: '#64748B', textAlign: 'center' }}>
        Director Creativo → Designer → Critic → Engineer
      </div>

      {/* Fullscreen modal */}
      {fullscreenPreview && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          zIndex: 9999, background: '#000',
          display: 'flex', flexDirection: 'column',
        }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.1)',
            background: '#0a0a0a',
          }}>
            <span style={{ color: '#888', fontSize: 12, fontFamily: mono }}>// preview — Designer</span>
            <button
              onClick={() => setFullscreenPreview(false)}
              style={{
                background: 'none', border: '1px solid rgba(255,255,255,0.2)',
                color: '#fff', borderRadius: 4, padding: '4px 12px',
                cursor: 'pointer', fontSize: 12, fontFamily: mono,
              }}
            >
              ✕ cerrar
            </button>
          </div>
          <iframe
            srcDoc={designPrototype}
            style={{ flex: 1, border: 'none', width: '100%' }}
            sandbox="allow-scripts"
            title="Studio Preview Fullscreen"
          />
        </div>
      )}
    </div>
  )
}
