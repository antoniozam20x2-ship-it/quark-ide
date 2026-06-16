import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import chatRouter from './routes/chat.js';
import warroomRouter from './routes/warroom.js';
import searchRouter from './routes/search.js';
import memoryRouter from './routes/memory.js';
import agentRouter from './routes/agent.js';
import { getCosts } from './services/costTracker.js';
import { initDb } from './services/db.js';
import { seedOnce } from './services/rufloMemory.js';
import { getFileTree, getFileContent, createOrUpdateFile, deleteFile, commitMultipleFiles } from './services/github.js';
import { runDebugger } from './services/debugger.js';
import previewRouter from './routes/preview.js';
import editorRouter from './routes/editor.js';
import studioRouter from './routes/studio.js';

const app = express();
const PORT = Number(process.env.PORT ?? 3001);

app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));

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
app.use('/api/editor', editorRouter);
app.use('/api/studio', studioRouter);

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
    files?: { path: string; content: string }[];
    message?: string;
    repo?: string;
    branch?: string;
  };
  if (!files?.length || !message) {
    res.status(400).json({ error: 'files and message are required' }); return;
  }
  try {
    const sha = await commitMultipleFiles(files, message, repo, branch);
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
    .catch((err) => console.error('⚠ DB init failed:', err));
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`⚛ QUARK backend running on port ${PORT}`);
});
