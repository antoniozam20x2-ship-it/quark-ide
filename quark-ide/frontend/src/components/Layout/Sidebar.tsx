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
      {/* Agent Nav — logo + nav fusionados */}
      <NavItem
        icon="⚛"
        label="Agent"
        active={activePage === 'agent'}
        onClick={() => onNavigate('agent')}
        violet
        large
      />

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

      {/* Studio Nav */}
      <NavItem
        icon="🎨"
        label="Studio"
        active={activePage === 'studio'}
        onClick={() => onNavigate('studio')}
        violet
      />

      {/* Health Nav */}
      <NavItem
        icon="🔑"
        label="API Health"
        active={activePage === 'health'}
        onClick={() => onNavigate('health')}
      />

      {/* Chat Nav */}
      <NavItem
        icon="💬"
        label="Chat"
        active={activePage === 'chat'}
        onClick={() => onNavigate('chat')}
        violet
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
  large,
}: {
  icon: string;
  label: string;
  active: boolean;
  onClick: () => void;
  violet?: boolean;
  red?: boolean;
  large?: boolean;
}) {
  const activeColor = violet ? '#7c3aed' : red ? '#ff4444' : '#00ff88';
  return (
    <button
      onClick={onClick}
      title={label}
      style={{
        width: 44,
        height: large ? 52 : 44,
        background: active ? (violet ? 'rgba(124,58,237,0.12)' : 'rgba(0,255,136,0.08)') : 'transparent',
        border: 'none',
        borderRadius: 6,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: large ? 26 : 18,
        position: 'relative',
        transition: 'all 0.15s ease',
        borderLeft: active ? `2px solid ${activeColor}` : '2px solid transparent',
        marginBottom: large ? 6 : 0,
      }}
    >
      {icon}
    </button>
  );
}
