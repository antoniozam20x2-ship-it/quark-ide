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

function hasDefaultExport(code: string): boolean {
  return /export\s+default\s/m.test(code);
}

function findFirstComponentName(code: string): string | null {
  const patterns = [
    /^(?:export\s+(?:default\s+)?)?function\s+([A-Z][a-zA-Z0-9]*)\s*[(<]/m,
    /^(?:export\s+)?const\s+([A-Z][a-zA-Z0-9]*)\s*[:=]/m,
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

function buildSrcdoc(code: string, lang: string): string {
  // template="react-ts"  →  App.tsx
  if (lang === 'ts' || lang === 'tsx' || lang === 'typescript') {
    return buildReactTemplate(code, 'react,typescript');
  }

  // template="react"  →  App.jsx
  if (lang === 'js' || lang === 'jsx' || lang === 'javascript') {
    return buildReactTemplate(code, 'react');
  }

  // template="vanilla"  →  index.html
  if (lang === 'html') {
    return code;
  }

  if (lang === 'css') {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
*, *::before, *::after { box-sizing: border-box; }
body { background: #1a1a2e; color: #e2e8f0; font-family: sans-serif; padding: 24px; margin: 0; }
${code}
</style>
</head>
<body>
<div class="preview-content">
  <h1>CSS Preview</h1>
  <p>Your styles are applied to this document.</p>
  <button class="btn">Button</button>
  <input class="input" placeholder="Input field" />
</div>
</body>
</html>`;
  }

  return '';
}

export default function SandpackPreview({ code, language, filename }: Props) {
  const rawLang = language.toLowerCase();
  const needsFallback = !rawLang || rawLang === 'typescript' || rawLang === 'javascript' || !SUPPORTED.has(rawLang);
  const lang = (needsFallback && filename ? detectLanguage(filename) : null) ?? rawLang;
  const supported = SUPPORTED.has(lang);

  if (!supported) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: '#3a3a5c',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 13,
        background: '#08080f',
      }}>
        Preview no disponible para este tipo de archivo
      </div>
    );
  }

  const srcdoc = buildSrcdoc(code, lang);

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
