import { useState, useEffect, useRef } from 'react';
import type { editor } from 'monaco-editor';
import TopBar from '../components/Layout/TopBar';
import CodeEditor from '../components/Editor/CodeEditor';
import ClaudeChat from '../components/Editor/ClaudeChat';
import GitHubFileTree from '../components/FileTree/FileTree';

interface FileEntry {
  name: string;
  content: string;
  language: string;
}

const INITIAL_FILES: FileEntry[] = [
  {
    name: 'index.ts',
    language: 'typescript',
    content: `// Welcome to QUARK IDE ⚛
// Build at the speed of thought

interface Project {
  name: string;
  description: string;
  version: string;
}

const project: Project = {
  name: 'my-project',
  description: 'Built with QUARK IDE',
  version: '1.0.0',
};

console.log(project);
`,
  },
  {
    name: 'README.md',
    language: 'markdown',
    content: `# my-project

> Built with ⚛ QUARK IDE — Build at the speed of thought

## Getting Started

\`\`\`bash
npm install
npm run dev
\`\`\`

## About

This project was scaffolded using QUARK IDE's AI-powered War Room.
`,
  },
  {
    name: '.env.example',
    language: 'plaintext',
    content: `# Environment Variables
PORT=3000
NODE_ENV=development
`,
  },
];

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return isMobile;
}

