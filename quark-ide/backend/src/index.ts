import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { createHmac, timingSafeEqual } from 'crypto';
import type { Socket } from 'net';
import express from 'express';
import cors from 'cors';
import chatRouter from './routes/chat.js';
import warroomRouter from './routes/warroom.js';
import searchRouter from './routes/search.js';
import memoryRouter from './routes/memory.js';
import agentRouter, { invalidateRepoKnowledge, generateChangelogSummary } from './routes/agent.js';
import { getCosts } from './services/costTracker.js';
import { initDb } from './services/db.js';
import { seedOnce } from './services/rufloMemory.js';
import { REPOS_DIR, syncRepo } from './services/localRepos.js';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { getFileTree, getFileContent, createOrUpdateFile, deleteFile, commitMultipleFiles } from './services/github.js';
import { runDebugger } from './services/debugger.js';
import previewRouter from './routes/preview.js';
import editorRouter from './routes/editor.js';
import studioRouter from './routes/studio.js';
import healthRouter from './routes/health.js';
import auditRouter from './routes/audit.js';
import reposRouter from './routes/repos.js';
import webhooksRouter from './routes/webhooks.js';

const app = express();
const PORT = Number(process.env.PORT ?? 3001);

app.use(cors({
  origin: true,
  credentials: true,
}));

// IMPORTANTE: el webhook router se monta ANTES de express.json() porque necesita
// el raw body para validar X-Hub-Signature-256 con HMAC-SHA256.
// El router aplica express.raw() internamente solo sobre su ruta.
app.use('/api/webhooks/github', webhooksRouter);

app.use(express.json({ limit: '2mb' }));

const OPENCODE_PORT = 3000;

const OPENCODE_COOKIE = 'quark_opencode_session';
const OPENCODE_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const OPENCODE_SESSION_SECRET = 'quark-opencode-session-v1';
const authAttempts = new Map<string, { failures: number; blockedUntil: number }>();
const AUTH_WINDOW_MS = 5 * 60 * 1000;
const MAX_AUTH_FAILURES = 5;

function constantTimeStringEqual(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  const length = Math.max(actualBuffer.length, expectedBuffer.length);
  const paddedActual = Buffer.alloc(length);
  const paddedExpected = Buffer.alloc(length);
  actualBuffer.copy(paddedActual);
  expectedBuffer.copy(paddedExpected);
  const contentsMatch = timingSafeEqual(paddedActual, paddedExpected);
  return actualBuffer.length === expectedBuffer.length && contentsMatch;
}

function sessionToken(expiresAt: number, password: string) {
  const payload = String(expiresAt);
  const signature = createHmac('sha256', password)
    .update(OPENCODE_SESSION_SECRET + ':' + payload)
    .digest('hex');
  return payload + '.' + signature;
}

function validSession(cookieHeader: string | undefined) {
  const password = process.env.OPENCODE_PASSWORD;
  const prefix = OPENCODE_COOKIE + '=';
  const raw = cookieHeader?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(prefix))?.slice(prefix.length);
  if (!password || !raw) return false;
  const [expiresText, signature] = raw.split('.');
  const expiresAt = Number(expiresText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || !signature) return false;
  const expected = Buffer.from(sessionToken(expiresAt, password).split('.')[1]);
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function clientKey(req: express.Request) {
  return String(req.headers['x-forwarded-for'] ?? req.ip ?? 'unknown').split(',')[0].trim();
}

function passwordForm(res: express.Response, status = 401) {
  res.status(status).type('html').send(
    '<!doctype html><html><body><h1>Quark IDE — OpenCode</h1>' +
    '<form method="post"><label>Password <input name="password" type="password" autofocus></label>' +
    '<button type="submit">Entrar</button></form></body></html>',
  );
}

function opencodeAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const password = process.env.OPENCODE_PASSWORD;
  if (!password) { res.status(503).send('OPENCODE_PASSWORD is not configured'); return; }
  const key = clientKey(req);
  const attempt = authAttempts.get(key);
  if (attempt && attempt.blockedUntil > Date.now()) {
    res.setHeader('Retry-After', Math.ceil((attempt.blockedUntil - Date.now()) / 1000));
    res.status(429).send('Too many failed attempts');
    return;
  }
  if (attempt && attempt.blockedUntil <= Date.now()) authAttempts.delete(key);
  if (validSession(req.headers.cookie)) { next(); return; }
  if (req.method === 'POST') {
    const supplied = typeof req.body?.password === 'string' ? req.body.password : '';
    if (constantTimeStringEqual(supplied, password)) {
      authAttempts.delete(key);
      const expiresAt = Date.now() + OPENCODE_SESSION_TTL_MS;
      const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      res.setHeader('Set-Cookie', OPENCODE_COOKIE + '=' + sessionToken(expiresAt, password) +
        '; Path=/opencode; HttpOnly; SameSite=Lax; Max-Age=' +
        Math.floor(OPENCODE_SESSION_TTL_MS / 1000) + '; Expires=' + new Date(expiresAt).toUTCString() +
        (secure ? '; Secure' : ''));
      res.redirect('/opencode/'); return;
    }
    const failures = (attempt?.failures ?? 0) + 1;
    authAttempts.set(key, { failures, blockedUntil: failures >= MAX_AUTH_FAILURES ? Date.now() + AUTH_WINDOW_MS : 0 });
  }
  passwordForm(res);
}


