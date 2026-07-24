/**
 * admin.ts — endpoints de operación puntual, protegidos con x-admin-key.
 *
 * POST /api/admin/reindex/:repo
 *   Fuerza un re-index COMPLETO de symbol_index para el repo indicado
 *   (equivale a indexSymbols(repo) sin changedFiles — borra todo y re-indexa).
 *   Requiere header: x-admin-key: <ADMIN_KEY>
 */

import { Router, Request, Response } from 'express';
import { indexSymbols } from '../services/localRepos.js';

const router = Router();

const ALLOWED_REPOS = ['quark-ide', 'Ahorar', 'Trade-SnipeOS', 'NEXUS-OS-app', 'Code-Coretest'];

function checkAdminKey(req: Request, res: Response): boolean {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    res.status(500).json({ error: 'ADMIN_KEY not configured on server' });
    return false;
  }
  if (req.headers['x-admin-key'] !== adminKey) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// POST /api/admin/reindex/:repo
router.post('/reindex/:repo', async (req: Request, res: Response) => {
  if (!checkAdminKey(req, res)) return;

  const { repo } = req.params;
  if (!ALLOWED_REPOS.includes(repo)) {
    res.status(400).json({ error: `Unknown repo: ${repo}. Allowed: ${ALLOWED_REPOS.join(', ')}` });
    return;
  }

  console.log(`[admin] Full re-index requested for repo="${repo}"`);
  try {
    const symbolsIndexed = await indexSymbols(repo);
    console.log(`[admin] Re-index complete for repo="${repo}": symbolsIndexed=${symbolsIndexed}`);
    res.json({ ok: true, repo, symbolsIndexed });
  } catch (e: any) {
    console.error(`[admin] Re-index failed for repo="${repo}":`, e.message);
    res.status(500).json({ ok: false, repo, error: e.message });
  }
});

export default router;
