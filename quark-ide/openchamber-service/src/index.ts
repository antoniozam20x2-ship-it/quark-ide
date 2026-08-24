import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { createHmac, timingSafeEqual } from 'crypto';
import type { Socket } from 'net';
import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';

const execFileAsync = promisify(execFile);

const app = express();
const PORT = Number(process.env.PORT ?? 3000);
const OPENCHAMBER_PORT = 3200;
const OPENCHAMBER_BIN = path.join(process.cwd(), 'node_modules', '.bin', 'openchamber');
const OPENCODE_BIN = path.join(process.cwd(), 'node_modules', '.bin', 'opencode');
const REPOS_DIR = process.env.REPOS_DIR ?? '/tmp/openchamber-repos';
const GITHUB_OWNER = process.env.GITHUB_OWNER ?? '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';
const REPOSITORIES = ['quark-ide', 'Ahorar', 'Trade-SnipeOS', 'NEXUS-OS-app', 'Code-Coretest'];

const OPENCHAMBER_COOKIE = 'quark_openchamber_session';
const OPENCHAMBER_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const OPENCHAMBER_SESSION_SECRET = 'quark-openchamber-session-v1';
const authAttempts = new Map<string, { failures: number; blockedUntil: number }>();
const AUTH_WINDOW_MS = 5 * 60 * 1000;
const MAX_AUTH_FAILURES = 5;

app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(express.urlencoded({ extended: false }));

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
    .update(OPENCHAMBER_SESSION_SECRET + ':' + payload)
    .digest('hex');
  return payload + '.' + signature;
}

function validSession(cookieHeader: string | undefined) {
  const password = process.env.OPENCODE_PASSWORD;
  const prefix = OPENCHAMBER_COOKIE + '=';
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
  return String(req.headers['x-forwarded-for'] ?? req.ip ?? 'unknown')
    .split(',')[0]
    .trim();
}

function passwordForm(res: express.Response, status = 401) {
  res.status(status).type('html').send(
    '<!doctype html><html><body><h1>OpenChamber</h1>' +
    '<form method="post"><label>Password <input name="password" type="password" autofocus></label>' +
    '<button type="submit">Entrar</button></form></body></html>',
  );
}

function openchamberAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const password = process.env.OPENCODE_PASSWORD;
  if (!password) {
    res.status(503).send('OPENCODE_PASSWORD is not configured');
    return;
  }

  const key = clientKey(req);
  const attempt = authAttempts.get(key);
  if (attempt && attempt.blockedUntil > Date.now()) {
    res.setHeader('Retry-After', Math.ceil((attempt.blockedUntil - Date.now()) / 1000));
    res.status(429).send('Too many failed attempts');
    return;
  }
  if (attempt && attempt.blockedUntil <= Date.now()) authAttempts.delete(key);

  if (validSession(req.headers.cookie)) {
    next();
    return;
  }

  if (req.method === 'POST') {
    const supplied = typeof req.body?.password === 'string' ? req.body.password : '';
    if (constantTimeStringEqual(supplied, password)) {
      authAttempts.delete(key);
      const expiresAt = Date.now() + OPENCHAMBER_SESSION_TTL_MS;
      const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      res.setHeader('Set-Cookie', OPENCHAMBER_COOKIE + '=' + sessionToken(expiresAt, password) +
        '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' +
        Math.floor(OPENCHAMBER_SESSION_TTL_MS / 1000) + '; Expires=' + new Date(expiresAt).toUTCString() +
        (secure ? '; Secure' : ''));
      res.redirect('/');
      return;
    }

    const failures = (attempt?.failures ?? 0) + 1;
    authAttempts.set(key, {
      failures,
      blockedUntil: failures >= MAX_AUTH_FAILURES ? Date.now() + AUTH_WINDOW_MS : 0,
    });
  }

  passwordForm(res);
}

const openchamberProxy = createProxyMiddleware({
  target: 'http://127.0.0.1:' + OPENCHAMBER_PORT,
  changeOrigin: true,
  ws: true,
});

