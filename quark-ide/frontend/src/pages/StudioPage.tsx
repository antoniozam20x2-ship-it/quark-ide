import { useState, useEffect } from 'react'

const API_BASE = (import.meta.env.VITE_API_URL ?? window.location.origin).replace(/\/$/, '')

interface Props {
  initialBrief?: string
  onBriefConsumed?: () => void
  onSendToAgent?: (prompt: string) => void
}

interface AgentResult {
  role: 'architect' | 'designer' | 'engineer' | 'qa'
  label: string
  icon: string
  color: string
  content: string
  status: 'idle' | 'thinking' | 'done' | 'error'
}

const AGENTS: AgentResult[] = [
  { role: 'architect', label: 'Architect', icon: '🏗', color: '#7C3AED', content: '', status: 'idle' },
  { role: 'designer',  label: 'Designer',  icon: '🎨', color: '#06B6D4', content: '', status: 'idle' },
  { role: 'engineer',  label: 'Engineer',  icon: '⚙️', color: '#10B981', content: '', status: 'idle' },
  { role: 'qa',        label: 'QA',        icon: '🔍', color: '#F59E0B', content: '', status: 'idle' },
]

export default function StudioPage({ initialBrief, onBriefConsumed, onSendToAgent }: Props) {
  const [brief, setBrief] = useState('')
  const [agents, setAgents] = useState<AgentResult[]>(AGENTS)
  const [running, setRunning] = useState(false)
  const [engineeredPrompt, setEngineeredPrompt] = useState('')
  const [designPrototype, setDesignPrototype] = useState<string>('')

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
    setAgents(AGENTS.map(a => ({ ...a, content: '', status: 'idle' })))

    const roles = ['architect', 'designer', 'engineer', 'qa']

    for (const role of roles) {
      updateAgent(role, { status: 'thinking' })
      try {
        const res = await fetch(`${API_BASE}/api/studio/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brief: input, role })
        })
        const data = await res.json()
        updateAgent(role, { content: data.result, status: 'done' })
        if (role === 'designer') {
          setDesignPrototype(data.result ?? '')
        }
        if (role === 'engineer') {
          console.log('Engineer result:', data.result)
          setEngineeredPrompt(data.result ?? '')
        }
      } catch {
        updateAgent(role, { status: 'error', content: 'Error al analizar' })
      }
    }
    setRunning(false)
  }

  const mono = 'JetBrains Mono, monospace'
  const allDone = agents.every(a => a.status === 'done' || a.status === 'error')

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
            style={{ alignSelf: 'flex-end', padding: '8px 16px', background: running ? '#1E1E2E' : 'linear-gradient(135deg, #7C3AED, #6D28D9)', border: 'none', borderRadius: 8, color: running ? '#64748B' : '#fff', fontFamily: mono, fontSize: 11, fontWeight: 700, cursor: running ? 'not-allowed' : 'pointer' }}
          >
            {running ? '⏳ Analizando...' : '⚡ Analizar'}
          </button>
        </div>

        {/* Agents */}
        {agents.map(agent => agent.status !== 'idle' && (
          <div key={agent.role} style={{ background: '#12121A', border: `1px solid ${agent.status === 'done' ? agent.color + '44' : '#1E1E2E'}`, borderLeft: `3px solid ${agent.color}`, borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>{agent.icon}</span>
              <span style={{ fontFamily: mono, fontSize: 11, fontWeight: 700, color: agent.color }}>{agent.label}</span>
              {agent.status === 'thinking' && <span style={{ fontFamily: mono, fontSize: 10, color: '#64748B' }}>analizando...</span>}
              {agent.status === 'done' && <span style={{ fontSize: 10, color: agent.color }}>✓</span>}
            </div>
            {(agent.status === 'done' || agent.status === 'error') && agent.content && (
              <div style={{ padding: '0 12px 12px' }}>
                {agent.role === 'designer' && designPrototype ? (
                  <div>
                    <div style={{ fontFamily: mono, fontSize: 10, color: '#64748B', marginBottom: 8 }}>
                      // prototipo visual
                    </div>
                    <iframe
                      srcDoc={designPrototype}
                      style={{
                        width: '100%',
                        height: 320,
                        border: '1px solid #1E1E2E',
                        borderRadius: 8,
                        background: '#000',
                      }}
                      sandbox="allow-scripts"
                      title="Design Prototype"
                    />
                    <button
                      onClick={() => setDesignPrototype('')}
                      style={{ marginTop: 8, background: 'transparent', border: '1px solid #1E1E2E', borderRadius: 6, color: '#64748B', fontFamily: mono, fontSize: 10, padding: '4px 10px', cursor: 'pointer' }}
                    >
                      ver código
                    </button>
                  </div>
                ) : (
                  <div style={{ fontFamily: mono, fontSize: 11, color: '#94A3B8', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
                    {agent.content}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {/* Send to Agent button */}
        {allDone && onSendToAgent && (
          <button
            onClick={() => onSendToAgent(engineeredPrompt || brief)}
            style={{ width: '100%', padding: '14px 16px', background: 'linear-gradient(135deg, #7C3AED, #6D28D9)', border: 'none', borderRadius: 10, color: '#fff', fontFamily: mono, fontSize: 13, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
          >
            ⚡ Enviar al Agent → construir
          </button>
        )}
      </div>

      {/* Footer */}
      <div style={{ padding: '10px 14px', borderTop: '1px solid #1E1E2E', background: '#12121A', fontFamily: mono, fontSize: 10, color: '#64748B', textAlign: 'center' }}>
        Chat → Studio → Agent → Preview → Commit
      </div>
    </div>
  )
}
