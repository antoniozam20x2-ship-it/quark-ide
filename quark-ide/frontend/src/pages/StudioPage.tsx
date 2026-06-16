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
  const [studioHtml, setStudioHtml] = useState<string>('')
  const [buildLoading, setBuildLoading] = useState(false)

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
    setStudioHtml('')
    setAgents(AGENTS.map(a => ({ ...a, content: '', status: 'idle' })))

    const roles = ['architect', 'designer', 'engineer', 'qa']
    const results: Record<string, string> = {}

    for (const role of roles) {
      updateAgent(role, { status: 'thinking' })
      try {
        const body: Record<string, string> = { brief: input, role }
        if (role === 'engineer') {
          body.architectResult = results['architect'] ?? ''
          body.designerResult  = results['designer']  ?? ''
        }
        const res = await fetch(`${API_BASE}/api/studio/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })
        const data = await res.json()
        results[role] = data.result ?? ''
        updateAgent(role, { content: data.result, status: 'done' })
        if (role === 'designer') {
          setDesignPrototype(data.result ?? '')
        }
        if (role === 'engineer') {
          setEngineeredPrompt(data.result ?? '')
        }
      } catch {
        updateAgent(role, { status: 'error', content: 'Error al analizar' })
      }
    }
    setRunning(false)
  }

  // /api/agent/generate streams SSE — read until the 'done' event to get mainContent
  async function buildAndPreview() {
    if (!engineeredPrompt) return
    setBuildLoading(true)
    setStudioHtml('')

    try {
      const genRes = await fetch(`${API_BASE}/api/agent/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: engineeredPrompt, repo: 'none' })
      })

      if (!genRes.body) throw new Error('No response body from /api/agent/generate')

      const reader  = genRes.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let generatedCode = ''

      outer: while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const raw = trimmed.slice(5).trim()
          try {
            const json = JSON.parse(raw)
            if (json.event === 'done') {
              generatedCode = json.mainContent ?? ''
              break outer
            }
          } catch { /* ignore malformed SSE lines */ }
        }
      }

      if (!generatedCode) throw new Error('El Agent no generó código (mainContent vacío)')

      const htmlRes = await fetch(`${API_BASE}/api/agent/generate-html`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: generatedCode })
      })
      const htmlData = await htmlRes.json() as { html?: string; success: boolean; error?: string }
      if (!htmlData.success) throw new Error(htmlData.error ?? 'generate-html falló')
      setStudioHtml(htmlData.html ?? '')
    } catch (err) {
      console.error('[Studio] buildAndPreview error:', err)
    } finally {
      setBuildLoading(false)
    }
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
                      style={{ width: '100%', height: 320, border: '1px solid #1E1E2E', borderRadius: 8, background: '#000' }}
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

        {/* Build & Preview button */}
        {allDone && engineeredPrompt && (
          <button
            onClick={buildAndPreview}
            disabled={buildLoading}
            style={{
              width: '100%',
              padding: '14px 16px',
              background: buildLoading ? '#1E1E2E' : 'linear-gradient(135deg, #7C3AED, #6D28D9)',
              border: 'none',
              borderRadius: 10,
              color: buildLoading ? '#64748B' : '#fff',
              fontFamily: mono,
              fontSize: 13,
              fontWeight: 700,
              cursor: buildLoading ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            {buildLoading ? '⚡ Construyendo...' : '⚡ Construir y Previsualizar'}
          </button>
        )}

        {/* Studio Preview */}
        {studioHtml && (
          <div style={{
            marginTop: 4,
            borderRadius: 8,
            overflow: 'hidden',
            border: '1px solid rgba(255,255,255,0.1)',
          }}>
            <div style={{
              padding: '8px 12px',
              fontSize: 11,
              fontFamily: mono,
              color: '#64748B',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              background: '#12121A',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}>
              <span>// preview</span>
              <button
                onClick={() => setStudioHtml('')}
                style={{ background: 'transparent', border: 'none', color: '#3a3a5c', fontFamily: mono, fontSize: 10, cursor: 'pointer', padding: '2px 6px' }}
              >
                ✕ cerrar
              </button>
            </div>
            <iframe
              srcDoc={studioHtml}
              style={{ width: '100%', height: 500, border: 'none' }}
              sandbox="allow-scripts"
              title="Studio Preview"
            />
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{ padding: '10px 14px', borderTop: '1px solid #1E1E2E', background: '#12121A', fontFamily: mono, fontSize: 10, color: '#64748B', textAlign: 'center' }}>
        Chat → Studio → Agent → Preview → Commit
      </div>
    </div>
  )
}