const opencodePath = (url: string | undefined) => {
  const pathname = (url ?? '').split('?')[0];
  return pathname === '/opencode' || pathname.startsWith('/opencode/');
};

const opencodeProxy = createProxyMiddleware({
  target: 'http://127.0.0.1:' + OPENCODE_PORT,
  changeOrigin: true,
  ws: true,
  pathRewrite: (requestPath) => {
    const pathname = requestPath.split('?')[0];
    const query = requestPath.slice(pathname.length);
    if (pathname === '/opencode') return '/' + query;
    if (pathname.startsWith('/opencode/')) return pathname.slice('/opencode'.length) + query;
    return requestPath;
  },
});

// Auth is applied only to /opencode; existing routes remain unchanged.
app.use('/opencode', express.urlencoded({ extended: false }), opencodeAuth, opencodeProxy);

let opencodeChild: ReturnType<typeof spawn> | undefined;
let opencodeStopping = false;
let opencodeRestartDelay = 1000;
let opencodeRestartTimer: NodeJS.Timeout | undefined;

function scheduleOpenCodeRestart() {
  if (opencodeStopping || opencodeRestartTimer) return;
  const delay = opencodeRestartDelay;
  opencodeRestartDelay = Math.min(opencodeRestartDelay * 2, 30_000);
  opencodeRestartTimer = setTimeout(() => {
    opencodeRestartTimer = undefined;
    startOpenCode();
  }, delay);
  console.warn('[opencode] restarting in ' + delay + 'ms');
}

function startOpenCode() {
  fs.mkdirSync(REPOS_DIR, { recursive: true });
  opencodeChild = spawn('opencode', [
    'serve', '--hostname', '0.0.0.0', '--port', String(OPENCODE_PORT),
  ], { cwd: REPOS_DIR, env: { ...process.env }, stdio: 'inherit' });

  opencodeChild.once('spawn', () => {
    opencodeRestartDelay = 1000;
    console.log('[opencode] started on internal port ' + OPENCODE_PORT + ', cwd=' + REPOS_DIR);
  });
  opencodeChild.once('error', (err) => {
    console.error('[opencode] failed to start:', err.message);
    opencodeChild = undefined;
    scheduleOpenCodeRestart();
  });
  opencodeChild.once('exit', (code, signal) => {
    console.warn('[opencode] exited code=' + (code ?? 'null') + ' signal=' + (signal ?? 'null'));
    opencodeChild = undefined;
    scheduleOpenCodeRestart();
  });
}

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'quark-ide-backend',
  });
});

app.use('/api/chat', chatRouter);
app.use('/api/warroom', warroomRouter);
app.use('/api/preview', previewRouter);
app.use('/api/warroom/search', searchRouter);
app.use('/api/memory', memoryRouter);
app.use('/agent', agentRouter);
app.use('/api/agent', agentRouter);
app.use('/api/editor', editorRouter);
app.use('/api/studio', studioRouter);
app.use('/api/health', healthRouter);
app.use('/api/audit', auditRouter);
app.use('/api/repos', reposRouter);

app.get('/api/costs', (_req, res) => {
  res.json(getCosts());
});

