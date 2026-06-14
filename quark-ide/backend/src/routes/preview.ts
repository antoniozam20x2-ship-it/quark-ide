import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';

const router = Router();

const TTL_MS = 10 * 60 * 1000; // 10 minutes

interface PreviewEntry {
  html: string;
  expiresAt: number;
}

const store = new Map<string, PreviewEntry>();

function purgeExpired() {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (entry.expiresAt < now) store.delete(id);
  }
}

// ── HTML builder (mirrors frontend buildSrcdoc) ────────────────────────────

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
  if (/export\s+default\s/m.test(code)) return code;
  const name = findFirstComponentName(code);
  if (name) return `${code}\nexport default ${name};`;
  return code;
}

function buildHtml(code: string): string {
  const processedCode = injectDefaultExport(code);
  const componentName = findFirstComponentName(code) ?? 'App';

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
      const C = typeof ${componentName} !== 'undefined' ? ${componentName} : null;
      if (C) {
        ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(C));
      } else {
        document.getElementById('error').textContent = 'Componente no encontrado: ${componentName}';
      }
    } catch(e) {
      document.getElementById('error').textContent = 'Error: ' + e.message;
    }
  </script>
</body>
</html>`;
}

// ── Routes ─────────────────────────────────────────────────────────────────

router.post('/', (req: Request, res: Response) => {
  const { code, language } = req.body as { code?: string; language?: string };

  if (!code || typeof code !== 'string') {
    res.status(400).json({ error: 'code is required' });
    return;
  }

  const html = buildHtml(code);
  const id   = randomUUID();

  store.set(id, { html, expiresAt: Date.now() + TTL_MS });

  res.json({ id, url: `/api/preview/${id}` });
});

router.get('/:id', (req: Request, res: Response) => {
  purgeExpired();

  const entry = store.get(req.params.id);
  if (!entry) {
    res.status(404).send('Preview not found or expired');
    return;
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(entry.html);
});

export default router;
