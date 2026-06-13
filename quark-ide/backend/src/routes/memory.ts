import { Router, Request, Response } from 'express';
import {
  saveToMemory,
  searchMemory,
  saveProject,
  listMemory,
} from '../services/rufloMemory.js';

const router = Router();

router.post('/save', async (req: Request, res: Response) => {
  const { key, content, namespace } = req.body as {
    key: string;
    content: string;
    namespace?: string;
  };
  if (!key || !content) {
    res.status(400).json({ error: 'key and content are required' });
    return;
  }
  try {
    await saveToMemory(key, content, namespace ?? 'quark-ide');
    res.json({ saved: true, key });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: msg });
  }
});

router.get('/search', async (req: Request, res: Response) => {
  const query = String(req.query.q ?? '');
  const ns = String(req.query.ns ?? 'quark-ide');
  if (!query) {
    res.status(400).json({ error: 'q is required' });
    return;
  }
  try {
    const results = await searchMemory(query, ns);
    res.json({ results, count: results.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: msg });
  }
});

router.post('/project', async (req: Request, res: Response) => {
  const { projectName, files } = req.body as {
    projectName: string;
    files: { name: string; content: string }[];
  };
  if (!projectName || !Array.isArray(files)) {
    res.status(400).json({ error: 'projectName and files[] are required' });
    return;
  }
  try {
    await saveProject(projectName, files);
    res.json({ saved: true, filesCount: files.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: msg });
  }
});

router.get('/list', async (_req: Request, res: Response) => {
  try {
    const data = await listMemory();
    res.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: msg });
  }
});

export default router;
