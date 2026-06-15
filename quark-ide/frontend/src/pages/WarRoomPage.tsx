import { useState } from 'react';
import WarRoomPanel from '../components/WarRoom/WarRoomPanel';
import DeepSearch from '../components/WarRoom/DeepSearch';
import BoardRoom from '../components/WarRoom/BoardRoom';

type Tab = 'think' | 'search' | 'board';

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: 'think',  label: 'THINK',  icon: '🧐' },
  { key: 'search', label: 'SEARCH', icon: '🔦' },
  { key: 'board',  label: 'BOARD',  icon: '🎯' },
];

interface Props {
  initialBrief?: string;
  onBriefConsumed?: () => void;
  onSendToAgent?: (prompt: string) => void;
}

export default function WarRoomPage({ initialBrief, onBriefConsumed, onSendToAgent }: Props) {
  const [tab, setTab] = useState<Tab>(initialBrief ? 'board' : 'think');

  return (
    <div style={{ height: '100vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', background: '#08080f' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 20px',
          height: 48,
          background: '#0d0d1a',
          borderBottom: '1px solid #1e1e3f',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: '#7c3aed', fontSize: 16 }}>🧠</span>
          <span
            style={{
              color: '#e2e8f0',
              fontFamily: 'JetBrains Mono, monospace',
              fontWeight: 700,
              fontSize: 14,
              letterSpacing: '0.08em',
            }}
          >
            WAR ROOM
          </span>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4 }}>
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                background: tab === t.key ? 'rgba(124,58,237,0.15)' : 'transparent',
                border: `1px solid ${tab === t.key ? '#7c3aed' : '#1e1e3f'}`,
                color: tab === t.key ? '#e2e8f0' : '#6b7280',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 11,
                fontWeight: tab === t.key ? 700 : 400,
                padding: '5px 14px',
                borderRadius: 4,
                cursor: 'pointer',
                transition: 'all 0.15s ease',
                letterSpacing: '0.06em',
                boxShadow: tab === t.key ? '0 0 10px rgba(124,58,237,0.2)' : 'none',
              }}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div style={{ flex: 1, overflow: 'visible', padding: 20 }}>
        {tab === 'think'  && <WarRoomPanel />}
        {tab === 'search' && <DeepSearch />}
        {tab === 'board'  && (
          <BoardRoom
            initialBrief={initialBrief}
            onBriefConsumed={onBriefConsumed}
            onSendToAgent={onSendToAgent}
          />
        )}
      </div>
    </div>
  );
}