app.get('/github/tree', async (req, res) => {
  const repo   = req.query.repo   as string || undefined;
  const branch = req.query.branch as string || undefined;
  try {
    const tree = await getFileTree(repo, branch);
    res.json(tree);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

app.get('/github/file', async (req, res) => {
  const path = String(req.query.path ?? '');
  const repo  = req.query.repo as string || undefined;
  if (!path) { res.status(400).json({ error: 'path is required' }); return; }
  try {
    const content = await getFileContent(path, repo);
    res.json({ path, content });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

app.put('/github/file', async (req, res) => {
  const { path, content, message, repo, branch } = req.body as { path: string; content: string; message: string; repo?: string; branch?: string };
  if (!path || content === undefined || !message || !repo) {
    res.status(400).json({ error: 'path, content, message, and repo are required' }); return;
  }
  try {
    await createOrUpdateFile(path, content, message, repo, branch);
    res.json({ ok: true, path });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

app.delete('/github/file', async (req, res) => {
  const { path, message, repo, branch } = req.body as { path: string; message: string; repo?: string; branch?: string };
  if (!path || !message || !repo) {
    res.status(400).json({ error: 'path, message, and repo are required' }); return;
  }
  try {
    await deleteFile(path, message, repo, branch);
    res.json({ ok: true, path });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});


app.post('/github/switch-project', (req, res) => {
  const { repo, branch } = req.body as { repo?: string; branch?: string };
  if (!repo || !branch) {
    res.status(400).json({ error: 'repo and branch are required' }); return;
  }
  process.env.GITHUB_REPO   = repo;
  process.env.GITHUB_BRANCH = branch;
  res.json({ success: true, repo, branch });
});

app.post('/github/commit-multiple', async (req, res) => {
  const { files, message, repo, branch } = req.body as {
    files: { path: string; content: string }[];
    message: string;
    repo?: string;
    branch?: string;
  };
  if (!files?.length || !message) {
    res.status(400).json({ error: 'files and message are required' }); return;
  }

  // Validar compilación TypeScript antes de hacer commit
  const tsFiles = files.filter(f => f.path.endsWith('.ts') || f.path.endsWith('.tsx'));
  if (tsFiles.length > 0) {
    const tmpDir = path.join('/tmp', `quark-validate-${Date.now()}`);
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      for (const f of tsFiles) {
        const filePath = path.join(tmpDir, path.basename(f.path));
        fs.writeFileSync(filePath, f.content);
      }
      execSync(`npx tsc --noEmit --skipLibCheck --jsx react ${tsFiles.map(f => path.join(tmpDir, path.basename(f.path))).join(' ')}`, {
        timeout: 15000,
        stdio: 'pipe',
      });
    } catch (err: any) {
      const errorOutput = err.stdout?.toString() || err.message || 'Error de compilación desconocido';
      res.status(400).json({
        error: 'Validación de TypeScript falló — commit bloqueado',
        details: errorOutput.slice(0, 2000),
      });
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      return;
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  try {
    const sha = await commitMultipleFiles(files, message, repo, branch);
    // Use the effective repo (explicit or env fallback) so invalidation runs even
    // when the caller omits repo and commitMultipleFiles resolves it from env.
    const effectiveRepo = repo ?? process.env.GITHUB_REPO ?? '';
    if (effectiveRepo) {
      const changedPaths = files.map(f => f.path);
      invalidateRepoKnowledge(effectiveRepo, changedPaths).catch((err) => {
        console.warn(`[repo_knowledge] invalidation failed after commit (repo=${effectiveRepo}, files=${changedPaths.length}):`, err instanceof Error ? err.message : err);
      });
    }
    res.json({ sha, owner: process.env.GITHUB_OWNER ?? '' });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

app.post('/debugger/run', async (req, res) => {
  const { projectId, projectName, repo } = req.body as { projectId?: string; projectName?: string; repo?: string };
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' }); return;
  }
  try {
    const result = await runDebugger(projectId, projectName ?? 'Unknown', repo);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

if (process.env.DATABASE_URL) {
  initDb()
    .then(() => seedOnce())
    .then(() => {
      // Generar resumen de changelog para repos configurados, en paralelo y sin bloquear el arranque
      ['Ahorar'].forEach((repo) => {
        generateChangelogSummary(repo).catch((err) =>
          console.warn(`[changelog] init falló para ${repo}:`, err instanceof Error ? err.message : err),
        );
      });
    })
    .catch((err) => console.error('⚠ DB init failed:', err));
}

// ── Sync automático al arrancar en Railway ────────────────────────────────────
// Solo se ejecuta cuando RAILWAY_ENVIRONMENT está presente. No bloquea el arranque:
// si un repo falla, el proceso continúa y el fallback a GitHub API sigue activo.
if (process.env.RAILWAY_ENVIRONMENT) {
  const STARTUP_REPOS = ['quark-ide', 'Ahorar', 'Trade-SnipeOS', 'NEXUS-OS-app', 'Code-Coretest'];
  (async () => {
    console.log('[startup-sync] Iniciando sync de repos en Railway…');
    for (const repo of STARTUP_REPOS) {
      try {
        const r = await syncRepo(repo);
        console.log(`[startup-sync] ${repo}:`, JSON.stringify(r));
      } catch (e: any) {
        console.warn(`[startup-sync] ${repo} falló:`, e.message);
      }
    }
    console.log('[startup-sync] Sync completo.');
  })();
}

process.on('uncaughtException', (err) => {
  console.error('[QUARK] uncaughtException — proceso continuando:', err.stack ?? err.message);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  console.error('[QUARK] unhandledRejection — proceso continuando:', msg);
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`⚛ QUARK backend running on port ${PORT}`);
  startOpenCode();
});

server.on('upgrade', (req, socket, head) => {
  if (!opencodePath(req.url)) return;
  if (!validSession(req.headers.cookie)) { socket.destroy(); return; }
  opencodeProxy.upgrade(req, socket as Socket, head);
});

const stopOpenCode = () => {
  opencodeStopping = true;
  if (opencodeRestartTimer) clearTimeout(opencodeRestartTimer);
  opencodeChild?.kill('SIGTERM');
};
process.once('SIGTERM', stopOpenCode);
process.once('SIGINT', stopOpenCode);
