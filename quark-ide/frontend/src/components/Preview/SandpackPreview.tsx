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
  // 1. Filename takes highest priority
  if (filename) {
    const fromFile = detectLanguage(filename);
    if (fromFile) return { lang: fromFile };
  }

  const raw = language.toLowerCase();

  // 2. Monaco returns "typescript" for both .ts and .tsx
  if (raw === 'typescript') {
    if (codeHasReact(code)) return { lang: 'tsx' };
    return {
      lang: '__ts_unsupported__',
      unsupported:
        'TypeScript puro no puede previsualizarse.\nUsa un componente React (.tsx)',
    };
  }

  // 3. Monaco returns "javascript" for both .js and .jsx
  if (raw === 'javascript') return { lang: 'jsx' };

  if (SUPPORTED.has(raw)) return { lang: raw };

  return { lang: raw };
}

function hasDefaultExport(code: string): boolean {
  return /export\s+default\s/m.test(code);
}

function findFirstComponentName(code: string): string | null {
  const patterns = [
    // function Component() / function Component<T>()
    /^(?:export\s+(?:default\s+)?)?function\s+([A-Z][a-zA-Z0-9]*)\s*[(<]/m,
    // const Component: React.FC = ... / const Component = () => / const Component = (
    /^(?:export\s+)?const\s+([A-Z][a-zA-Z0-9]*)\s*(?::\s*React\.(?:FC|VFC|ComponentType|ReactNode)[^=]*)?=\s*(?:\(|React\.memo|React\.forwardRef)/m,
    // const Component: React.FC<...> (with generic)
    /^(?:export\s+)?const\s+([A-Z][a-zA-Z0-9]*)\s*:/m,
    // class Component
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
  <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0a0a0a; }
    #error { color: red; padding: 1rem; font-family: monospace; }
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
      document.getElementById('error').textContent = 
        'Error: ' + e.message;
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
        color: 'red',
        padding: '2rem',
        fontFamily: 'monospace',
        fontSize: '14px',
        background: '#0a0a0a'
      }}>
        ⚠️ ERROR: code prop está vacío o undefined
      </div>
    );
  }

  const srcdoc = buildSrcdoc(code);

  console.log('PREVIEW rendering:', {
    codeLength: code?.length,
    language,
    filename,
    lang
  });

  return (
    <div style={{
      width: '100%',
      height: '100%',
      minHeight: '300px',
      overflow: 'auto',
      background: '#0a0a0a',
      display: 'flex',
      flexDirection: 'column'
    }}>
      <div style={{
        color: '#00ff88',
        padding: '4px 1rem',
        fontFamily: 'monospace',
        fontSize: '11px',
        flexShrink: 0
      }}>
        ✅ code.length: {code.length} | lang: {lang} | filename: {filename}
      </div>
      <iframe
        key={srcdoc}
        srcDoc={srcdoc}

        style={{
          flex: 1,
          width: '100%',
          minHeight: '250px',
          height: '100%',
          border: 'none',
          display: 'block',
          background: '#0a0a0a'
        }}
        title="QUARK Preview"
      />
    </div>
  );
}
