import { LiveProvider, LivePreview, LiveError } from 'react-live';

interface Props {
  code: string;
  language: string;
  filename?: string;
}

const REACT_LANGS = new Set(['tsx', 'jsx', 'typescript', 'javascript', 'ts', 'js']);

function isReactLang(language: string, filename?: string): boolean {
  if (filename) {
    const name = filename.toLowerCase();
    if (name.endsWith('.tsx') || name.endsWith('.jsx') || name.endsWith('.js') || name.endsWith('.ts')) {
      return true;
    }
    if (name.endsWith('.css') || name.endsWith('.html') || name.endsWith('.md')) return false;
  }
  return REACT_LANGS.has(language.toLowerCase());
}

export default function SandpackPreview({ code, language, filename }: Props) {
  if (!isReactLang(language, filename)) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', padding: 24, color: '#3a3a5c',
        fontFamily: 'JetBrains Mono, monospace', fontSize: 12,
        background: '#08080f', textAlign: 'center',
        whiteSpace: 'pre-line', lineHeight: 1.7,
      }}>
        Solo se puede previsualizar componentes React (.tsx)
      </div>
    );
  }

  if (!code || !code.trim()) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', color: '#3a3a5c',
        fontFamily: 'JetBrains Mono, monospace', fontSize: 12,
        background: '#08080f',
      }}>
        El editor está vacío
      </div>
    );
  }

  return (
    <div style={{ height: '100%', background: '#08080f', overflow: 'auto' }}>
      <LiveProvider code={code} noInline={false}>
        <div style={{
          background: '#0a0a0a',
          minHeight: 300,
          padding: 16,
        }}>
          <LivePreview />
        </div>
        <LiveError style={{
          color: '#ff4444',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11,
          padding: '8px 16px',
          background: '#1a0a0a',
          borderTop: '1px solid #3a1a1a',
          margin: 0,
          whiteSpace: 'pre-wrap',
          display: 'block',
        }} />
      </LiveProvider>
    </div>
  );
}
