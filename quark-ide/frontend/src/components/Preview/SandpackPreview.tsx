interface Props {
  code: string;
  language: string;
}

const SUPPORTED = new Set(['html', 'css', 'javascript', 'js', 'typescript', 'ts', 'jsx', 'tsx']);

function buildSrcdoc(code: string, lang: string): string {
  const l = lang.toLowerCase();

  if (l === 'html') {
    return code;
  }

  if (l === 'css') {
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

  if (l === 'javascript' || l === 'js') {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
body { background: #08080f; color: #e2e8f0; font-family: 'JetBrains Mono', monospace;
  font-size: 13px; padding: 16px; margin: 0; }
#output { white-space: pre-wrap; word-break: break-all; line-height: 1.6; }
.err { color: #ff4444; }
</style>
</head>
<body>
<div id="output"></div>
<script>
const _el = document.getElementById('output');
const _orig = console.log;
const _err  = console.error;
const _warn = console.warn;
function _write(text, cls) {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = text;
  _el.appendChild(line);
}
console.log  = (...a) => { _orig(...a);  _write(a.map(x => typeof x === 'object' ? JSON.stringify(x,null,2) : String(x)).join(' ')); };
console.error= (...a) => { _err(...a);   _write('⚠ ' + a.join(' '), 'err'); };
console.warn = (...a) => { _warn(...a);  _write('⚡ ' + a.join(' ')); };
try {
${code}
} catch(e) { _write('⚠ ' + e.message, 'err'); }
</script>
</body>
</html>`;
  }

  if (l === 'jsx' || l === 'tsx') {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
body { background: #08080f; color: #e2e8f0; font-family: sans-serif; margin: 0; padding: 0; }
#root { padding: 16px; }
#error { padding: 16px; color: #ff4444; font-family: 'JetBrains Mono', monospace; font-size: 13px; white-space: pre-wrap; }
</style>
</head>
<body>
<div id="root"></div>
<div id="error"></div>
<script src="https://unpkg.com/react@18/umd/react.development.js" crossorigin></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js" crossorigin></script>
<script src="https://unpkg.com/@babel/standalone@7/babel.min.js"></script>
<script type="text/babel" data-presets="react,typescript">
${code}
try {
  const root = ReactDOM.createRoot(document.getElementById('root'));
  if (typeof App !== 'undefined') {
    root.render(React.createElement(App));
  } else if (typeof default_1 !== 'undefined') {
    root.render(React.createElement(default_1));
  } else {
    document.getElementById('error').textContent = 'No default export or App component found.';
  }
} catch(e) {
  document.getElementById('error').textContent = 'Render error: ' + e.message;
}
</script>
</body>
</html>`;
  }

  if (l === 'typescript' || l === 'ts') {
    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/>
<style>
body { background: #08080f; color: #6b7280; font-family: 'JetBrains Mono', monospace;
  font-size: 12px; padding: 20px; margin: 0; line-height: 1.6; }
</style>
</head>
<body>
<p>⚠ TypeScript preview requires transpilation.<br/>Switch language to <strong style="color:#00ff88">javascript</strong> to run code here, or export a React component with language set to <strong style="color:#00ff88">tsx</strong>.</p>
</body>
</html>`;
  }

  return '';
}

export default function SandpackPreview({ code, language }: Props) {
  const lang = language.toLowerCase();
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
