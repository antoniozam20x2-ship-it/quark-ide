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

function buildReactTemplate(code: string, presets: string): string {
  const processedCode = injectDefaultExport(code);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
*, *::before, *::after { box-sizing: border-box; }
body { background: #08080f; color: #e2e8f0; font-family: sans-serif; margin: 0; padding: 0; }
#root { height: 100vh; }
#error { padding: 16px; color: #ff4444; font-family: 'JetBrains Mono', monospace; font-size: 13px; white-space: pre-wrap; }
</style>
</head>
<body>
<div id="root"></div>
<div id="error"></div>
<script src="https://unpkg.com/react@18/umd/react.development.js" crossorigin></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js" crossorigin></script>
<script src="https://unpkg.com/@babel/standalone@7/babel.min.js"></script>
<script type="text/babel" data-presets="${presets}">
${processedCode}

try {
  const exports_ = typeof module !== 'undefined' && module.exports ? module.exports : {};
  const DefaultExport = typeof App !== 'undefined' ? App : exports_.default ?? null;
  if (DefaultExport) {
    ReactDOM.createRoot(document.getElementById('root')).render(
      React.createElement(DefaultExport)
    );
  } else {
    document.getElementById('error').textContent = 'No se encontró un componente exportado por defecto (App).';
  }
} catch(e) {
  document.getElementById('error').textContent = 'Error al renderizar: ' + e.message;
}
</script>
</body>
</html>`;
}

function buildSrcdoc(code: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <style>* { margin: 0; padding: 0; box-sizing: border-box; }</style>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel" data-type="module">
    ${code}
    
    const __Component = typeof CryptoDashboard !== 'undefined' ? CryptoDashboard
      : typeof App !== 'undefined' ? App
      : typeof Default !== 'undefined' ? Default
      : null;
    
    if (__Component) {
      ReactDOM.createRoot(document.getElementById('root')).render(
        React.createElement(__Component)
      );
    } else {
      document.getElementById('root').innerHTML = 
        '<p style="color:red">No se encontró componente exportado</p>';
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

  const srcdoc = buildSrcdoc(code);

  return (
    <iframe
      key={srcdoc}
      srcDoc={srcdoc}
      sandbox="allow-scripts allow-same-origin"
      style={{
        width: '100%',
        height: '100%',
        border: 'none',
        background: '#08080f',
        display: 'block',
      }}
      title="QUARK Preview"
    />
  );
}
