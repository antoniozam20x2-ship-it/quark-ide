import { useState } from 'react';
import Sidebar from './components/Layout/Sidebar';
import EditorPage from './pages/EditorPage';
import WarRoomPage from './pages/WarRoomPage';
import DebuggerPage from './pages/DebuggerPage';

export type Page = 'editor' | 'warroom' | 'debugger';

export interface Project {
  name: string;
  emoji: string;
  repo: string;
  branch: string;
  railwayProjectId: string;
}

export const PROJECTS: Project[] = [
  { name: 'Quark IDE',  emoji: '⚛️', repo: 'quark-ide',      branch: 'main', railwayProjectId: '5434ca01-48b0-4e39-82ee-67acdaa6d8af' },
  { name: 'Signal OS',  emoji: '⚡', repo: 'Ahorar',          branch: 'main', railwayProjectId: '9e886245-114f-4bdf-9aa5-c87333aeef0a' },
  { name: 'Sniper OS',  emoji: '🎯', repo: 'Trade-SnipeOS',   branch: 'main', railwayProjectId: '70612f14-41c5-48d5-9eb9-757861906b55' },
  { name: 'Nexus OS',   emoji: '🌐', repo: 'NEXUS-OS-app',    branch: 'main', railwayProjectId: 'e4aac26a-e4d4-44fc-84a6-9bbef1ace410' },
  { name: 'Core AI',    emoji: '🤖', repo: 'Code-Coretest',   branch: 'main', railwayProjectId: '3a13a380-68cb-43dd-a45b-2016fcb7baf0' },
];

export default function App() {
  const [page, setPage]                   = useState<Page>('editor');
  const [activeProject, setActiveProject] = useState<Project>(PROJECTS[0]);

  return (
    <div
      className="flex w-screen overflow-hidden"
      style={{ background: '#08080f', height: '100dvh', maxHeight: '100dvh' }}
    >
      <Sidebar activePage={page} onNavigate={setPage} />
      <div className="flex-1" style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'clip' }}>
        {page === 'editor'   && <EditorPage   activeProject={activeProject} onProjectChange={setActiveProject} />}
        {page === 'warroom'  && <WarRoomPage />}
        {page === 'debugger' && <DebuggerPage railwayProjectId={activeProject.railwayProjectId} projectName={activeProject.name} />}
      </div>
    </div>
  );
}
