import { useState } from 'react';

const API_BASE = (import.meta.env.VITE_API_URL ?? window.location.origin).replace(/\/$/, '');

const PROJECTS = [
  { name: 'Quark IDE',  emoji: '⚛️', repo: 'quark-ide',      branch: 'main', railwayProjectId: '5434ca01-48b0-4e39-82ee-67acdaa6d8af' },
  { name: 'Signal OS',  emoji: '⚡', repo: 'Ahorar',          branch: 'main', railwayProjectId: '9e886245-114f-4bdf-9aa5-c87333aeef0a' },
  { name: 'Sniper OS',  emoji: '🎯', repo: 'Trade-SnipeOS',   branch: 'main', railwayProjectId: '70612f14-41c5-48d5-9eb9-757861906b55' },
  { name: 'Nexus OS',   emoji: '🌐', repo: 'NEXUS-OS-app',    branch: 'main', railwayProjectId: 'e4aac26a-e4d4-44fc-84a6-9bbef1ace410' },
  { name: 'Core AI',    emoji: '🤖', repo: 'Code-Coretest',   branch: 'main', railwayProjectId: '3a13a380-68cb-43dd-a45b-2016fcb7baf0' },
];

interface Props {
  onSwitch: (repo: string, branch: string) => void;
}

export default function ProjectSwitcher({ onSwitch }: Props) {
  const [active, setActive]     = useState(PROJECTS[0]);
  const [open, setOpen]         = useState(false);
  const [switching, setSwitching] = useState(false);

  async function switchProject(p: typeof PROJECTS[0]) {
    if (p.repo === active.repo) { setOpen(false); return; }
    setSwitching(true);
    try {
      await fetch(`${API_BASE}/github/switch-project`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: p.repo, branch: p.branch }),
      });
      setActive(p);
      onSwitch(p.repo, p.branch);
    } finally {
      setSwitching(false);
      setOpen(false);
    }
  }

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      {/* Header button */}
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={switching}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          background: 'transparent',
          border: 'none',
          borderBottom: '1px solid #1e1e3f',
          cursor: switching ? 'wait' : 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 16, lineHeight: 1 }}>{active.emoji}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            color: '#00ff88',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.06em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {switching ? 'SWITCHING…' : active.name.toUpperCase()}
          </div>
          <div style={{
            color: '#3a3a5c',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 10,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {active.repo}/{active.branch}
          </div>
        </div>
        <span style={{
          color: '#3a3a5c',
          fontSize: 10,
          transform: open ? 'rotate(180deg)' : 'none',
          transition: 'transform 0.15s',
          flexShrink: 0,
        }}>▼</span>
      </button>

      {/* Dropdown */}
      {open && (
        <div style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          right: 0,
          zIndex: 100,
          background: '#0d0d1a',
          border: '1px solid #1e1e3f',
          borderTop: 'none',
          boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
        }}>
          {PROJECTS.map((p) => {
            const isActive = p.repo === active.repo;
            return (
              <button
                key={p.repo}
                onClick={() => switchProject(p)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 12px',
                  background: isActive ? 'rgba(0,255,136,0.06)' : 'transparent',
                  border: 'none',
                  borderLeft: `2px solid ${isActive ? '#00ff88' : 'transparent'}`,
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)';
                }}
                onMouseLeave={(e) => {
                  if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                }}
              >
                <span style={{ fontSize: 14, lineHeight: 1 }}>{p.emoji}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    color: isActive ? '#00ff88' : '#e2e8f0',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 11,
                    fontWeight: isActive ? 700 : 400,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {p.name}
                  </div>
                  <div style={{
                    color: '#3a3a5c',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 10,
                  }}>
                    {p.repo}
                  </div>
                </div>
                {isActive && (
                  <span style={{ color: '#00ff88', fontSize: 10, flexShrink: 0 }}>●</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