// OpenChamber is the only application behind this service: protect every route.
app.use(openchamberAuth, openchamberProxy);

function gitEnvironment() {
  if (!GITHUB_TOKEN) return process.env;
  return {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic ' +
      Buffer.from('x-access-token:' + GITHUB_TOKEN).toString('base64'),
  };
}

async function syncRepository(repo: string) {
  if (!GITHUB_OWNER || !GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN y GITHUB_OWNER son requeridos para clonar repos');
  }

  const repoDir = path.join(REPOS_DIR, repo);
  const env = gitEnvironment();
  if (fs.existsSync(path.join(repoDir, '.git'))) {
    await execFileAsync('git', ['-C', repoDir, 'pull', '--ff-only'], {
      env,
      timeout: 60_000,
    });
    return;
  }
  if (fs.existsSync(repoDir)) {
    throw new Error(`El directorio de ${repo} existe pero no es un clon Git`);
  }

  await execFileAsync('git', [
    'clone',
    '--depth=1',
    `https://github.com/${GITHUB_OWNER}/${repo}.git`,
    repoDir,
  ], {
    env,
    timeout: 180_000,
  });
}

async function syncRepositories() {
  fs.mkdirSync(REPOS_DIR, { recursive: true });
  for (const repo of REPOSITORIES) {
    try {
      await syncRepository(repo);
      console.log(`[startup-sync] ${repo}: listo`);
    } catch (error) {
      console.warn(
        `[startup-sync] ${repo} falló:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  console.log('[startup-sync] Sync completo.');
}

let openchamberChild: ReturnType<typeof spawn> | undefined;
let openchamberStopping = false;
let openchamberRestartDelay = 1000;
let openchamberRestartTimer: NodeJS.Timeout | undefined;

function scheduleOpenChamberRestart() {
  if (openchamberStopping || openchamberRestartTimer) return;
  const delay = openchamberRestartDelay;
  openchamberRestartDelay = Math.min(openchamberRestartDelay * 2, 30_000);
  openchamberRestartTimer = setTimeout(() => {
    openchamberRestartTimer = undefined;
    startOpenChamber();
  }, delay);
  console.warn('[openchamber] restarting in ' + delay + 'ms');
}

function startOpenChamber() {
  fs.mkdirSync(REPOS_DIR, { recursive: true });
  openchamberChild = spawn(OPENCHAMBER_BIN, [
    'serve', '--foreground', '--host', '0.0.0.0', '--port', String(OPENCHAMBER_PORT),
  ], {
    cwd: REPOS_DIR,
    env: {
      ...process.env,
      OPENCODE_BINARY: OPENCODE_BIN,
      OPENCHAMBER_UI_PASSWORD: process.env.OPENCODE_PASSWORD,
    },
    stdio: 'inherit',
  });

  openchamberChild.once('spawn', () => {
    openchamberRestartDelay = 1000;
    console.log('[openchamber] started on internal port ' + OPENCHAMBER_PORT + ', cwd=' + REPOS_DIR);
  });
  openchamberChild.once('error', (error) => {
    console.error('[openchamber] failed to start:', error.message);
    openchamberChild = undefined;
    scheduleOpenChamberRestart();
  });
  openchamberChild.once('exit', (code, signal) => {
    console.warn('[openchamber] exited code=' + (code ?? 'null') + ' signal=' + (signal ?? 'null'));
    openchamberChild = undefined;
    scheduleOpenChamberRestart();
  });
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`⚛ OpenChamber service running on port ${PORT}`);
});

server.on('upgrade', (req, socket, head) => {
  if (!validSession(req.headers.cookie)) {
    socket.destroy();
    return;
  }
  openchamberProxy.upgrade(req, socket as Socket, head);
});

void syncRepositories().finally(() => {
  startOpenChamber();
});

const stopOpenChamber = () => {
  openchamberStopping = true;
  if (openchamberRestartTimer) clearTimeout(openchamberRestartTimer);
  openchamberChild?.kill('SIGTERM');
};

process.once('SIGTERM', stopOpenChamber);
process.once('SIGINT', stopOpenChamber);