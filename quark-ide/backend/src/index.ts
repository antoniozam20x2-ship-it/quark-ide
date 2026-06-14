import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import chatRouter from './routes/chat.js';
import warroomRouter from './routes/warroom.js';
import searchRouter from './routes/search.js';
import memoryRouter from './routes/memory.js';
import { getCosts } from './services/costTracker.js';
import { initDb } from './services/db.js';
import { seedOnce } from './services/rufloMemory.js';
import { getFileTree, getFileContent, createOrUpdateFile, deleteFile } from './services/github.js';
import { runDebugger } from './services/debugger.js';

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
app.use('/api/warroom/search', searchRouter);
app.use('/api/memory', memoryRouter);

app.get('/api/costs', (_req, res) => {
  res.json(getCosts());
});

app.get('/github/tree', async (_req, res) => {
  try {
    const tree = await getFileTree();
    res.json(tree);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

app.get('/github/file', async (req, res) => {
  const path = String(req.query.path ?? '');
  if (!path) { res.status(400).json({ error: 'path is required' }); return; }
  try {
    const content = await getFileContent(path);
    res.json({ path, content });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

app.put('/github/file', async (req, res) => {
  const { path, content, message } = req.body as { path: string; content: string; message: string };
  if (!path || content === undefined || !message) {
    res.status(400).json({ error: 'path, content, and message are required' }); return;
  }
  try {
    await createOrUpdateFile(path, content, message);
    res.json({ ok: true, path });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

app.delete('/github/file', async (req, res) => {
  const { path, message } = req.body as { path: string; message: string };
  if (!path || !message) {
    res.status(400).json({ error: 'path and message are required' }); return;
  }
  try {
    await deleteFile(path, message);
    res.json({ ok: true, path });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});


app.post('/debugger/run', async (req, res) => {
  const { projectId } = req.body as { projectId?: string };
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' }); return;
  }
  try {
    const result = await runDebugger(projectId);
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
