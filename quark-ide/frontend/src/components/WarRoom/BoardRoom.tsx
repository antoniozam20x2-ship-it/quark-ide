import { useState, useEffect, useRef } from 'react';
import QuarkMarkdown from '../shared/QuarkMarkdown';
import type { BoardBrief } from '../../App';

const API_BASE = (import.meta.env.VITE_API_URL ?? window.location.origin).replace(/\/$/, '');

type MemberKey = 'CEO' | 'CTO' | 'Designer' | 'QA';
type MemberStatus = 'idle' | 'thinking' | 'done' | 'error';

const MEMBERS: { key: MemberKey; icon: string; title: string; subtitle: string }[] = [
  { key: 'CEO',      icon: '👔', title: 'CEO',      subtitle: 'Business Strategy' },
  { key: 'CTO',      icon: '🖥',  title: 'CTO',      subtitle: 'Tech Architecture' },
  { key: 'Designer', icon: '🎨', title: 'DESIGNER', subtitle: 'UX & Brand' },
  { key: 'QA',       icon: '🛡',  title: 'QA',       subtitle: 'Risk & Testing' },
];

const PROJECT_NAMES = ['Quark IDE', 'Signal OS', 'Sniper OS', 'Nexus OS', 'Core AI'];

interface MemberResponse {
  role: MemberKey;
  response: string;
}

interface SavedSession {
  challenge: string;
  responses: MemberResponse[];
  consensus: string;
  timestamp: number;
}

interface AuditChange {
  id: number;
  prioridad: 'CRÍTICO' | 'IMPORTANTE' | 'MEJORA';
  titulo: string;
  archivo: string;
  que_cambiar: string;
  por_que: string;
  prompt_agent: string;
}

interface AuditVerdict {
  veredicto: 'MEJORAR' | 'PAUSAR';
  razon_principal: string;
  cambios: AuditChange[];
  riesgo_no_resuelto: string | null;
}

interface Props {
  initialBrief?: BoardBrief | null;
  onBriefConsumed?: () => void;
  onSendToAgent?: (prompt: string, projectName?: string) => void;
}

function detectRepo(challenge: string): string | null {
  const c = challenge.toLowerCase();
  if (c.includes('sniper') || c.includes('snipe'))  return 'Sniper OS';
  if (c.includes('signal'))                          return 'Signal OS';
  if (c.includes('nexus'))                           return 'Nexus OS';
  if (c.includes('core ai') || c.includes('core'))  return 'Core AI';
  if (c.includes('quark'))                           return 'Quark IDE';
  return null;
}

