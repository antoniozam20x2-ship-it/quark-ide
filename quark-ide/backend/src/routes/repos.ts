/**
 * repos.ts — API para sincronizar clones locales y consultar estado por repo.
 *
 * POST /api/repos/:repo/sync  — git pull + re-indexar sólo archivos cambiados
 * GET  /api/repos/status      — timestamps de última sync para los 5 repos
 */

import { Router } from 'express';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { syncRepo, getRepoStatus, REPOS_DIR } from '../services/localRepos.js';

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

// POST /api/repos/sync-all — sincroniza los 5 repos en secuencia (Railway manual trigger)
router.post('/sync-all', async (_req, res) => {
  const REPOS = ['quark-ide', 'Ahorar', 'Trade-SnipeOS', 'NEXUS-OS-app', 'Code-Coretest'];
  const results: Record<string, unknown> = {};
  for (const repo of REPOS) {
    try {
      results[repo] = await syncRepo(repo);
    } catch (e: any) {
      results[repo] = { error: e.message };
    }
  }
  res.json(results);
});

// GET /api/repos/diagnose/:repo — diagnóstico temporal del estado del clon local
router.get('/diagnose/:repo', (req, res) => {
  const { repo } = req.params;
  const ALLOWED = ['quark-ide', 'Ahorar', 'Trade-SnipeOS', 'NEXUS-OS-app', 'Code-Coretest'];
  if (!ALLOWED.includes(repo)) {
    res.status(400).json({ error: `Repo desconocido: ${repo}` });
    return;
  }

  const repoPath = path.join(REPOS_DIR, repo);
  const gitPath  = path.join(repoPath, '.git');

  const run = (cmd: string, cwd?: string): string => {
    try { return execSync(cmd, { cwd, encoding: 'utf8', timeout: 10000 }).trim(); }
    catch (e: any) { return `ERROR: ${e.message?.split('\n')[0] ?? String(e)}`; }
  };

  const result: Record<string, unknown> = {
    REPOS_DIR,
    repoPath,
  };

  // 1. ¿Existe .git?
  result.gitExists = fs.existsSync(gitPath);

  // 2. Listado del directorio raíz del clon
  try {
    const entries = fs.readdirSync(repoPath);
    result.rootEntries = entries;
    result.rootEntryCount = entries.length;
  } catch (e: any) {
    result.rootEntries = `ERROR: ${e.message}`;
    result.rootEntryCount = 0;
  }

  // 3. Buscar autonomousAgent.ts y grep trailingStop sobre él
  const agentGlob = run(`find ${repoPath} -name "autonomousAgent.ts" 2>/dev/null`);
  result.autonomousAgentPaths = agentGlob || '(no encontrado)';
  if (agentGlob && !agentGlob.startsWith('ERROR')) {
    const firstPath = agentGlob.split('\n')[0];
    result.trailingStopGrep = run(`grep -n "trailingStop\\|placeTrailingStop" "${firstPath}"`);
  }

  // 4. git log -1 (último commit)
  result.gitLog1 = run('git log -1 --format="%H %ai %s"', repoPath);

  // 5. Espacio en /data
  result.dfData = run('df -h /data');

  res.json(result);
});

export default router;
