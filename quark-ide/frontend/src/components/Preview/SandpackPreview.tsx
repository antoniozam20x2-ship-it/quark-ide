interface Props {
  code: string;
  language: string;
  filename?: string;
}

const HTML_LANGS = new Set(['html']);

function buildHtmlDoc(code: string, language: string, filename?: string): string {
  const name = filename?.toLowerCase() ?? '';
  const isHtml = HTML_LANGS.has(language.toLowerCase()) || name.endsWith('.html');
  if (isHtml) return code;

  const isReact = name.endsWith('.tsx') || name.endsWith('.jsx') ||
    name.endsWith('.ts') || name.endsWith('.js') ||
    ['tsx', 'jsx', 'typescript', 'javascript', 'ts', 'js'].includes(language.toLowerCase());

  if (isReact) {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  body { margin: 0; background: #0a0a0a; color: #e2e8f0;
         font-family: JetBrains Mono, monospace; padding: 16px; }
  pre  { white-space: pre-wrap; word-break: break-all; font-size: 12px;
         line-height: 1.6; color: #94a3b8; }
  .hint { color: #3a3a5c; font-size: 11px; margin-bottom: 12px; }
</style>
</head>
<body>
<p class="hint">// source — usa el Agent para generar un preview visual</p>
<pre>${code.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
</body>
</html>`;
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  body { margin: 0; background: #0a0a0a; color: #94a3b8;
         font-family: JetBrains Mono, monospace; padding: 16px; }
  pre  { white-space: pre-wrap; word-break: break-all; font-size: 12px; line-height: 1.6; }
</style>
</head>
<body>
<pre>${code.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
</body>
</html>`;
}

export default function SandpackPreview({ code, language, filename }: Props) {
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

  const srcDoc = buildHtmlDoc(code, language, filename);

  return (
    <iframe
      srcDoc={srcDoc}
      style={{ width: '100%', height: '100%', border: 'none', background: '#08080f' }}
      sandbox="allow-scripts"
      title="Preview"
    />
  );
}
