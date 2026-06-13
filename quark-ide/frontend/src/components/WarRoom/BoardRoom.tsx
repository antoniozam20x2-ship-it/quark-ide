import { useState } from 'react';
import QuarkMarkdown from '../shared/QuarkMarkdown';

const API_BASE = (import.meta.env.VITE_API_URL ?? window.location.origin).replace(/\/$/, '');

type MemberKey = 'CEO' | 'CTO' | 'Designer' | 'QA';
type MemberStatus = 'idle' | 'thinking' | 'done' | 'error';

const MEMBERS: { key: MemberKey; icon: string; title: string; subtitle: string }[] = [
  { key: 'CEO', icon: '👔', title: 'CEO', subtitle: 'Business Strategy' },
  { key: 'CTO', icon: '🖥', title: 'CTO', subtitle: 'Tech Architecture' },
  { key: 'Designer', icon: '🎨', title: 'DESIGNER', subtitle: 'UX & Brand' },
  { key: 'QA', icon: '🛡', title: 'QA', subtitle: 'Risk & Testing' },
];

interface MemberResponse {
  role: MemberKey;
  response: string;
}

export default function BoardRoom() {
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
  const [processingTime, setProcessingTime] = useState<number | null>(null);

  function setStatus(key: MemberKey, s: MemberStatus) {
    setStatuses((prev) => ({ ...prev, [key]: s }));
  }

  function toggleExpanded(key: MemberKey) {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  async function conveneSwarm() {
    setRunning(true);
    setResponses([]);
    setConsensus('');
    setProcessingTime(null);
    setStatuses({ CEO: 'thinking', CTO: 'thinking', Designer: 'thinking', QA: 'thinking' });
    setExpanded({ CEO: false, CTO: false, Designer: false, QA: false });

    try {
      const res = await fetch(`${API_BASE}/api/warroom/swarm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge: challenge.trim() }),
      });
      const data = await res.json();

      if (data.error) throw new Error(data.error);

      const collected: MemberResponse[] = [
        { role: 'CEO', response: data.ceo ?? '' },
        { role: 'CTO', response: data.cto ?? '' },
        { role: 'Designer', response: data.designer ?? '' },
        { role: 'QA', response: data.qa ?? '' },
      ];

      setResponses(collected);
      setStatuses({ CEO: 'done', CTO: 'done', Designer: 'done', QA: 'done' });
      setConsensus(data.consensus ?? '');
      setProcessingTime(data.processingTime ?? null);
    } catch {
      setStatuses({ CEO: 'error', CTO: 'error', Designer: 'error', QA: 'error' });
      setConsensus('⚠ Swarm encountered an error. Try sequential mode.');
    } finally {
      setRunning(false);
    }
  }

  async function conveneSequential() {
    setRunning(true);
    setResponses([]);
    setConsensus('');
    setProcessingTime(null);
    setStatuses({ CEO: 'idle', CTO: 'idle', Designer: 'idle', QA: 'idle' });
    setExpanded({ CEO: false, CTO: false, Designer: false, QA: false });

    const collected: MemberResponse[] = [];

    for (const member of MEMBERS) {
      setStatus(member.key, 'thinking');
      try {
        const res = await fetch(`${API_BASE}/api/warroom/board`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challenge: challenge.trim(), member: member.key }),
        });
        const data = await res.json();
        const mr: MemberResponse = { role: member.key, response: data.response ?? data.error ?? '' };
        collected.push(mr);
        setResponses((prev) => [...prev, mr]);
        setStatus(member.key, 'done');
        await new Promise((r) => setTimeout(r, 300));
      } catch {
        setStatus(member.key, 'error');
        collected.push({ role: member.key, response: '⚠ Error fetching response.' });
        setResponses((prev) => [...prev, { role: member.key, response: '⚠ Error fetching response.' }]);
      }
    }

    setConsensus('generating');
    try {
      const summaryRes = await fetch(`${API_BASE}/api/warroom/board`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challenge: `Original challenge: ${challenge}\n\nBoard responses:\n${collected.map((r) => `${r.role}: ${r.response}`).join('\n\n')}\n\nSynthesize all perspectives into 3-5 clear, actionable consensus items.`,
          member: 'CEO',
        }),
      });
      const d = await summaryRes.json();
      setConsensus(d.response ?? '');
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
        .board-members-grid > * {
          min-width: 0;
          overflow: hidden;
        }
        @media (max-width: 767px) {
          .board-members-grid {
            grid-template-columns: repeat(2, 1fr);
            gap: 8px;
          }
        }
        .member-response-body {
          overflow: hidden;
          transition: max-height 0.25s ease;
        }
        .member-response-body.collapsed {
          max-height: 80px;
          -webkit-mask-image: linear-gradient(to bottom, black 40%, transparent 100%);
          mask-image: linear-gradient(to bottom, black 40%, transparent 100%);
        }
        .member-response-body.expanded {
          max-height: 2000px;
          -webkit-mask-image: none;
          mask-image: none;
        }
      `}</style>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <p style={{ color: '#6b7280', fontSize: 13, margin: 0 }}>
            Present your challenge to the board. Each member analyzes from their perspective.
          </p>
          {/* Mode toggle */}
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
            const isDone = status === 'done';
            const isError = status === 'error';
            return (
              <div
                key={m.key}
                style={{
                  background: '#0d0d1a',
                  border: `1px solid ${isActive ? '#00ff88' : isDone ? '#1e3f2a' : isError ? '#3f1e1e' : '#1e1e3f'}`,
                  borderRadius: 6, padding: '12px', transition: 'all 0.3s ease',
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
          <div style={{
            flex: 1,
            overflowY: 'auto',
            WebkitOverflowScrolling: 'touch' as any,
            paddingBottom: '80px',
          }}>
            {MEMBERS.map((m) => {
              const r = memberMap[m.key];
              if (!r) return null;
              const isExpanded = expanded[m.key];
              return (
                <div key={m.key} style={{ background: '#0d0d1a', border: '1px solid #1e1e3f', borderRadius: 6, overflow: 'hidden' }}>
                  {/* Header — fully clickable toggle */}
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

                  {/* Body — only rendered when expanded */}
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
                  {swarmMode && processingTime !== null && (
                    <span style={{
                      marginLeft: 'auto', background: 'rgba(0,255,136,0.1)', border: '1px solid #1e3f2a',
                      borderRadius: 3, padding: '1px 6px', color: '#00ff88', fontSize: 10, fontWeight: 700,
                      fontFamily: 'JetBrains Mono, monospace',
                    }}>
                      ⚡ {(processingTime / 1000).toFixed(1)}s parallel
                    </span>
                  )}
                </div>
                <div style={{ padding: 16, height: 'auto', whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}>
                  <QuarkMarkdown>{consensus}</QuarkMarkdown>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
