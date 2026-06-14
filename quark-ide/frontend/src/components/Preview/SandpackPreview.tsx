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

function hasDefaultExport(code: string): boolean {
  return /export\s+default\s/m.test(code);
}

function findFirstComponentName(code: string): string | null {
  const patterns = [
    /^(?:export\s+(?:default\s+)?)?function\s+([A-Z][a-zA-Z0-9]*)\s*[(<]/m,
    /^(?:export\s+)?const\s+([A-Z][a-zA-Z0-9]*)\s*(?::\s*React\.(?:FC|VFC|ComponentType|ReactNode)[^=]*)?=\s*(?:\(|React\.memo|React\.forwardRef)/m,
    /^(?:export\s+)?const\s+([A-Z][a-zA-Z0-9]*)\s*:/m,
    /^(?:export\s+)?class\s+([A-Z][a-zA-Z0-9]*)\s/m,
  ];
  for (const p of patterns) {
    const m = p.exec(code);
    if (m) return m[1];
  }
  return null;
}

function injectDefaultExport(code: string): string {
  if (hasDefaultExport(code)) return code;
  const name = findFirstComponentName(code);
  if (name) return `${code}\nexport default ${name};`;
  return code;
}

function buildSrcdoc(code: string): string {
  const processedCode = injectDefaultExport(code);
  const componentName = findFirstComponentName(code) || 'App';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; }
    body { background: #0a0a0a; }
    #error { color: red; padding: 1rem; font-family: monospace; white-space: pre-wrap; }
  </style>
</head>
<body>
  <div id="root"></div>
  <div id="error"></div>
  <script type="text/babel" data-presets="react,typescript">
    ${processedCode}
    try {
      const C = typeof ${componentName} !== 'undefined'
        ? ${componentName} : null;
      if (C) {
        ReactDOM.createRoot(document.getElementById('root'))
          .render(React.createElement(C));
      } else {
        document.getElementById('error').textContent =
          'Componente no encontrado: ${componentName}';
      }
    } catch(e) {
      document.getElementById('error').textContent = 'Error: ' + e.message;
    }
  </script>
</body>
</html>`;
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

  const srcdoc = buildSrcdoc(code);

  return (
    <iframe
      key={srcdoc}
      srcDoc={srcdoc}
      sandbox="allow-scripts"
      style={{
        width: '100%',
        height: '100%',
        border: 'none',
        display: 'block',
        background: '#0a0a0a',
      }}
      title="QUARK Preview"
    />
  );
}
