import { Routes, Route, Navigate } from 'react-router-dom';
import { useState } from 'react';
import Sidebar from './components/Layout/Sidebar';
import EditorPage from './pages/EditorPage';
import WarRoomPage from './pages/WarRoomPage';

export type Page = 'editor' | 'warroom';

export default function App() {
  const [page, setPage] = useState<Page>('editor');

  return (
    <div
      className="flex w-screen overflow-hidden"
      style={{ background: '#08080f', height: '100dvh', maxHeight: '100dvh' }}
    >
      <Sidebar activePage={page} onNavigate={setPage} />
      <div className="flex-1 overflow-hidden" style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {page === 'editor' ? <EditorPage /> : <WarRoomPage />}
      </div>
    </div>
  );
}
