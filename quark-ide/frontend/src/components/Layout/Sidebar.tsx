import { Page } from '../../App';

interface Props {
  activePage: Page;
  onNavigate: (page: Page) => void;
}

export default function Sidebar({ activePage, onNavigate }: Props) {
  return (
    <div
      className="flex flex-col items-center py-3 gap-1 flex-shrink-0"
      style={{
        width: 56,
        background: '#0d0d1a',
        borderRight: '1px solid #1e1e3f',
        height: '100dvh',
        maxHeight: '100dvh',
        overflow: 'hidden',
      }}
    >
      {/* Logo */}
      <div className="flex flex-col items-center mb-4 px-1">
        <span
          className="text-lg font-bold"
          style={{
            color: '#00ff88',
            textShadow: '0 0 10px rgba(0,255,136,0.5)',
            fontFamily: 'JetBrains Mono, monospace',
            lineHeight: 1,
          }}
        >
          ⚛
        </span>
      </div>

      {/* Editor Nav */}
      <NavItem
        icon="💻"
        label="Editor"
        active={activePage === 'editor'}
        onClick={() => onNavigate('editor')}
      />

      {/* War Room Nav */}
      <NavItem
        icon="🧠"
        label="War Room"
        active={activePage === 'warroom'}
        onClick={() => onNavigate('warroom')}
        violet
      />

      {/* Debugger Nav */}
      <NavItem
        icon="🤖"
        label="Debugger"
        active={activePage === 'debugger'}
        onClick={() => onNavigate('debugger')}
        red
      />

      <div className="flex-1" />

      {/* Settings */}
      <NavItem icon="⚙" label="Settings" active={false} onClick={() => {}} />
    </div>
  );
}

function NavItem({
  icon,
  label,
  active,
  onClick,
  violet,
  red,
}: {
  icon: string;
  label: string;
  active: boolean;
  onClick: () => void;
  violet?: boolean;
  red?: boolean;
}) {
  const activeColor = violet ? '#7c3aed' : red ? '#ff4444' : '#00ff88';
  return (
    <button
      onClick={onClick}
      title={label}
      style={{
        width: 44,
        height: 44,
        background: active ? (violet ? 'rgba(124,58,237,0.12)' : 'rgba(0,255,136,0.08)') : 'transparent',
        border: 'none',
        borderRadius: 6,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 18,
        position: 'relative',
        transition: 'all 0.15s ease',
        borderLeft: active ? `2px solid ${activeColor}` : '2px solid transparent',
      }}
    >
      {icon}
    </button>
  );
}
