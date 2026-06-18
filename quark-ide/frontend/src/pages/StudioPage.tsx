import { useState, useEffect } from 'react'

const API_BASE = (import.meta.env.VITE_API_URL ?? window.location.origin).replace(/\/$/, '')

const STORAGE_KEY = 'quark_studio_state'

interface StudioProject {
  id: number
  name: string
  folder: string
  html: string
  created_at: string
}

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
  const [fastMode, setFastMode] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [importHtml, setImportHtml] = useState('')
  const [importPreview, setImportPreview] = useState('')

  // Projects state
  const [projects, setProjects] = useState<StudioProject[]>([])
  const [showProjects, setShowProjects] = useState(false)
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({})
  const [showSaveModal, setShowSaveModal] = useState(false)
  const [saveHtmlTarget, setSaveHtmlTarget] = useState<'import' | 'prototype'>('import')
  const [saveName, setSaveName] = useState('')
  const [saveFolder, setSaveFolder] = useState('')
  const [newFolderMode, setNewFolderMode] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'ok' | 'error'>('idle')
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null)
  const [leftCollapsed, setLeftCollapsed] = useState(() => localStorage.getItem('quark_studio_left_collapsed') === 'true')

  // Edit project state
  const [showEditModal, setShowEditModal] = useState(false)
  const [editChanges, setEditChanges] = useState('')
  const [editedHtml, setEditedHtml] = useState('')
  const [editStatus, setEditStatus] = useState<'idle' | 'applying' | 'done' | 'error'>('idle')
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null)
  const [saveEditStatus, setSaveEditStatus] = useState<'idle' | 'saving' | 'ok' | 'error'>('idle')

  useEffect(() => {
    loadProjects()
  }, [])

  useEffect(() => {
    if (initialBrief) {
      setBrief(initialBrief)
      onBriefConsumed?.()
      runStudio(initialBrief)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialBrief])

  async function loadProjects() {
    try {
      const res = await fetch(`${API_BASE}/api/studio/projects`)
      if (res.ok) setProjects(await res.json())
    } catch {}
  }

  function openSaveModal(target: 'import' | 'prototype') {
    setSaveHtmlTarget(target)
    const suggested = target === 'prototype' && brief.trim()
      ? brief.trim().split(/[\n.!?]/)[0].replace(/^(crea|genera|diseña|haz|quiero|necesito|dame)\s+/i, '').trim().slice(0, 50)
      : ''
    setSaveName(suggested)
    setSaveFolder('')
    setNewFolderMode(false)
    setNewFolderName('')
    setSaveStatus('idle')
    setShowSaveModal(true)
  }

  async function saveProject() {
    const html = saveHtmlTarget === 'import' ? importHtml.trim() : designPrototype
    if (!html || !saveName.trim()) return
    const folder = newFolderMode ? newFolderName.trim() || 'Sin carpeta' : saveFolder || 'Sin carpeta'
    setSaveStatus('saving')
    try {
      const res = await fetch(`${API_BASE}/api/studio/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: saveName.trim(), folder, html }),
      })
      if (!res.ok) throw new Error()
      await loadProjects()
      setSaveStatus('ok')
      setTimeout(() => setShowSaveModal(false), 800)
    } catch {
      setSaveStatus('error')
    }
  }

  async function deleteProject(id: number) {
    try {
      await fetch(`${API_BASE}/api/studio/projects/${id}`, { method: 'DELETE' })
      setProjects(prev => prev.filter(p => p.id !== id))
    } catch {}
  }

  async function loadProjectHtml(id: number) {
    try {
      const res = await fetch(`${API_BASE}/api/studio/projects/${id}/html`)
      const data = await res.json()
      if (data.html) {
        setImportHtml(data.html)
        setImportPreview(data.html)
        setShowImport(true)
        setShowProjects(false)
        setActiveProjectId(id)
      }
    } catch {}
  }

  function openEditModal() {
    setEditChanges('')
    setEditedHtml('')
    setEditStatus('idle')
    setSaveEditStatus('idle')
    setShowEditModal(true)
  }

  async function applyEdits() {
    if (!editChanges.trim() || !importHtml.trim()) return
    setEditStatus('applying')
    setEditedHtml('')
    try {
      const res = await fetch(`${API_BASE}/api/studio/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: importHtml, changes: editChanges.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setEditedHtml(data.html)
      setEditStatus('done')
      setSaveEditStatus('idle')
    } catch {
      setEditStatus('error')
    }
  }

  async function saveEditedProject() {
    if (!editedHtml || !activeProjectId) return
    setSaveEditStatus('saving')
    try {
      const res = await fetch(`${API_BASE}/api/studio/projects/${activeProjectId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: editedHtml }),
      })
      if (!res.ok) throw new Error()
      setImportHtml(editedHtml)
      setImportPreview(editedHtml)
      setSaveEditStatus('ok')
      setTimeout(() => setShowEditModal(false), 800)
    } catch {
      setSaveEditStatus('error')
    }
  }

  function toggleCard(role: string) {
    setExpandedCards(prev => ({ ...prev, [role]: !prev[role] }))
  }

  function updateAgent(role: string, update: Partial<AgentResult>) {
    setAgents(prev => {
      const next = prev.map(a => a.role === role ? { ...a, ...update } : a)
      return next
    })
  }

  async function runStudio(text?: string, overrideFastMode?: boolean) {
    const input = (text ?? brief).trim()
    if (!input || running) return
    const isFast = overrideFastMode ?? fastMode

    setRunning(true)
    setDesignPrototype('')
    setExpandedCards({})
    const freshAgents = AGENTS.map(a => ({ ...a, content: '', status: 'idle' as const }))
    setAgents(freshAgents)
    saveState(input, freshAgents, '')

    let architectResult = ''
    let finalHtml = ''

    // ── Step 1: Architect (skipped in Fast Mode) ───────────────────────────────
    if (!isFast) {
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
    }

    // ── Step 2: Designer ───────────────────────────────────────────────────────
    updateAgent('designer', { status: 'thinking' })
    try {
      const res = await fetch(`${API_BASE}/api/studio/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief: input, role: 'designer', architectResult, fastMode: isFast }),
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

    // ── Step 3: Critic (skipped in Fast Mode) ─────────────────────────────────
    if (!isFast) {
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
        <button
          onClick={() => {
            const next = !leftCollapsed
            setLeftCollapsed(next)
            localStorage.setItem('quark_studio_left_collapsed', String(next))
          }}
          title={leftCollapsed ? 'Expandir panel izquierdo' : 'Colapsar panel izquierdo'}
          style={{
            marginLeft: 12,
            padding: '4px 9px',
            background: 'transparent',
            border: '1px solid #1E1E2E',
            borderRadius: 6,
            color: '#64748B',
            fontFamily: mono, fontSize: 11, fontWeight: 700,
            cursor: 'pointer',
            lineHeight: 1,
          }}
        >
          {leftCollapsed ? '>>' : '<<'}
        </button>
        <button
          onClick={() => { setShowImport(i => !i); setImportPreview('') }}
          style={{
            marginLeft: 'auto',
            padding: '5px 11px',
            background: showImport ? '#06B6D422' : 'transparent',
            border: `1px solid ${showImport ? '#06B6D4' : '#1E1E2E'}`,
            borderRadius: 7,
            color: showImport ? '#06B6D4' : '#64748B',
            fontFamily: mono, fontSize: 10, fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          📥 Importar
        </button>
      </div>

      {/* Content — 3-column layout */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>

        {/* ── LEFT: Brief + Mis Proyectos ── */}
        <div style={{
          width: leftCollapsed ? 0 : 260, flexShrink: 0,
          borderRight: leftCollapsed ? 'none' : '1px solid #1E1E2E',
          display: 'flex', flexDirection: 'column', overflowY: 'auto',
          padding: leftCollapsed ? 0 : 14, gap: 12,
          overflow: 'hidden',
          transition: 'width 0.2s ease',
        }}>

          {/* Brief input */}
          <div style={{ background: '#12121A', border: '1px solid #1E1E2E', borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontFamily: mono, fontSize: 10, color: '#64748B' }}>// describe lo que quieres construir</span>
            <textarea
              value={brief}
              onChange={e => setBrief(e.target.value)}
              placeholder="Ej: Una página de tienda con productos, carrito y checkout. Fondo oscuro, estilo moderno."
              rows={5}
              style={{ background: 'transparent', border: 'none', outline: 'none', color: '#E2E8F0', fontFamily: mono, fontSize: 12, resize: 'none', lineHeight: 1.6 }}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() => setFastMode(f => !f)}
                  title={fastMode ? 'Fast Mode activo' : 'Activar Fast Mode'}
                  style={{
                    flex: 1, padding: '6px 0',
                    background: fastMode ? '#F59E0B22' : 'transparent',
                    border: `1px solid ${fastMode ? '#F59E0B' : '#1E1E2E'}`,
                    borderRadius: 8,
                    color: fastMode ? '#F59E0B' : '#64748B',
                    fontFamily: mono, fontSize: 10, fontWeight: 700, cursor: 'pointer',
                  }}
                >
                  ⚡ Fast {fastMode ? 'ON' : 'OFF'}
                </button>
                {designPrototype && (
                  <button
                    onClick={() => openSaveModal('prototype')}
                    style={{
                      flex: 1, padding: '6px 0',
                      background: '#10B98122',
                      border: '1px solid #10B981',
                      borderRadius: 8,
                      color: '#10B981',
                      fontFamily: mono, fontSize: 10, fontWeight: 700, cursor: 'pointer',
                    }}
                  >
                    💾 Guardar
                  </button>
                )}
                {agents.some(a => a.status === 'done') && (
                  <button
                    onClick={() => {
                      setBrief('')
                      setAgents(AGENTS.map(a => ({ ...a, content: '', status: 'idle' })))
                      setDesignPrototype('')
                      setExpandedCards({})
                      localStorage.removeItem(STORAGE_KEY)
                    }}
                    style={{ padding: '6px 10px', background: 'transparent', border: '1px solid #1E1E2E', borderRadius: 8, color: '#64748B', fontFamily: mono, fontSize: 10, cursor: 'pointer' }}
                  >
                    ✕
                  </button>
                )}
              </div>
              <button
                onClick={() => runStudio()}
                disabled={running || !brief.trim()}
                style={{
                  padding: '9px 0',
                  background: running ? '#1E1E2E' : 'linear-gradient(135deg, #7C3AED, #6D28D9)',
                  border: 'none', borderRadius: 8,
                  color: running ? '#64748B' : '#fff',
                  fontFamily: mono, fontSize: 11, fontWeight: 700,
                  cursor: running ? 'not-allowed' : 'pointer',
                }}
              >
                {running ? '⏳ Analizando...' : '▶ Analizar'}
              </button>
            </div>
          </div>

          {/* Mis Proyectos */}
          <div style={{ background: '#12121A', border: '1px solid #1E1E2E', borderLeft: '3px solid #10B981', borderRadius: 12, overflow: 'hidden' }}>
            <div
              onClick={() => setShowProjects(p => !p)}
              style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}
            >
              <span style={{ fontFamily: mono, fontSize: 10, color: '#10B981', fontWeight: 700 }}>🗂 MIS PROYECTOS</span>
              <span style={{ fontFamily: mono, fontSize: 10, color: '#64748B' }}>({projects.length})</span>
              <span style={{ marginLeft: 'auto', fontFamily: mono, fontSize: 10, color: '#64748B' }}>{showProjects ? '▲' : '▼'}</span>
            </div>
            {showProjects && (
              <div style={{ padding: '0 12px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {projects.length === 0 ? (
                  <span style={{ fontFamily: mono, fontSize: 10, color: '#64748B' }}>Sin proyectos guardados</span>
                ) : (
                  Object.entries(
                    projects.reduce((acc, p) => { (acc[p.folder] = acc[p.folder] || []).push(p); return acc }, {} as Record<string, StudioProject[]>)
                  ).map(([folder, fps]) => (
                    <div key={folder}>
                      <div
                        onClick={() => setExpandedFolders(ef => ({ ...ef, [folder]: !ef[folder] }))}
                        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 0', cursor: 'pointer', userSelect: 'none' }}
                      >
                        <span style={{ fontFamily: mono, fontSize: 10, color: '#F59E0B' }}>
                          {expandedFolders[folder] ? '📂' : '📁'}
                        </span>
                        <span style={{ fontFamily: mono, fontSize: 10, color: '#F59E0B', fontWeight: 700 }}>{folder}</span>
                        <span style={{ fontFamily: mono, fontSize: 9, color: '#64748B' }}>({fps.length})</span>
                      </div>
                      {expandedFolders[folder] && fps.map(p => (
                        <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 16, paddingBottom: 4, flexWrap: 'wrap' }}>
                          <span style={{ fontFamily: mono, fontSize: 10, color: '#94A3B8', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📄 {p.name}</span>
                          {deleteConfirmId === p.id ? (
                            <>
                              <span style={{ fontFamily: mono, fontSize: 9, color: '#EF4444' }}>¿Eliminar?</span>
                              <button onClick={() => setDeleteConfirmId(null)} style={{ padding: '3px 6px', background: 'transparent', border: '1px solid #1E1E2E', borderRadius: 4, color: '#64748B', fontFamily: mono, fontSize: 9, cursor: 'pointer' }}>No</button>
                              <button onClick={() => { deleteProject(p.id); setDeleteConfirmId(null) }} style={{ padding: '3px 6px', background: '#EF444422', border: '1px solid #EF4444', borderRadius: 4, color: '#EF4444', fontFamily: mono, fontSize: 9, fontWeight: 700, cursor: 'pointer' }}>Sí</button>
                            </>
                          ) : (
                            <>
                              <button onClick={() => loadProjectHtml(p.id)} style={{ padding: '3px 8px', background: '#06B6D422', border: '1px solid #06B6D444', borderRadius: 4, color: '#06B6D4', fontFamily: mono, fontSize: 9, cursor: 'pointer' }}>cargar</button>
                              <button onClick={() => setDeleteConfirmId(p.id)} style={{ padding: '3px 6px', background: 'transparent', border: 'none', color: '#64748B', fontFamily: mono, fontSize: 10, cursor: 'pointer' }}>✕</button>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── CENTER: Pipeline cards ── */}
        <div style={{
          flex: 1, minWidth: 0,
          overflowY: 'auto', padding: 14,
          display: 'flex', flexDirection: 'column', gap: 12,
        }}>
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
                {/* Critic badge */}
                {agent.role === 'qa' && agent.status === 'done' && agent.content && (
                  <span style={{ fontFamily: mono, fontSize: 10, fontWeight: 700, color: agent.content.trim().startsWith('APROBADO') ? '#00ff88' : '#F59E0B' }}>
                    {agent.content.trim().startsWith('APROBADO') ? '● APROBADO' : '● REVISAR'}
                  </span>
                )}
                {/* Designer: 💾 button in header */}
                {agent.role === 'designer' && agent.status === 'done' && designPrototype && (
                  <button
                    onClick={e => { e.stopPropagation(); openSaveModal('prototype') }}
                    style={{
                      marginLeft: 'auto',
                      padding: '4px 12px',
                      background: 'linear-gradient(135deg, #10B981, #059669)',
                      border: 'none', borderRadius: 6,
                      color: '#fff', fontFamily: mono, fontSize: 10, fontWeight: 700, cursor: 'pointer',
                    }}
                  >
                    💾 Guardar
                  </button>
                )}
                {/* Toggle for non-designer cards */}
                {agent.status === 'done' && agent.role !== 'designer' && (
                  <span style={{ marginLeft: 'auto', fontFamily: mono, fontSize: 10, color: '#64748B' }}>
                    {expandedCards[agent.role] ? '▲ cerrar' : '▼ ver'}
                  </span>
                )}
              </div>

              {/* Card body — with internal scroll */}
              {(agent.status === 'done' || agent.status === 'error') && agent.content && (
                <div style={{ padding: '0 12px 12px' }}>
                  {agent.role === 'designer' && designPrototype ? (
                    <span style={{ fontFamily: mono, fontSize: 10, color: '#64748B' }}>// prototipo listo — ver panel derecho</span>
                  ) : agent.role === 'qa' && expandedCards['qa'] ? (
                    <div style={{
                      maxHeight: 200, overflowY: 'auto',
                      fontFamily: mono, fontSize: 11, lineHeight: 1.7, whiteSpace: 'pre-wrap',
                      color: agent.content.trim().startsWith('APROBADO') ? '#00ff88' : '#F59E0B',
                      paddingTop: 4,
                    }}>
                      {agent.content}
                    </div>
                  ) : agent.role !== 'qa' && agent.role !== 'designer' && expandedCards[agent.role] ? (
                    <div style={{
                      maxHeight: 200, overflowY: 'auto',
                      fontFamily: mono, fontSize: 11, color: '#94A3B8', lineHeight: 1.7, whiteSpace: 'pre-wrap', paddingTop: 4,
                    }}>
                      {agent.content}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* ── RIGHT: Preview panel ── */}
        <div style={{
          width: 420, flexShrink: 0,
          borderLeft: '1px solid #1E1E2E',
          display: 'flex', flexDirection: 'column', overflowY: 'auto',
          padding: 14, gap: 12,
        }}>

          {/* Design prototype */}
          {designPrototype && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontFamily: mono, fontSize: 10, color: '#06B6D4', fontWeight: 700 }}>// prototipo visual</div>
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
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    const blob = new Blob([designPrototype], { type: 'text/html' })
                    window.open(URL.createObjectURL(blob), '_blank')
                  }}
                  style={{
                    position: 'absolute', top: 8, left: 8,
                    background: 'rgba(0,0,0,0.7)', borderRadius: 4, padding: '4px 8px',
                    fontSize: 11, color: '#ccc', fontFamily: mono, border: 'none', cursor: 'pointer',
                  }}
                >
                  ↗ abrir
                </button>
                <div style={{
                  position: 'absolute', top: 8, right: 8,
                  background: 'rgba(0,0,0,0.7)', borderRadius: 4, padding: '4px 8px',
                  fontSize: 11, color: '#ccc', fontFamily: mono, pointerEvents: 'none',
                }}>
                  ⛶ expandir
                </div>
              </div>
            </div>
          )}

          {/* Import HTML panel */}
          {showImport && (
            <div style={{ background: '#12121A', border: '1px solid #06B6D444', borderLeft: '3px solid #06B6D4', borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <span style={{ fontFamily: mono, fontSize: 10, color: '#06B6D4', fontWeight: 700 }}>📥 IMPORTAR HTML</span>
              <textarea
                value={importHtml}
                onChange={e => setImportHtml(e.target.value)}
                placeholder="Pega tu HTML aquí..."
                rows={6}
                style={{
                  background: '#0A0A0F', border: '1px solid #1E1E2E', borderRadius: 8,
                  color: '#E2E8F0', fontFamily: mono, fontSize: 11,
                  padding: 10, resize: 'vertical', lineHeight: 1.5, outline: 'none',
                }}
              />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  onClick={() => setImportPreview(importHtml.trim())}
                  disabled={!importHtml.trim()}
                  style={{
                    padding: '7px 16px',
                    background: importHtml.trim() ? 'linear-gradient(135deg, #06B6D4, #0891B2)' : '#1E1E2E',
                    border: 'none', borderRadius: 8,
                    color: importHtml.trim() ? '#fff' : '#64748B',
                    fontFamily: mono, fontSize: 11, fontWeight: 700,
                    cursor: importHtml.trim() ? 'pointer' : 'not-allowed',
                  }}
                >
                  👁 Vista Previa
                </button>
                <button
                  onClick={() => openSaveModal('import')}
                  disabled={!importHtml.trim()}
                  style={{
                    padding: '7px 14px',
                    background: importHtml.trim() ? '#10B98122' : 'transparent',
                    border: `1px solid ${importHtml.trim() ? '#10B981' : '#1E1E2E'}`,
                    borderRadius: 8,
                    color: importHtml.trim() ? '#10B981' : '#64748B',
                    fontFamily: mono, fontSize: 10, fontWeight: 700,
                    cursor: importHtml.trim() ? 'pointer' : 'not-allowed',
                  }}
                >
                  💾 Guardar
                </button>
                <button
                  onClick={openEditModal}
                  disabled={!importHtml.trim()}
                  title={activeProjectId ? 'Editar este proyecto con AI' : 'Carga un proyecto desde Mis Proyectos para editar'}
                  style={{
                    padding: '7px 14px',
                    background: importHtml.trim() ? '#7C3AED22' : 'transparent',
                    border: `1px solid ${importHtml.trim() ? '#7C3AED' : '#1E1E2E'}`,
                    borderRadius: 8,
                    color: importHtml.trim() ? '#A78BFA' : '#64748B',
                    fontFamily: mono, fontSize: 10, fontWeight: 700,
                    cursor: importHtml.trim() ? 'pointer' : 'not-allowed',
                  }}
                >
                  ✏️ Editar
                </button>
                {importPreview && (
                  <button
                    onClick={() => {
                      const blob = new Blob([importPreview], { type: 'text/html' })
                      window.open(URL.createObjectURL(blob), '_blank')
                    }}
                    style={{ padding: '7px 14px', background: 'transparent', border: '1px solid #1E1E2E', borderRadius: 8, color: '#94A3B8', fontFamily: mono, fontSize: 10, cursor: 'pointer' }}
                  >
                    ↗ abrir
                  </button>
                )}
                {importPreview && (
                  <button
                    onClick={() => setImportPreview('')}
                    style={{ padding: '7px 10px', background: 'transparent', border: 'none', color: '#64748B', fontFamily: mono, fontSize: 10, cursor: 'pointer' }}
                  >
                    ✕
                  </button>
                )}
              </div>
              {importPreview && (
                <div>
                  <div style={{ fontFamily: mono, fontSize: 10, color: '#64748B', marginBottom: 6 }}>// preview</div>
                  <iframe
                    srcDoc={importPreview}
                    style={{ width: '100%', height: 420, border: '1px solid #1E1E2E', borderRadius: 8, background: '#fff' }}
                    sandbox="allow-scripts allow-same-origin"
                    title="Import Preview"
                  />
                </div>
              )}
            </div>
          )}

          {/* Empty state */}
          {!designPrototype && !showImport && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 8, opacity: 0.3 }}>
              <span style={{ fontSize: 32 }}>🖼</span>
              <span style={{ fontFamily: mono, fontSize: 11, color: '#64748B', textAlign: 'center' }}>El prototipo aparecerá aquí</span>
            </div>
          )}
        </div>

      </div>

      {/* Footer */}
      <div style={{ padding: '10px 14px', borderTop: '1px solid #1E1E2E', background: '#12121A', fontFamily: mono, fontSize: 10, color: '#64748B', textAlign: 'center' }}>
        Director Creativo → Designer → Critic → Engineer
      </div>

      {/* Edit modal */}
      {showEditModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          zIndex: 10000, background: 'rgba(0,0,0,0.80)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: '#12121A', border: '1px solid #7C3AED44', borderRadius: 14,
            padding: 24, width: 560, maxHeight: '90vh', display: 'flex', flexDirection: 'column', gap: 14, overflow: 'hidden',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: mono, fontSize: 12, color: '#A78BFA', fontWeight: 700 }}>✏️ EDITAR PROYECTO</span>
              {activeProjectId && (
                <span style={{ fontFamily: mono, fontSize: 9, color: '#64748B' }}>
                  #{activeProjectId} · {projects.find(p => p.id === activeProjectId)?.name ?? ''}
                </span>
              )}
            </div>

            {/* Changes textarea */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontFamily: mono, fontSize: 10, color: '#64748B' }}>describe los cambios que quieres aplicar</span>
              <textarea
                value={editChanges}
                onChange={e => setEditChanges(e.target.value)}
                placeholder='Ej: "agrega 5 estilos de pizza más al menú" / "cambia el hero a fondo azul" / "añade sección de reseñas"'
                rows={4}
                autoFocus
                style={{
                  background: '#0A0A0F', border: '1px solid #7C3AED44', borderRadius: 8,
                  color: '#E2E8F0', fontFamily: mono, fontSize: 11,
                  padding: 10, resize: 'vertical', lineHeight: 1.5, outline: 'none',
                }}
              />
            </div>

            {/* Apply button */}
            <button
              onClick={applyEdits}
              disabled={!editChanges.trim() || editStatus === 'applying'}
              style={{
                padding: '9px 20px', alignSelf: 'flex-start',
                background: editChanges.trim() && editStatus !== 'applying'
                  ? 'linear-gradient(135deg, #7C3AED, #6D28D9)' : '#1E1E2E',
                border: 'none', borderRadius: 8,
                color: editChanges.trim() ? '#fff' : '#64748B',
                fontFamily: mono, fontSize: 11, fontWeight: 700,
                cursor: editChanges.trim() && editStatus !== 'applying' ? 'pointer' : 'not-allowed',
              }}
            >
              {editStatus === 'applying' ? '⏳ Aplicando...' : '▶ Aplicar cambios'}
            </button>

            {editStatus === 'error' && (
              <span style={{ fontFamily: mono, fontSize: 10, color: '#EF4444' }}>✕ Error al aplicar cambios</span>
            )}

            {/* Preview of edited HTML */}
            {editedHtml && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, overflow: 'hidden', minHeight: 0 }}>
                <div style={{ fontFamily: mono, fontSize: 10, color: '#64748B' }}>// preview de cambios</div>
                <iframe
                  srcDoc={editedHtml}
                  style={{ width: '100%', flex: 1, minHeight: 280, border: '1px solid #7C3AED44', borderRadius: 8, background: '#fff' }}
                  sandbox="allow-scripts allow-same-origin"
                  title="Edit Preview"
                />
                {/* Save / discard */}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button
                    onClick={() => { setEditedHtml(''); setEditStatus('idle') }}
                    style={{ padding: '7px 14px', background: 'transparent', border: '1px solid #1E1E2E', borderRadius: 8, color: '#64748B', fontFamily: mono, fontSize: 10, cursor: 'pointer' }}
                  >
                    Descartar
                  </button>
                  {activeProjectId ? (
                    <button
                      onClick={saveEditedProject}
                      disabled={saveEditStatus === 'saving'}
                      style={{
                        padding: '7px 18px',
                        background: saveEditStatus === 'ok' ? '#10B981' : saveEditStatus === 'error' ? '#EF4444' : 'linear-gradient(135deg,#10B981,#059669)',
                        border: 'none', borderRadius: 8,
                        color: '#fff', fontFamily: mono, fontSize: 11, fontWeight: 700,
                        cursor: saveEditStatus === 'saving' ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {saveEditStatus === 'saving' ? '⏳...' : saveEditStatus === 'ok' ? '✓ Guardado' : saveEditStatus === 'error' ? '✕ Error' : '💾 Guardar cambios'}
                    </button>
                  ) : (
                    <button
                      onClick={() => { setImportHtml(editedHtml); setImportPreview(editedHtml); setShowEditModal(false) }}
                      style={{ padding: '7px 18px', background: 'linear-gradient(135deg,#7C3AED,#6D28D9)', border: 'none', borderRadius: 8, color: '#fff', fontFamily: mono, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                    >
                      Usar en Import
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Cancel */}
            {editStatus !== 'done' && (
              <button
                onClick={() => setShowEditModal(false)}
                style={{ padding: '7px 14px', alignSelf: 'flex-end', background: 'transparent', border: '1px solid #1E1E2E', borderRadius: 8, color: '#64748B', fontFamily: mono, fontSize: 10, cursor: 'pointer' }}
              >
                ✕ Cerrar
              </button>
            )}
          </div>
        </div>
      )}

      {/* Save modal */}
      {showSaveModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          zIndex: 10000, background: 'rgba(0,0,0,0.75)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: '#12121A', border: '1px solid #1E1E2E', borderRadius: 14,
            padding: 24, width: 360, display: 'flex', flexDirection: 'column', gap: 14,
          }}>
            <span style={{ fontFamily: mono, fontSize: 12, color: '#10B981', fontWeight: 700 }}>💾 GUARDAR PROYECTO</span>

            {/* Name */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontFamily: mono, fontSize: 10, color: '#64748B' }}>nombre</span>
              <input
                value={saveName}
                onChange={e => setSaveName(e.target.value)}
                placeholder="Mi proyecto..."
                autoFocus
                style={{ background: '#0A0A0F', border: '1px solid #1E1E2E', borderRadius: 7, padding: '8px 10px', color: '#E2E8F0', fontFamily: mono, fontSize: 11, outline: 'none' }}
              />
            </div>

            {/* Folder */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontFamily: mono, fontSize: 10, color: '#64748B' }}>carpeta</span>
              {!newFolderMode ? (
                <div style={{ display: 'flex', gap: 6 }}>
                  <select
                    value={saveFolder}
                    onChange={e => setSaveFolder(e.target.value)}
                    style={{ flex: 1, background: '#0A0A0F', border: '1px solid #1E1E2E', borderRadius: 7, padding: '8px 10px', color: '#E2E8F0', fontFamily: mono, fontSize: 11, outline: 'none' }}
                  >
                    <option value="">Sin carpeta</option>
                    {[...new Set(projects.map(p => p.folder).filter(f => f !== 'Sin carpeta'))].map(f => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => setNewFolderMode(true)}
                    style={{ padding: '8px 10px', background: 'transparent', border: '1px solid #1E1E2E', borderRadius: 7, color: '#64748B', fontFamily: mono, fontSize: 10, cursor: 'pointer' }}
                  >
                    + nueva
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    value={newFolderName}
                    onChange={e => setNewFolderName(e.target.value)}
                    placeholder="Nombre de carpeta..."
                    style={{ flex: 1, background: '#0A0A0F', border: '1px solid #F59E0B', borderRadius: 7, padding: '8px 10px', color: '#E2E8F0', fontFamily: mono, fontSize: 11, outline: 'none' }}
                  />
                  <button
                    onClick={() => setNewFolderMode(false)}
                    style={{ padding: '8px 10px', background: 'transparent', border: '1px solid #1E1E2E', borderRadius: 7, color: '#64748B', fontFamily: mono, fontSize: 10, cursor: 'pointer' }}
                  >
                    ✕
                  </button>
                </div>
              )}
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <button
                onClick={() => setShowSaveModal(false)}
                style={{ padding: '8px 16px', background: 'transparent', border: '1px solid #1E1E2E', borderRadius: 8, color: '#64748B', fontFamily: mono, fontSize: 10, cursor: 'pointer' }}
              >
                Cancelar
              </button>
              <button
                onClick={saveProject}
                disabled={!saveName.trim() || saveStatus === 'saving'}
                style={{
                  padding: '8px 18px',
                  background: saveStatus === 'ok' ? '#10B981' : saveStatus === 'error' ? '#EF4444' : saveName.trim() ? 'linear-gradient(135deg, #10B981, #059669)' : '#1E1E2E',
                  border: 'none', borderRadius: 8,
                  color: saveName.trim() ? '#fff' : '#64748B',
                  fontFamily: mono, fontSize: 11, fontWeight: 700,
                  cursor: saveName.trim() && saveStatus !== 'saving' ? 'pointer' : 'not-allowed',
                }}
              >
                {saveStatus === 'saving' ? '⏳...' : saveStatus === 'ok' ? '✓ Guardado' : saveStatus === 'error' ? '✕ Error' : '💾 Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}

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
