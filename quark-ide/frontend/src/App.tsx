import { useState } from 'react';
import Sidebar from './components/Layout/Sidebar';
import EditorPage from './pages/EditorPage';
import WarRoomPage from './pages/WarRoomPage';
import DebuggerPage from './pages/DebuggerPage';

export type Page = 'editor' | 'warroom' | 'debugger';

export default function App() {
  const [page, setPage] = useState<Page>('editor');

  return (
    <div
      className="flex w-screen overflow-hidden"
      style={{ background: '#08080f', height: '100dvh', maxHeight: '100dvh' }}
    >
      <Sidebar activePage={page} onNavigate={setPage} />
      <div className="flex-1" style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'clip' }}>
        {page === 'editor' && <EditorPage />}
        {page === 'warroom' && <WarRoomPage />}
        {page === 'debugger' && <DebuggerPage />}
      </div>
    </div>
  );
}
