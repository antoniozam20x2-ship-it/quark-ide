import { useState, useEffect } from 'react';
import { PROJECTS, type Project } from '../../App';

const API_BASE = (import.meta.env.VITE_API_URL ?? window.location.origin).replace(/\/$/, '');

interface Props {
  activeProject: Project;
  onSwitch: (project: Project) => void;
}

interface RepoStatus {
  repo: string;
  cloned: boolean;
  syncedAt: string | null;
  filesChanged: number;
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'nunca sincronizado';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `hace ${hr}h`;
  return `hace ${Math.floor(hr / 24)}d`;
}

export default function ProjectSwitcher({ activeProject, onSwitch }: Props) {
  const [open, setOpen]             = useState(false);
  const [switching, setSwitching]   = useState(false);
  const [statuses, setStatuses]     = useState<Record<string, RepoStatus>>({});
  const [syncing, setSyncing]       = useState<string | null>(null);

  // Fetch repo status whenever dropdown opens
  useEffect(() => {
    if (!open) return;
    fetch(`${API_BASE}/api/repos/status`)
      .then(r => r.json())
      .then((list: RepoStatus[]) => {
        const map: Record<string, RepoStatus> = {};
        for (const s of list) map[s.repo] = s;
        setStatuses(map);
      })
      .catch(() => {/* silently ignore if repos API not yet available */});
  }, [open]);

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

  async function syncRepo(e: React.MouseEvent, repo: string) {
    e.stopPropagation(); // don't trigger switchProject
    if (syncing) return;
    setSyncing(repo);
    try {
      await fetch(`${API_BASE}/api/repos/${repo}/sync`, { method: 'POST' });
      // Refresh statuses after sync
      const res = await fetch(`${API_BASE}/api/repos/status`);
      const list: RepoStatus[] = await res.json();
      const map: Record<string, RepoStatus> = {};
      for (const s of list) map[s.repo] = s;
      setStatuses(map);
    } catch { /* ignore */ }
    finally { setSyncing(null); }
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
            const status   = statuses[p.repo];
            const isSyncing = syncing === p.repo;

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

                {/* Repo name + sync status */}
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
                    color: status?.cloned ? '#3a5c4a' : '#3a3a5c',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 9,
                    marginTop: 1,
                  }}>
                    {status
                      ? `${status.cloned ? '● ' : '○ '}${formatRelative(status.syncedAt)}`
                      : p.repo}
                  </div>
                </div>

                {/* Sync button */}
                <button
                  onClick={(e) => syncRepo(e, p.repo)}
                  disabled={isSyncing || !!syncing}
                  title={`Actualizar clon local de ${p.repo}`}
                  style={{
                    background: 'transparent',
                    border: '1px solid #1e1e3f',
                    borderRadius: 4,
                    color: isSyncing ? '#00ff88' : '#3a3a5c',
                    cursor: isSyncing || syncing ? 'wait' : 'pointer',
                    fontSize: 11,
                    padding: '2px 5px',
                    lineHeight: 1,
                    flexShrink: 0,
                    transition: 'color 0.15s, border-color 0.15s',
                    animation: isSyncing ? 'spin 1s linear infinite' : 'none',
                  }}
                  onMouseEnter={(e) => {
                    if (!isSyncing && !syncing)
                      (e.currentTarget as HTMLButtonElement).style.color = '#00ff88';
                  }}
                  onMouseLeave={(e) => {
                    if (!isSyncing)
                      (e.currentTarget as HTMLButtonElement).style.color = '#3a3a5c';
                  }}
                >
                  🔄
                </button>

                {isActive && (
                  <span style={{ color: '#00ff88', fontSize: 10, flexShrink: 0, marginLeft: 2 }}>●</span>
                )}
              </button>
            );
          })}

          <div style={{
            padding: '6px 12px',
            color: '#2a2a4c',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 9,
            borderTop: '1px solid #1e1e3f',
          }}>
            🔄 = clonar/actualizar repo local para búsqueda rápida
          </div>
        </div>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
