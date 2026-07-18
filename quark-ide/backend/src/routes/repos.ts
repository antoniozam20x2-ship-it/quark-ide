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

// GET /api/repos/diagnose/:repo — diagnóstico del estado del clon local.
//
// Query params opcionales:
//   ?file=<relPath>   — agrega git log -10 y git diff HEAD~1 para ese archivo
//                       (útil para confirmar si el symbol_index está desactualizado
//                        respecto a un archivo específico sin necesidad de hacer sync)
//   ?lines=<n>        — cuántas líneas del diff mostrar (default: 80)
//
// Ejemplo: GET /api/repos/diagnose/Trade-SnipeOS?file=src/logic/tradingLogic.ts
router.get('/diagnose/:repo', (req, res) => {
  const { repo } = req.params;
  const ALLOWED = ['quark-ide', 'Ahorar', 'Trade-SnipeOS', 'NEXUS-OS-app', 'Code-Coretest'];
  if (!ALLOWED.includes(repo)) {
    res.status(400).json({ error: `Repo desconocido: ${repo}` });
    return;
  }

  const repoPath = path.join(REPOS_DIR, repo);
  const gitPath  = path.join(repoPath, '.git');
  const targetFile = typeof req.query.file === 'string' ? req.query.file : null;
  const diffLines  = Number(req.query.lines ?? 80);

  const run = (cmd: string, cwd?: string): string => {
    try { return execSync(cmd, { cwd, encoding: 'utf8', timeout: 15000 }).trim(); }
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

  // 4. git log -1 (último commit del clon)
  result.gitLog1 = run('git log -1 --format="%H %ai %s"', repoPath);

  // 5. Espacio en /data
  result.dfData = run('df -h /data');

  // 6. [Opción A] Auditoría por archivo: git log + git diff — solo si ?file= está presente.
  //    Permite confirmar sin adivinar si un archivo tiene commits no sincronizados en el índice.
  if (targetFile) {
    // Sanitize: solo rutas relativas, sin .. ni caracteres peligrosos
    const safePath = targetFile.replace(/\.\./g, '').replace(/[`$;|&]/g, '');
    const absFile  = path.join(repoPath, safePath);

    result.fileAudit = {
      file: safePath,
      // Últimos 10 commits que tocaron este archivo
      gitLog10: run(`git log --oneline -10 -- "${safePath}"`, repoPath),
      // Diff del último commit que tocó este archivo vs su commit anterior
      gitDiffLastCommit: run(
        `git log --oneline -1 -- "${safePath}"`,
        repoPath
      ).startsWith('ERROR')
        ? '(sin commits para este archivo en el clon local)'
        : run(
            `git diff HEAD~1 HEAD -- "${safePath}" | head -${diffLines}`,
            repoPath
          ),
      // ¿El archivo existe en el clon actualmente?
      fileExists: fs.existsSync(absFile),
      // Cuántas líneas tiene actualmente
      lineCount: fs.existsSync(absFile)
        ? run(`wc -l < "${absFile}"`, repoPath)
        : 'N/A',
      // ¿Está en el symbol_index? (cuántos símbolos indexados para este archivo)
      symbolIndexNote: `Consultá SELECT count(*) FROM symbol_index WHERE repo='${repo}' AND file_path LIKE '%${path.basename(safePath)}%' para ver cuántos símbolos están indexados.`,
    };
  }

  res.json(result);
});

export default router;