function FileTree({
  files,
  activeFile,
  onSelect,
  onNewFile,
}: {
  files: FileEntry[];
  activeFile: FileEntry;
  onSelect: (f: FileEntry) => void;
  onNewFile: () => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{
        padding: '8px 12px',
        borderBottom: '1px solid #1e1e3f',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <span style={{ color: '#6b7280', fontSize: 11, letterSpacing: '0.08em' }}>MY-PROJECT</span>
        <button
          onClick={onNewFile}
          title="New file"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', fontSize: 16, lineHeight: 1, padding: 0 }}
        >
          +
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {files.map((f) => (
          <button
            key={f.name}
            onClick={() => onSelect(f)}
            style={{
              display: 'block',
              width: '100%',
              background: activeFile.name === f.name ? 'rgba(0,255,136,0.08)' : 'transparent',
              border: 'none',
              borderLeft: `2px solid ${activeFile.name === f.name ? '#00ff88' : 'transparent'}`,
              padding: '6px 12px',
              textAlign: 'left',
              color: activeFile.name === f.name ? '#e2e8f0' : '#6b7280',
              fontSize: 12,
              fontFamily: 'JetBrains Mono, monospace',
              cursor: 'pointer',
              transition: 'all 0.1s',
            }}
          >
            {f.name}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function EditorPage() {
  const isMobile = useIsMobile();
  const [files, setFiles] = useState<FileEntry[]>(INITIAL_FILES);
  const [activeFile, setActiveFile] = useState<FileEntry>(INITIAL_FILES[0]);
  const [mobileTab, setMobileTab] = useState<'editor' | 'chat'>('editor');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  // Close drawer when clicking outside
  useEffect(() => {
    if (!drawerOpen) return;
    function handleClick(e: MouseEvent) {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        setDrawerOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [drawerOpen]);

  function updateFile(content: string) {
    setFiles((prev) =>
      prev.map((f) => (f.name === activeFile.name ? { ...f, content } : f))
    );
    setActiveFile((prev) => ({ ...prev, content }));
    // Scroll back to top after applying code from QUARK
    setTimeout(() => editorRef.current?.revealLine(1), 80);
  }

  function setLanguage(lang: string) {
    setFiles((prev) =>
      prev.map((f) => (f.name === activeFile.name ? { ...f, language: lang } : f))
    );
    setActiveFile((prev) => ({ ...prev, language: lang }));
  }

  function newFile() {
    const name = prompt('File name:');
    if (!name?.trim()) return;
    const entry: FileEntry = { name: name.trim(), content: '', language: 'typescript' };
    setFiles((prev) => [...prev, entry]);
    setActiveFile(entry);
    setDrawerOpen(false);
  }

  function selectFile(f: FileEntry) {
    setActiveFile(files.find((x) => x.name === f.name) ?? f);
    setDrawerOpen(false);
  }

  function handleGithubFileSelect(path: string, content: string) {
    const existing = files.find((f) => f.name === path);
    const ext = path.split('.').pop() ?? '';
    const langMap: Record<string, string> = {
      ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
      py: 'python', html: 'html', css: 'css', json: 'json', md: 'markdown',
    };
    const language = langMap[ext] ?? 'plaintext';
    if (existing) {
      setFiles((prev) => prev.map((f) => f.name === path ? { ...f, content } : f));
      setActiveFile({ name: path, content, language: existing.language });
    } else {
      const entry: FileEntry = { name: path, content, language };
      setFiles((prev) => [...prev, entry]);
      setActiveFile(entry);
    }
    setDrawerOpen(false);
  }

  // ── MOBILE LAYOUT ──────────────────────────────────────────────────
  if (isMobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden', background: '#08080f' }}>

        {/* Mobile TopBar with hamburger + tabs */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          height: 44,
          flexShrink: 0,
          background: '#0d0d1a',
          borderBottom: '1px solid #1e1e3f',
          gap: 0,
        }}>
          {/* Hamburger */}
          <button
            onClick={() => setDrawerOpen((o) => !o)}
            style={{
              width: 44,
              height: 44,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: '#6b7280',
              fontSize: 18,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ☰
          </button>

          {/* Filename */}
          <span style={{
            color: '#6b7280',
            fontSize: 11,
            fontFamily: 'JetBrains Mono, monospace',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
            minWidth: 0,
          }}>
            {activeFile.name}
          </span>

          {/* Tabs */}
          <div style={{ display: 'flex', gap: 0, flexShrink: 0, paddingRight: 8 }}>
            {([
              { key: 'editor', label: '</> EDITOR' },
              { key: 'chat', label: '⚛ CHAT' },
            ] as const).map((t) => (
              <button
                key={t.key}
                onClick={() => setMobileTab(t.key)}
                style={{
                  background: mobileTab === t.key ? 'rgba(0,255,136,0.1)' : 'transparent',
                  border: '1px solid',
                  borderColor: mobileTab === t.key ? '#00ff88' : '#1e1e3f',
                  color: mobileTab === t.key ? '#00ff88' : '#6b7280',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 11,
                  fontWeight: mobileTab === t.key ? 700 : 400,
                  padding: '4px 10px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  marginLeft: 4,
                  transition: 'all 0.15s',
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Drawer overlay */}
        {drawerOpen && (
          <>
            {/* Backdrop */}
            <div style={{
              position: 'fixed', inset: 0, zIndex: 40,
              background: 'rgba(8,8,15,0.7)',
            }} onClick={() => setDrawerOpen(false)} />
            {/* Drawer */}
            <div
              ref={drawerRef}
              style={{
                position: 'fixed',
                top: 0,
                left: 56, // sidebar width
                width: 220,
                height: '100dvh',
                background: '#0d0d1a',
                borderRight: '1px solid #1e1e3f',
                zIndex: 50,
                display: 'flex',
                flexDirection: 'column',
                overflowY: 'auto',
              }}
            >
              <FileTree
                files={files}
                activeFile={activeFile}
                onSelect={selectFile}
                onNewFile={newFile}
              />
              <GitHubFileTree onFileSelect={handleGithubFileSelect} />
            </div>
          </>
        )}

        {/* Tab content */}
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {mobileTab === 'editor' ? (
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              {/* Language selector strip */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                padding: '4px 8px',
                gap: 8,
                borderBottom: '1px solid #1e1e3f',
                background: '#0d0d1a',
                flexShrink: 0,
              }}>
                <select
                  value={activeFile.language}
                  onChange={(e) => setLanguage(e.target.value)}
                  style={{
                    background: '#111127',
                    border: '1px solid #1e1e3f',
                    color: '#e2e8f0',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 11,
                    padding: '2px 6px',
                    borderRadius: 4,
                    outline: 'none',
                  }}
                >
                  {['typescript','javascript','python','html','css','json','markdown'].map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
              </div>
              {/* Editor fills remainder */}
              <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
                <CodeEditor
                  value={activeFile.content}
                  language={activeFile.language}
                  onChange={updateFile}
                  onEditorReady={(ed) => { editorRef.current = ed; }}
                />
              </div>
            </div>
          ) : (
            <ClaudeChat
              fileContent={activeFile.content}
              fileName={activeFile.name}
              onApplyToEditor={(code) => {
                updateFile(code);
                setMobileTab('editor');
              }}
              layout="fullscreen"
            />
          )}
        </div>
      </div>
    );
  }

  // ── DESKTOP LAYOUT ─────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden' }}>
      <TopBar
        fileName={activeFile.name}
        language={activeFile.language}
        onLanguageChange={setLanguage}
        onRun={() => alert('Run: ' + activeFile.name)}
      />

      {/* 3-column body */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>

        {/* Col 1: File tree */}
        <div style={{
          width: 220,
          flexShrink: 0,
          background: '#0d0d1a',
          borderRight: '1px solid #1e1e3f',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}>
          <FileTree
            files={files}
            activeFile={activeFile}
            onSelect={selectFile}
            onNewFile={newFile}
          />
          <GitHubFileTree onFileSelect={handleGithubFileSelect} />
        </div>

        {/* Col 2: Monaco editor */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
          <CodeEditor
            value={activeFile.content}
            language={activeFile.language}
            onChange={updateFile}
            onEditorReady={(ed) => { editorRef.current = ed; }}
          />
        </div>

        {/* Col 3: Chat sidebar */}
        <ClaudeChat
          fileContent={activeFile.content}
          fileName={activeFile.name}
          onApplyToEditor={updateFile}
          layout="panel"
        />
      </div>
    </div>
  );
}