export default function BoardRoom({ initialBrief, onBriefConsumed, onSendToAgent }: Props) {
  const [challenge, setChallenge] = useState('');
  const [statuses, setStatuses] = useState<Record<MemberKey, MemberStatus>>({
    CEO: 'idle', CTO: 'idle', Designer: 'idle', QA: 'idle',
  });
  const [responses, setResponses] = useState<MemberResponse[]>([]);
  const [consensus, setConsensus] = useState('');
  const [running, setRunning] = useState(false);
  const [expanded, setExpanded] = useState<Record<MemberKey, boolean>>({
    CEO: false, CTO: false, Designer: false, QA: false,
  });
  const [swarmMode, setSwarmMode] = useState(true);
  const [useClaudeThinking, setUseClaudeThinking] = useState(false);
  const [processingTime, setProcessingTime] = useState<number | null>(null);
  const [auditVerdict, setAuditVerdict] = useState<AuditVerdict | null>(() => {
    try {
      const raw = localStorage.getItem('warroom_last_verdict');
      return raw ? (JSON.parse(raw) as AuditVerdict) : null;
    } catch { return null; }
  });
  const [targetRepo, setTargetRepo] = useState('');
  const [showRepoSelector, setShowRepoSelector] = useState(false);
  const [savedSession, setSavedSession] = useState<SavedSession | null>(() => {
    try {
      const raw = localStorage.getItem('warroom_last_session');
      return raw ? (JSON.parse(raw) as SavedSession) : null;
    } catch { return null; }
  });

  const repoContextRef = useRef<BoardBrief['repoContext'] | null>(null);
  const appNameRef = useRef<string | null>(null);
  const [preloadedFiles, setPreloadedFiles] = useState<string[]>([]);

  useEffect(() => {
    if (!initialBrief) return;
    const challengeText = initialBrief.challenge;
    repoContextRef.current = initialBrief.repoContext ?? null;
    appNameRef.current = initialBrief.appName ?? null;
    const files = initialBrief.repoContext?.keyFiles?.map((f) => f.path.split('/').pop() ?? f.path) ?? [];
    setPreloadedFiles(files);
    setChallenge(challengeText);
    onBriefConsumed?.();
    conveneSwarm(challengeText);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialBrief]);

  function persistSession(ch: string, res: MemberResponse[], con: string) {
    const session: SavedSession = { challenge: ch, responses: res, consensus: con, timestamp: Date.now() };
    localStorage.setItem('warroom_last_session', JSON.stringify(session));
    setSavedSession(session);
    // Persistir auditVerdict por separado
    try {
      const cleaned = con.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
      const jsonStart = cleaned.indexOf('{');
      const jsonEnd = cleaned.lastIndexOf('}');
      const jsonStr = jsonStart !== -1 && jsonEnd !== -1 ? cleaned.slice(jsonStart, jsonEnd + 1) : cleaned;
      const parsed = JSON.parse(jsonStr) as AuditVerdict;
      if (parsed.cambios && Array.isArray(parsed.cambios)) {
        localStorage.setItem('warroom_last_verdict', JSON.stringify(parsed));
      }
    } catch { /* no bloquear */ }
  }

  function restoreSession() {
    if (!savedSession) return;
    setChallenge(savedSession.challenge);
    setResponses(savedSession.responses);
    setConsensus(savedSession.consensus);
    setStatuses({ CEO: 'done', CTO: 'done', Designer: 'done', QA: 'done' });
    setExpanded({ CEO: false, CTO: false, Designer: false, QA: false });
    setTargetRepo('');
    setShowRepoSelector(false);
  }

  function setStatus(key: MemberKey, s: MemberStatus) {
    setStatuses((prev) => ({ ...prev, [key]: s }));
  }

  function toggleExpanded(key: MemberKey) {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  async function conveneSwarm(briefOverride?: string) {
    const text = (briefOverride ?? challenge).trim();
    if (!text) return;
    setRunning(true);
    setResponses([]);
    setConsensus('');
    setAuditVerdict(null);
    localStorage.removeItem('warroom_last_verdict');
    setProcessingTime(null);
    setTargetRepo('');
    setShowRepoSelector(false);
    setStatuses({ CEO: 'thinking', CTO: 'thinking', Designer: 'thinking', QA: 'thinking' });
    setExpanded({ CEO: false, CTO: false, Designer: false, QA: false });

    try {
      const res = await fetch(`${API_BASE}/api/warroom/swarm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challenge: text,
          appName: appNameRef.current ?? detectRepo(text) ?? undefined,
          repoContext: repoContextRef.current ?? undefined,
          useClaudeThinking,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      const collected: MemberResponse[] = [
        { role: 'CEO',      response: data.ceo      ?? '' },
        { role: 'CTO',      response: data.cto      ?? '' },
        { role: 'Designer', response: data.designer ?? '' },
        { role: 'QA',       response: data.qa       ?? '' },
      ];
      const con = data.consensus ?? '';

      setResponses(collected);
      setStatuses({ CEO: 'done', CTO: 'done', Designer: 'done', QA: 'done' });
      setConsensus(con);
      setProcessingTime(data.processingTime ?? null);
      persistSession(text, collected, con);
      // Parse audit verdict JSON if present
      try {
        const cleaned = con
          .replace(/```json\s*/gi, '')
          .replace(/```\s*/gi, '')
          .replace(/[\u0000-\u001F\u007F]/g, (c: string) => {
            if (c === '\n' || c === '\r' || c === '\t') return c;
            return '';
          })
          .trim();
        const jsonStart = cleaned.indexOf('{');
        const jsonEnd = cleaned.lastIndexOf('}');
        const jsonStr = jsonStart !== -1 && jsonEnd !== -1
          ? cleaned.slice(jsonStart, jsonEnd + 1)
          : cleaned;
        const parsed = JSON.parse(jsonStr) as AuditVerdict;
        if (parsed.cambios && Array.isArray(parsed.cambios)) {
          setAuditVerdict(parsed);
        } else {
          setAuditVerdict(null);
        }
      } catch {
        setAuditVerdict(null);
      }
    } catch {
      setStatuses({ CEO: 'error', CTO: 'error', Designer: 'error', QA: 'error' });
      setConsensus('⚠ Swarm encountered an error. Try sequential mode.');
    } finally {
      setRunning(false);
    }
  }

  async function conveneSequential(briefOverride?: string) {
    const text = (briefOverride ?? challenge).trim();
    if (!text) return;
    setRunning(true);
    setResponses([]);
    setConsensus('');
    setAuditVerdict(null);
    localStorage.removeItem('warroom_last_verdict');
    setProcessingTime(null);
    setTargetRepo('');
    setShowRepoSelector(false);
    setStatuses({ CEO: 'idle', CTO: 'idle', Designer: 'idle', QA: 'idle' });
    setExpanded({ CEO: false, CTO: false, Designer: false, QA: false });

    const collected: MemberResponse[] = [];
    for (const member of MEMBERS) {
      setStatus(member.key, 'thinking');
      try {
        const res = await fetch(`${API_BASE}/api/warroom/board`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            challenge: text,
            member: member.key,
            appName: appNameRef.current ?? detectRepo(text) ?? undefined,
            repoContext: repoContextRef.current ?? undefined,
          }),
        });
        const data = await res.json();
        const mr: MemberResponse = { role: member.key, response: data.response ?? data.error ?? '' };
        collected.push(mr);
        setResponses((prev) => [...prev, mr]);
        setStatus(member.key, 'done');
        await new Promise((r) => setTimeout(r, 300));
      } catch {
        setStatus(member.key, 'error');
        const mr = { role: member.key, response: '⚠ Error fetching response.' };
        collected.push(mr);
        setResponses((prev) => [...prev, mr]);
      }
    }

    setConsensus('generating');
    try {
      const summaryRes = await fetch(`${API_BASE}/api/warroom/board`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challenge: `Original challenge: ${text}\n\nBoard responses:\n${collected.map((r) => `${r.role}: ${r.response}`).join('\n\n')}\n\nSynthesize all perspectives into 3-5 clear, actionable consensus items.`,
          member: 'CEO',
        }),
      });
      const d = await summaryRes.json();
      const con = d.response ?? '';
      setConsensus(con);
      persistSession(text, collected, con);
      // Parse audit verdict JSON if present
      try {
        const cleaned = con
          .replace(/```json\s*/gi, '')
          .replace(/```\s*/gi, '')
          .replace(/[\u0000-\u001F\u007F]/g, (c: string) => {
            if (c === '\n' || c === '\r' || c === '\t') return c;
            return '';
          })
          .trim();
        const jsonStart = cleaned.indexOf('{');
        const jsonEnd = cleaned.lastIndexOf('}');
        const jsonStr = jsonStart !== -1 && jsonEnd !== -1
          ? cleaned.slice(jsonStart, jsonEnd + 1)
          : cleaned;
        const parsed = JSON.parse(jsonStr) as AuditVerdict;
        if (parsed.cambios && Array.isArray(parsed.cambios)) {
          setAuditVerdict(parsed);
        } else {
          setAuditVerdict(null);
        }
      } catch {
        setAuditVerdict(null);
      }
    } catch {
      setConsensus('⚠ Could not generate consensus.');
    }

    setRunning(false);
  }

  function convene() {
    if (!challenge.trim() || running) return;
    if (swarmMode) conveneSwarm();
    else conveneSequential();
  }

  const memberMap = Object.fromEntries(responses.map((r) => [r.role, r])) as Record<MemberKey, MemberResponse | undefined>;
  const detectedRepo = challenge ? detectRepo(challenge) : null;
  const effectiveRepo = targetRepo || detectedRepo || PROJECT_NAMES[0];

  function handleSendToAgent() {
    if (!onSendToAgent || !consensus || consensus === 'generating') return;
    let promptWithFiles = consensus;
    if (repoContextRef.current?.keyFiles?.length) {
      const filesSection = repoContextRef.current.keyFiles
        .map((f) => `--- ${f.path} ---\n${f.content.slice(0, 3000)}`)
        .join('\n\n');
      promptWithFiles = `${consensus}\n\nARCHIVOS DISPONIBLES:\n${filesSection}`;
    }
    onSendToAgent(promptWithFiles, effectiveRepo);
  }

  return (
    <>
      <style>{`
        .board-members-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 10px;
          width: 100%;
          min-width: 0;
        }
        .board-members-grid > * { min-width: 0; overflow: hidden; }
        @media (max-width: 767px) {
          .board-members-grid { grid-template-columns: repeat(2, 1fr); gap: 8px; }
        }
      `}</style>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%' }}>

        {/* Restore session banner */}
        {savedSession && responses.length === 0 && !running && (
          <div style={{
            background: 'rgba(124,58,237,0.08)', border: '1px solid #4c1d95',
            borderRadius: 8, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <span style={{ color: '#a78bfa', fontSize: 11, fontFamily: 'JetBrains Mono, monospace', flex: 1 }}>
              💾 Sesión anterior:{' '}
              <span style={{ color: '#e2e8f0' }}>
                {savedSession.challenge.slice(0, 60)}{savedSession.challenge.length > 60 ? '…' : ''}
              </span>
              <span style={{ color: '#6b7280', marginLeft: 8 }}>
                {new Date(savedSession.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </span>
            <button
              onClick={restoreSession}
              style={{
                background: 'rgba(124,58,237,0.15)', border: '1px solid #7c3aed',
                borderRadius: 4, color: '#a78bfa', fontFamily: 'JetBrains Mono, monospace',
                fontSize: 10, fontWeight: 700, padding: '4px 10px', cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Restaurar sesión
            </button>
          </div>
        )}

        {/* Preloaded files indicator */}
        {preloadedFiles.length > 0 && (
          <div style={{
            background: 'rgba(0,255,136,0.06)', border: '1px solid rgba(0,255,136,0.25)',
            borderRadius: 8, padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8,
            flexWrap: 'wrap',
          }}>
            <span style={{ color: '#00ff88', fontSize: 11, fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, whiteSpace: 'nowrap' }}>
              📂 {preloadedFiles.length} {preloadedFiles.length === 1 ? 'archivo precargado' : 'archivos precargados'}:
            </span>
            <span style={{ color: '#a0f0c8', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}>
              {preloadedFiles.join(', ')}
            </span>
          </div>
        )}

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <p style={{ color: '#6b7280', fontSize: 13, margin: 0 }}>
            Present your challenge to the board. Each member analyzes from their perspective.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <button
              onClick={() => setSwarmMode(false)}
              style={{
                background: !swarmMode ? 'rgba(0,255,136,0.12)' : 'transparent',
                border: `1px solid ${!swarmMode ? '#00ff88' : '#1e1e3f'}`,
                borderRadius: 4, color: !swarmMode ? '#00ff88' : '#6b7280',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
                padding: '3px 8px', cursor: 'pointer', letterSpacing: '0.04em',
              }}
            >
              SEQ
            </button>
            <button
              onClick={() => setSwarmMode(true)}
              style={{
                background: swarmMode ? 'rgba(0,255,136,0.12)' : 'transparent',
                border: `1px solid ${swarmMode ? '#00ff88' : '#1e1e3f'}`,
                borderRadius: 4, color: swarmMode ? '#00ff88' : '#6b7280',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
                padding: '3px 8px', cursor: 'pointer', letterSpacing: '0.04em',
              }}
            >
              ⚡ SWARM
            </button>
          </div>
        </div>

        {/* Input */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea
            className="quark-textarea"
            placeholder="What challenge should the board discuss?"
            value={challenge}
            onChange={(e) => setChallenge(e.target.value)}
            disabled={running}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                onClick={() => setUseClaudeThinking(false)}
                disabled={running}
                style={{
                  background: !useClaudeThinking ? 'rgba(0,255,136,0.12)' : 'transparent',
                  border: `1px solid ${!useClaudeThinking ? '#00ff88' : '#1e1e3f'}`,
                  borderRadius: 4, color: !useClaudeThinking ? '#00ff88' : '#6b7280',
                  fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
                  padding: '3px 8px', cursor: 'pointer', letterSpacing: '0.04em',
                }}
              >
                ⚡ Groq
              </button>
              <button
                onClick={() => setUseClaudeThinking(true)}
                disabled={running}
                style={{
                  background: useClaudeThinking ? 'rgba(139,92,246,0.15)' : 'transparent',
                  border: `1px solid ${useClaudeThinking ? '#8b5cf6' : '#1e1e3f'}`,
                  borderRadius: 4, color: useClaudeThinking ? '#a78bfa' : '#6b7280',
                  fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
                  padding: '3px 8px', cursor: 'pointer', letterSpacing: '0.04em',
                }}
              >
                🧠 Claude
              </button>
              {swarmMode && (
                <span style={{
                  background: 'rgba(0,255,136,0.08)', border: '1px solid #1e3f2a',
                  borderRadius: 4, color: '#00ff88', fontSize: 10, fontWeight: 700,
                  padding: '2px 7px', fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.05em',
                }}>
                  ⚡ Parallel Mode
                </span>
              )}
              {processingTime !== null && (
                <span style={{ color: '#3a3a5c', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}>
                  {(processingTime / 1000).toFixed(1)}s
                </span>
              )}
            </div>
            <button className="quark-btn-primary" onClick={convene} disabled={running || !challenge.trim()}>
              {running ? '⚛ CONVENING...' : 'CONVENE ⚛'}
            </button>
          </div>
        </div>

        {/* Status cards grid */}
        <div className="board-members-grid">
          {MEMBERS.map((m) => {
            const status = statuses[m.key];
            const isActive = status === 'thinking';
            const isDone   = status === 'done';
            const isError  = status === 'error';
            return (
              <div
                key={m.key}
                style={{
                  background: '#0d0d1a',
                  border: `1px solid ${isActive ? '#00ff88' : isDone ? '#1e3f2a' : isError ? '#3f1e1e' : '#1e1e3f'}`,
                  borderRadius: 6, padding: 12, transition: 'all 0.3s ease',
                  boxShadow: isActive ? '0 0 12px rgba(0,255,136,0.15)' : 'none',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 20 }}>{m.icon}</span>
                  <div>
                    <div style={{ color: '#e2e8f0', fontSize: 12, fontWeight: 700 }}>{m.title}</div>
                    <div style={{ color: '#6b7280', fontSize: 11 }}>{m.subtitle}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <div style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: isActive ? '#00ff88' : isDone ? '#00ff88' : isError ? '#ff4444' : '#3a3a5c',
                    transition: 'background 0.3s',
                    boxShadow: isActive ? '0 0 6px rgba(0,255,136,0.6)' : 'none',
                  }} />
                  <span style={{ fontSize: 10, color: isActive ? '#00ff88' : isDone ? '#6b7280' : isError ? '#ff4444' : '#3a3a5c' }}>
                    {status}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Responses */}
        {responses.length > 0 && (
          <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch' as any, paddingBottom: 80 }}>
            {(appNameRef.current ?? detectRepo(challenge)) === 'Signal OS' && (
              <div style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '4px 10px',
                borderRadius: '4px',
                background: 'rgba(0, 255, 136, 0.1)',
                border: '1px solid rgba(0, 255, 136, 0.3)',
                fontSize: '11px',
                color: '#00ff88',
                marginBottom: '12px',
                fontFamily: 'monospace',
              }}>
                📊 Reporte de hoy incluido en el análisis
              </div>
            )}
            {(appNameRef.current ?? detectRepo(challenge)) === 'Sniper OS' && (
              <div style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '4px 10px',
                borderRadius: '4px',
                background: 'rgba(0, 255, 136, 0.1)',
                border: '1px solid rgba(0, 255, 136, 0.3)',
                fontSize: '11px',
                color: '#00ff88',
                marginBottom: '12px',
                fontFamily: 'monospace',
              }}>
                🎯 Reporte del Oráculo incluido
              </div>
            )}
            {MEMBERS.map((m) => {
              const r = memberMap[m.key];
              if (!r) return null;
              const isExpanded = expanded[m.key];
              return (
                <div key={m.key} style={{ background: '#0d0d1a', border: '1px solid #1e1e3f', borderRadius: 6, overflow: 'hidden', marginBottom: 8 }}>
                  <button
                    onClick={() => toggleExpanded(m.key)}
                    style={{
                      width: '100%', background: '#111127', border: 'none',
                      borderBottom: isExpanded ? '1px solid #1e1e3f' : 'none',
                      padding: '10px 14px', display: 'flex', alignItems: 'center',
                      gap: 8, cursor: 'pointer', textAlign: 'left',
                    }}
                  >
                    <span style={{ fontSize: 18 }}>{m.icon}</span>
                    <span style={{ color: '#00ff88', fontSize: 12, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}>{m.title}</span>
                    <span style={{ color: '#6b7280', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}>— {m.subtitle}</span>
                    <span style={{ marginLeft: 'auto', color: '#00ff88', fontSize: 11, fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, whiteSpace: 'nowrap' }}>
                      {isExpanded ? '▲ Ver menos' : 'Ver respuesta ▼'}
                    </span>
                  </button>
                  {isExpanded && (
                    <div style={{ padding: '12px 14px' }}>
                      <QuarkMarkdown>{r.response}</QuarkMarkdown>
                    </div>
                  )}
                </div>
              );
            })}

            {consensus === 'generating' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12 }}>
                <span className="pulse-neon" style={{ color: '#00ff88', fontSize: 18 }}>⚛</span>
                <span style={{ color: '#6b7280', fontSize: 12 }}>
                  Synthesizing consensus<span className="thinking-dots" />
                </span>
              </div>
            )}

            {consensus && consensus !== 'generating' && (
              <>
                {auditVerdict ? (
                  /* ── AUDIT VERDICT — tarjetas estructuradas ── */
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

                    {/* Veredicto header */}
                    <div style={{
                      background: auditVerdict.veredicto === 'PAUSAR'
                        ? 'rgba(239,68,68,0.08)' : 'rgba(0,255,136,0.06)',
                      border: `1px solid ${auditVerdict.veredicto === 'PAUSAR' ? '#7f1d1d' : '#1e3f2a'}`,
                      borderLeft: `4px solid ${auditVerdict.veredicto === 'PAUSAR' ? '#ef4444' : '#00ff88'}`,
                      borderRadius: 8, padding: '12px 16px',
                      display: 'flex', alignItems: 'flex-start', gap: 12,
                    }}>
                      <span style={{ fontSize: 22, flexShrink: 0 }}>
                        {auditVerdict.veredicto === 'PAUSAR' ? '🛑' : '⚡'}
                      </span>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                          <span style={{
                            fontFamily: 'JetBrains Mono, monospace', fontSize: 13, fontWeight: 700,
                            color: auditVerdict.veredicto === 'PAUSAR' ? '#ef4444' : '#00ff88',
                            letterSpacing: '0.08em',
                          }}>
                            ⚛ VEREDICTO: {auditVerdict.veredicto}
                          </span>
                          {swarmMode && processingTime !== null && (
                            <span style={{
                              background: 'rgba(0,255,136,0.1)', border: '1px solid #1e3f2a',
                              borderRadius: 3, padding: '1px 6px', color: '#00ff88',
                              fontSize: 10, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace',
                            }}>
                              ⚡ {(processingTime / 1000).toFixed(1)}s parallel
                            </span>
                          )}
                        </div>
                        <p style={{
                          color: '#a0a0c0', fontSize: 12, margin: 0,
                          fontFamily: 'JetBrains Mono, monospace', lineHeight: 1.5,
                        }}>
                          {auditVerdict.razon_principal}
                        </p>
                      </div>
                    </div>

                    {/* Tarjetas de cambios */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <span style={{
                        color: '#3a3a5c', fontSize: 10, fontFamily: 'JetBrains Mono, monospace',
                        letterSpacing: '0.08em', paddingLeft: 2,
                      }}>
                        CAMBIOS RECOMENDADOS — {auditVerdict.cambios.length} acción(es)
                      </span>

                      {auditVerdict.cambios.map((cambio) => {
                        const prioColor =
                          cambio.prioridad === 'CRÍTICO'   ? '#ef4444' :
                          cambio.prioridad === 'IMPORTANTE' ? '#f59e0b' : '#00ff88';
                        const prioBg =
                          cambio.prioridad === 'CRÍTICO'   ? 'rgba(239,68,68,0.08)' :
                          cambio.prioridad === 'IMPORTANTE' ? 'rgba(245,158,11,0.08)' : 'rgba(0,255,136,0.06)';
                        const prioBorder =
                          cambio.prioridad === 'CRÍTICO'   ? '#7f1d1d' :
                          cambio.prioridad === 'IMPORTANTE' ? '#78350f' : '#1e3f2a';

                        return (
                          <div key={cambio.id} style={{
                            background: '#0d0d1a',
                            border: '1px solid #1e1e3f',
                            borderLeft: `3px solid ${prioColor}`,
                            borderRadius: 8, overflow: 'hidden',
                          }}>
                            {/* Card header */}
                            <div style={{
                              padding: '10px 14px', background: '#111127',
                              borderBottom: '1px solid #1e1e3f',
                              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                            }}>
                              <span style={{
                                background: prioBg, border: `1px solid ${prioBorder}`,
                                borderRadius: 4, padding: '2px 8px',
                                color: prioColor, fontSize: 9, fontWeight: 700,
                                fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.06em',
                              }}>
                                {cambio.prioridad}
                              </span>
                              <span style={{
                                color: '#e2e8f0', fontSize: 12, fontWeight: 700,
                                fontFamily: 'JetBrains Mono, monospace', flex: 1,
                              }}>
                                {cambio.titulo}
                              </span>
                              <span style={{
                                color: '#6b7280', fontSize: 10,
                                fontFamily: 'JetBrains Mono, monospace',
                                background: 'rgba(255,255,255,0.04)',
                                border: '1px solid #1e1e3f', borderRadius: 4,
                                padding: '2px 8px', whiteSpace: 'nowrap',
                              }}>
                                📄 {cambio.archivo}
                              </span>
                            </div>

                            {/* Card body */}
                            <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                              <div>
                                <span style={{
                                  color: '#3a3a5c', fontSize: 9, fontFamily: 'JetBrains Mono, monospace',
                                  letterSpacing: '0.06em', display: 'block', marginBottom: 3,
                                }}>QUÉ CAMBIAR</span>
                                <p style={{
                                  color: '#a0a0c0', fontSize: 12, margin: 0,
                                  fontFamily: 'JetBrains Mono, monospace', lineHeight: 1.6,
                                }}>
                                  {cambio.que_cambiar}
                                </p>
                              </div>
                              <div>
                                <span style={{
                                  color: '#3a3a5c', fontSize: 9, fontFamily: 'JetBrains Mono, monospace',
                                  letterSpacing: '0.06em', display: 'block', marginBottom: 3,
                                }}>POR QUÉ</span>
                                <p style={{
                                  color: '#6b7280', fontSize: 11, margin: 0,
                                  fontFamily: 'JetBrains Mono, monospace', lineHeight: 1.6,
                                }}>
                                  {cambio.por_que}
                                </p>
                              </div>

                              {/* Prompt preview */}
                              <div style={{
                                background: '#080810', border: '1px solid #1e1e3f',
                                borderRadius: 6, padding: '8px 10px',
                              }}>
                                <span style={{
                                  color: '#3a3a5c', fontSize: 9, fontFamily: 'JetBrains Mono, monospace',
                                  letterSpacing: '0.06em', display: 'block', marginBottom: 4,
                                }}>PROMPT PARA QUARK AGENT</span>
                                <p style={{
                                  color: '#7c3aed', fontSize: 11, margin: 0,
                                  fontFamily: 'JetBrains Mono, monospace', lineHeight: 1.6,
                                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                                }}>
                                  {cambio.prompt_agent}
                                </p>
                              </div>

                              {/* Send button */}
                              {onSendToAgent && (
                                <button
                                  onClick={() => {
                                    const repo = targetRepo || detectedRepo || effectiveRepo;
                                    onSendToAgent(cambio.prompt_agent, repo);
                                  }}
                                  style={{
                                    width: '100%', padding: '9px 14px',
                                    background: 'rgba(124,58,237,0.12)',
                                    border: '1px solid #4c1d95',
                                    borderRadius: 6, color: '#a78bfa',
                                    fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700,
                                    cursor: 'pointer', letterSpacing: '0.04em',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                                    transition: 'background 0.15s',
                                  }}
                                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(124,58,237,0.22)'; }}
                                  onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(124,58,237,0.12)'; }}
                                >
                                  ⚡ Enviar al Agent → {cambio.archivo}
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Riesgo no resuelto */}
                    {auditVerdict.riesgo_no_resuelto && (
                      <div style={{
                        background: 'rgba(245,158,11,0.06)', border: '1px solid #78350f',
                        borderRadius: 6, padding: '10px 14px',
                        display: 'flex', alignItems: 'flex-start', gap: 8,
                      }}>
                        <span style={{ fontSize: 14, flexShrink: 0 }}>⚠️</span>
                        <div>
                          <span style={{
                            color: '#f59e0b', fontSize: 9, fontFamily: 'JetBrains Mono, monospace',
                            letterSpacing: '0.06em', display: 'block', marginBottom: 3,
                          }}>RIESGO NO RESUELTO</span>
                          <p style={{
                            color: '#a0a0c0', fontSize: 11, margin: 0,
                            fontFamily: 'JetBrains Mono, monospace', lineHeight: 1.5,
                          }}>
                            {auditVerdict.riesgo_no_resuelto}
                          </p>
                        </div>
                      </div>
                    )}

                    {/* Repo selector */}
                    {onSendToAgent && (
                      <div style={{
                        background: '#0d0d1a', border: '1px solid #1e1e3f',
                        borderRadius: 6, padding: '8px 12px',
                        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                      }}>
                        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: '#3a3a5c' }}>
                          // repo objetivo
                        </span>
                        {!showRepoSelector && detectedRepo && !targetRepo ? (
                          <>
                            <span style={{ fontSize: 10, color: '#00ff88', fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
                              🎯 {detectedRepo}
                            </span>
                            <button
                              onClick={() => setShowRepoSelector(true)}
                              style={{
                                background: 'transparent', border: '1px solid #1e1e3f', borderRadius: 4,
                                color: '#6b7280', fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
                                padding: '2px 8px', cursor: 'pointer',
                              }}
                            >
                              Cambiar
                            </button>
                          </>
                        ) : (
                          <select
                            value={targetRepo || detectedRepo || PROJECT_NAMES[0]}
                            onChange={(e) => { setTargetRepo(e.target.value); setShowRepoSelector(false); }}
                            style={{
                              background: '#12121A', border: '1px solid #1e1e3f', borderRadius: 4,
                              color: '#e2e8f0', fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
                              padding: '4px 8px', cursor: 'pointer', outline: 'none',
                            }}
                          >
                            {PROJECT_NAMES.map((name) => (
                              <option key={name} value={name}>{name}</option>
                            ))}
                          </select>
                        )}
                      </div>
                    )}
                  </div>

                ) : (

                  /* ── FALLBACK — consensus como texto si no parsea JSON ── */
                  <>
                    <div style={{
                      background: '#0a1a0f', border: '1px solid #1e3f2a', borderLeft: '4px solid #00ff88',
                      borderRadius: 6, overflow: 'hidden', boxShadow: '0 0 20px rgba(0,255,136,0.08)',
                    }}>
                      <div style={{
                        padding: '10px 16px', background: 'rgba(0,255,136,0.06)',
                        borderBottom: '1px solid #1e3f2a', display: 'flex', alignItems: 'center', gap: 10,
                      }}>
                        <span style={{ color: '#00ff88', fontSize: 16 }}>⚛</span>
                        <span style={{ color: '#00ff88', fontSize: 13, fontWeight: 700, letterSpacing: '0.08em' }}>CONSENSUS</span>
                        <span style={{ color: '#6b7280', fontSize: 11 }}>— synthesized from all perspectives</span>
                      </div>
                      <div style={{ padding: 16, whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}>
                        <QuarkMarkdown>{consensus}</QuarkMarkdown>
                      </div>
                    </div>
                    {onSendToAgent && (
                      <div style={{
                        marginTop: 12, background: '#0d0d1a', border: '1px solid #1e1e3f',
                        borderRadius: 8, padding: '12px 14px',
                      }}>
                        <button
                          onClick={handleSendToAgent}
                          style={{
                            width: '100%', padding: '12px 16px',
                            background: 'linear-gradient(135deg, #7C3AED, #6D28D9)',
                            border: 'none', borderRadius: 8, color: '#fff',
                            fontFamily: 'JetBrains Mono, monospace', fontSize: 13, fontWeight: 700,
                            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                          }}
                        >
                          ⚡ Enviar al Agent → {effectiveRepo}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}
