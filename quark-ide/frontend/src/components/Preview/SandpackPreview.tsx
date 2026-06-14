const API_BASE = (import.meta.env.VITE_API_URL ?? window.location.origin).replace(/\/$/, '');

interface Props {
  code: string;
  language: string;
  filename?: string;
}

const SUPPORTED = new Set([
  'html', 'css',
  'javascript', 'js', 'jsx',
  'typescript', 'ts', 'tsx',
]);

function detectLanguage(filename: string): string | null {
  const name = filename.toLowerCase();
  if (name.endsWith('.tsx')) return 'tsx';
  if (name.endsWith('.ts'))  return 'tsx';
  if (name.endsWith('.jsx')) return 'jsx';
  if (name.endsWith('.js'))  return 'jsx';
  if (name.endsWith('.html')) return 'html';
  if (name.endsWith('.css'))  return 'css';
  return null;
}

function codeHasReact(code: string): boolean {
  return /React|JSX|<[A-Z][a-zA-Z]*[\s/>]|<[a-z]+[\s/>]/.test(code);
}

function resolveLanguage(
  language: string,
  code: string,
  filename?: string,
): { lang: string; unsupported?: string } {
  if (filename) {
    const fromFile = detectLanguage(filename);
    if (fromFile) return { lang: fromFile };
  }

  const raw = language.toLowerCase();

  if (raw === 'typescript') {
    if (codeHasReact(code)) return { lang: 'tsx' };
    return {
      lang: '__ts_unsupported__',
      unsupported:
        'TypeScript puro no puede previsualizarse.\nUsa un componente React (.tsx)',
    };
  }

  if (raw === 'javascript') return { lang: 'jsx' };
  if (SUPPORTED.has(raw)) return { lang: raw };
  return { lang: raw };
}

export default function SandpackPreview({ code, language, filename }: Props) {
  const { lang, unsupported } = resolveLanguage(language, code, filename);

  if (unsupported || !SUPPORTED.has(lang)) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        padding: 24,
        color: '#3a3a5c',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 12,
        background: '#08080f',
        textAlign: 'center',
        whiteSpace: 'pre-line',
        lineHeight: 1.7,
      }}>
        {unsupported ?? 'Preview no disponible para este tipo de archivo'}
      </div>
    );
  }

  if (!code || code.trim() === '') {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: '#3a3a5c',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 12,
        background: '#08080f',
      }}>
        El editor está vacío
      </div>
    );
  }

  async function openPreview() {
    // Open the window synchronously inside the click handler — Safari requires
    // window.open() to be called before any async operation or it gets blocked.
    const win = window.open('about:blank', '_blank');
    if (!win) return;

    try {
      const res = await fetch(`${API_BASE}/api/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, language }),
      });
      const { id } = await res.json() as { id: string };
      win.location.href = `${API_BASE}/api/preview/${id}`;
    } catch {
      win.close();
    }
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      gap: 12,
      background: '#08080f',
    }}>
      <button
        onClick={openPreview}
        style={{
          background: '#00ff88',
          color: '#08080f',
          border: 'none',
          borderRadius: 8,
          padding: '12px 28px',
          fontFamily: 'JetBrains Mono, monospace',
          fontWeight: 700,
          fontSize: 15,
          cursor: 'pointer',
          letterSpacing: '0.04em',
        }}
      >
        🚀 Abrir Preview
      </button>
      <span style={{
        color: '#3a3a5c',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 11,
        textAlign: 'center',
      }}>
        Se abre en nueva pestaña — compatible con Safari iOS
      </span>
    </div>
  );
}
