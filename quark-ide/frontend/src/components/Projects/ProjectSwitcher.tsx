import { useState } from 'react';
import { PROJECTS, type Project } from '../../App';

const API_BASE = (import.meta.env.VITE_API_URL ?? window.location.origin).replace(/\/$/, '');

interface Props {
  activeProject: Project;
  onSwitch: (project: Project) => void;
}

export default function ProjectSwitcher({ activeProject, onSwitch }: Props) {
  const [open, setOpen]           = useState(false);
  const [switching, setSwitching] = useState(false);

  async function switchProject(p: Project) {
    if (p.repo === activeProject.repo) { setOpen(false); return; }
    setSwitching(true);
    try {
      await fetch(`${API_BASE}/github/switch-project`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: p.repo, branch: p.branch }),
      });
      onSwitch(p);
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
        <span style={{ fontSize: 16, lineHeight: 1 }}>{activeProject.emoji}</span>
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
            {switching ? 'SWITCHING…' : activeProject.name.toUpperCase()}
          </div>
          <div style={{
            color: '#3a3a5c',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 10,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {activeProject.repo}/{activeProject.branch}
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
            const isActive = p.repo === activeProject.repo;
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
