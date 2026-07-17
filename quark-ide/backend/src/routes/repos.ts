/**
 * repos.ts — API para sincronizar clones locales y consultar estado por repo.
 *
 * POST /api/repos/:repo/sync  — git pull + re-indexar sólo archivos cambiados
 * GET  /api/repos/status      — timestamps de última sync para los 5 repos
 */

import { Router } from 'express';
import { syncRepo, getRepoStatus } from '../services/localRepos.js';

const router = Router();

// POST /api/repos/:repo/sync
router.post('/:repo/sync', async (req, res) => {
  const { repo } = req.params;

  // Allowlist — solo los 5 repos conocidos
  const ALLOWED = ['quark-ide', 'Ahorar', 'Trade-SnipeOS', 'NEXUS-OS-app', 'Code-Coretest'];
  if (!ALLOWED.includes(repo)) {
    res.status(400).json({ error: `Repo desconocido: ${repo}` });
    return;
  }

  try {
    const result = await syncRepo(repo);
    res.json({
      ok: true,
      repo,
      cloned: result.cloned,
      changedFiles: result.changedFiles,
      symbolsIndexed: result.symbolsIndexed,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: msg });
  }
});

// GET /api/repos/status
router.get('/status', async (_req, res) => {
  try {
    const status = await getRepoStatus();
    res.json(status);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
