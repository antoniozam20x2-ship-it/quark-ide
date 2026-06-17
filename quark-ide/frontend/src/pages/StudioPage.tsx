import { useState, useEffect } from 'react'

const API_BASE = (import.meta.env.VITE_API_URL ?? window.location.origin).replace(/\/$/, '')

const STORAGE_KEY = 'quark_studio_state'

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

function loadState(): { brief: string; agents: AgentResult[]; designPrototype: string } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function saveState(brief: string, agents: AgentResult[], designPrototype: string) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ brief, agents, designPrototype }))
  } catch {}
}

export default function StudioPage({ initialBrief, onBriefConsumed }: Props) {
  const saved = loadState()

  const [brief, setBrief] = useState(saved?.brief ?? '')
  const [agents, setAgents] = useState<AgentResult[]>(saved?.agents ?? AGENTS)
  const [running, setRunning] = useState(false)
  const [designPrototype, setDesignPrototype] = useState<string>(saved?.designPrototype ?? '')
  const [fullscreenPreview, setFullscreenPreview] = useState(false)
  const [expandedCards, setExpandedCards] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (initialBrief) {
      setBrief(initialBrief)
      onBriefConsumed?.()
      runStudio(initialBrief)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialBrief])

  function toggleCard(role: string) {
    setExpandedCards(prev => ({ ...prev, [role]: !prev[role] }))
  }

  function updateAgent(role: string, update: Partial<AgentResult>) {
    setAgents(prev => {
      const next = prev.map(a => a.role === role ? { ...a, ...update } : a)
      return next
    })
  }

  async function runStudio(text?: string) {
    const input = (text ?? brief).trim()
    if (!input || running) return

    setRunning(true)
    setDesignPrototype('')
    setExpandedCards({})
    const freshAgents = AGENTS.map(a => ({ ...a, content: '', status: 'idle' as const }))
    setAgents(freshAgents)
    saveState(input, freshAgents, '')

    let architectResult = ''
    let finalHtml = ''

    // ── Step 1: Architect ──────────────────────────────────────────────────────
    updateAgent('architect', { status: 'thinking' })
    try {
      const res = await fetch(`${API_BASE}/api/studio/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief: input, role: 'architect' }),
      })
      const data = await res.json()
      architectResult = data.result ?? ''
      setAgents(prev => {
        const next = prev.map(a => a.role === 'architect' ? { ...a, content: architectResult, status: 'done' as const } : a)
        saveState(input, next, '')
        return next
      })
      setExpandedCards(prev => ({ ...prev, architect: true }))
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
      setAgents(prev => {
        const next = prev.map(a => a.role === 'designer' ? { ...a, content: finalHtml, status: 'done' as const } : a)
        saveState(input, next, finalHtml)
        return next
      })
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
      setAgents(prev => {
        const next = prev.map(a => a.role === 'qa' ? { ...a, content: criticNote, status: 'done' as const } : a)
        saveState(input, next, finalHtml)
        return next
      })
      setExpandedCards(prev => ({ ...prev, qa: true }))
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
      setAgents(prev => {
        const next = prev.map(a => a.role === 'engineer' ? { ...a, content: spec, status: 'done' as const } : a)
        saveState(input, next, finalHtml)
        return next
      })
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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            {agents.some(a => a.status === 'done') && (
              <button
                onClick={() => {
                  setBrief('')
                  setAgents(AGENTS.map(a => ({ ...a, content: '', status: 'idle' })))
                  setDesignPrototype('')
                  setExpandedCards({})
                  localStorage.removeItem(STORAGE_KEY)
                }}
                style={{ background: 'transparent', border: '1px solid #1E1E2E', borderRadius: 6, color: '#64748B', fontFamily: mono, fontSize: 10, padding: '4px 10px', cursor: 'pointer' }}
              >
                ✕ limpiar
              </button>
            )}
            <button
              onClick={() => runStudio()}
              disabled={running || !brief.trim()}
              style={{
                marginLeft: 'auto',
                padding: '8px 16px',
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
            {/* Card header — clickable para todas las cards excepto Designer */}
            <div
              onClick={() => agent.status === 'done' && agent.role !== 'designer' && toggleCard(agent.role)}
              style={{
                padding: '10px 12px',
                display: 'flex', alignItems: 'center', gap: 8,
                cursor: agent.status === 'done' && agent.role !== 'designer' ? 'pointer' : 'default',
                userSelect: 'none',
              }}
            >
              <span>{agent.icon}</span>
              <span style={{ fontFamily: mono, fontSize: 11, fontWeight: 700, color: agent.color }}>{agent.label}</span>
              {agent.status === 'thinking' && (
                <span style={{ fontFamily: mono, fontSize: 10, color: '#64748B' }}>analizando...</span>
              )}
              {agent.status === 'done' && (
                <span style={{ fontSize: 10, color: agent.color }}>✓</span>
              )}
              {/* Toggle indicator para cards no-Designer */}
              {agent.status === 'done' && agent.role !== 'designer' && (
                <span style={{ marginLeft: 'auto', fontFamily: mono, fontSize: 10, color: '#64748B' }}>
                  {expandedCards[agent.role] ? '▲ cerrar' : '▼ ver'}
                </span>
              )}
              {/* Critic badge inline */}
              {agent.role === 'qa' && agent.status === 'done' && agent.content && (
                <span style={{
                  marginLeft: 0,
                  fontFamily: mono, fontSize: 10, fontWeight: 700,
                  color: agent.content.trim().startsWith('APROBADO') ? '#00ff88' : '#F59E0B',
                }}>
                  {agent.content.trim().startsWith('APROBADO') ? '● APROBADO' : '● REVISAR'}
                </span>
              )}
            </div>

            {/* Card body */}
            {(agent.status === 'done' || agent.status === 'error') && agent.content && (
              <div style={{ padding: '0 12px 12px' }}>

                {/* Designer — siempre visible con iframe */}
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
                        style={{ width: '100%', height: 480, border: '1px solid #1E1E2E', borderRadius: 8, background: '#fff', pointerEvents: 'none' }}
                        sandbox="allow-scripts allow-same-origin"
                        title="Design Prototype"
                      />
                      <div style={{
                        position: 'absolute', top: 8, right: 8,
                        background: 'rgba(0,0,0,0.7)', borderRadius: 4, padding: '4px 8px',
                        fontSize: 11, color: '#ccc', fontFamily: mono, pointerEvents: 'none',
                      }}>
                        ⛶ expandir
                      </div>
                    </div>
                  </div>

                ) : agent.role === 'qa' && expandedCards['qa'] ? (
                  /* Critic — expandible, verde/ámbar */
                  <div style={{
                    fontFamily: mono, fontSize: 11, lineHeight: 1.7, whiteSpace: 'pre-wrap',
                    color: agent.content.trim().startsWith('APROBADO') ? '#00ff88' : '#F59E0B',
                    paddingTop: 4,
                  }}>
                    {agent.content}
                  </div>

                ) : agent.role !== 'qa' && expandedCards[agent.role] ? (
                  /* Architect + Engineer — expandibles */
                  <div style={{ fontFamily: mono, fontSize: 11, color: '#94A3B8', lineHeight: 1.7, whiteSpace: 'pre-wrap', paddingTop: 4 }}>
                    {agent.content}
                  </div>

                ) : null}
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
            padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.1)',
            background: '#0a0a0a',
            minHeight: 52,
          }}>
            <span style={{ color: '#888', fontSize: 12, fontFamily: mono }}>// preview — Designer</span>
            <button
              onClick={() => setFullscreenPreview(false)}
              style={{
                background: 'none', border: '1px solid rgba(255,255,255,0.2)',
                color: '#fff', borderRadius: 4, padding: '6px 16px',
                cursor: 'pointer', fontSize: 12, fontFamily: mono,
              }}
            >
              ✕ cerrar
            </button>
          </div>
          <iframe
            srcDoc={designPrototype}
            style={{ flex: 1, border: 'none', width: '100%' }}
            sandbox="allow-scripts allow-same-origin"
            title="Studio Preview Fullscreen"
          />
        </div>
      )}
    </div>
  )
}
