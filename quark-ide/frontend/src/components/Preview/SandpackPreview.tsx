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

function cleanForPreview(code: string): string {
  return code
    // Eliminar todos los imports
    .split('\n')
    .filter(line => !line.trim().startsWith('import'))
    .join('\n')
    // Eliminar tipos TypeScript
    .replace(/:\s*(string|number|boolean|void|any|null|undefined|React\.FC|FC|ReactNode|React\.ReactNode)(\s*[=,\)\{>;])/g, '$2')
    // Eliminar generics simples
    .replace(/<(string|number|boolean|null|undefined|any)>/g, '')
    // Eliminar React.FC
    .replace(/:\s*React\.FC(\s*=)/g, '$1')
    .replace(/:\s*FC(\s*=)/g, '$1')
    // Eliminar interface y type blocks
    .replace(/^(export\s+)?(interface|type)\s+\w+[^{]*\{[^}]*\}/gm, '')
    // Eliminar export
    .replace(/export default /g, '')
    .replace(/export const /g, 'const ')
    .replace(/export function /g, 'function ')
    .trim();
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

  const cleanCode = cleanForPreview(code);

  return (
    <div style={{ height: '100%', background: '#08080f', overflow: 'auto' }}>
      <LiveProvider code={cleanCode} noInline={false}>
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
