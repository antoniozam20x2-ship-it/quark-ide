/**
 * localRepos.ts — gestión de clones locales de repos para búsqueda con ripgrep + ctags.
 * Reemplaza la GitHub Code Search API como fuente primaria de grep_code.
 *
 * Rutas:
 *   REPOS_DIR (env) → /data/repos en Railway con Volume montado, /tmp/quark-repos en dev.
 *
 * Pipeline de búsqueda por grep_code:
 *   1. Exact lookup en symbol_index (BD)  → si hay match exacto, retorna directo con línea
 *   2. rg search en clon local            → si el repo está clonado
 *   3. Fallback a GitHub Code Search API  → si el repo no está clonado todavía
 */

import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import pool from './db.js';

const execAsync  = promisify(exec);
const execFileAsync = promisify(execFile);

export const REPOS_DIR = process.env.REPOS_DIR ?? '/tmp/quark-repos';
const GITHUB_OWNER = process.env.GITHUB_OWNER ?? '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';

// ── Security exclusions (mismo criterio que NO_CACHE_PATTERNS en agent.ts) ────
const EXCLUDE_PATTERNS = [
  /\.env/i,
  /SECRET/i,
  /API_KEY/i,
  /[/\\]dist[/\\]/,
  /node_modules[/\\]/,
  /\.min\.js$/,
  /[/\\]\.git[/\\]/,
  /[/\\]\.git$/,
];

const SENSITIVE_REPO_EXCLUDES: Record<string, RegExp[]> = {
  'Ahorar':        [/[/\\]config[/\\]/i, /[/\\]secrets?[/\\]/i, /[/\\]keys?[/\\]/i, /[/\\]credentials?[/\\]/i],
  'Trade-SnipeOS': [/[/\\]config[/\\]/i, /[/\\]secrets?[/\\]/i, /[/\\]keys?[/\\]/i, /[/\\]credentials?[/\\]/i],
};

export function isExcludedPath(filePath: string, repo: string): boolean {
  if (EXCLUDE_PATTERNS.some(p => p.test(filePath))) return true;
  return (SENSITIVE_REPO_EXCLUDES[repo] ?? []).some(p => p.test(filePath));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function repoDir(repo: string): string {
  return path.join(REPOS_DIR, repo);
}

export function isCloned(repo: string): boolean {
  try { return fs.existsSync(path.join(repoDir(repo), '.git')); }
  catch { return false; }
}

// Ensure base directory exists
function ensureBaseDir(): void {
  fs.mkdirSync(REPOS_DIR, { recursive: true });
}

// ── Clone / pull ──────────────────────────────────────────────────────────────

export async function ensureCloned(repo: string): Promise<void> {
  ensureBaseDir();
  const dir = repoDir(repo);
  if (fs.existsSync(path.join(dir, '.git'))) return;

  if (!GITHUB_TOKEN || !GITHUB_OWNER) {
    throw new Error('GITHUB_TOKEN y GITHUB_OWNER son requeridos para clonar repos');
  }

  // Use token in URL — no password exposure in logs since we don't log the URL
  const cloneUrl = `https://${GITHUB_TOKEN}@github.com/${GITHUB_OWNER}/${repo}.git`;
  await execAsync(`git clone --depth=1 "${cloneUrl}" "${dir}"`, { timeout: 180_000 });
}

/**
 * Pull the latest changes. Returns list of files that changed (empty if up-to-date).
 */
export async function pullRepo(repo: string): Promise<string[]> {
  const dir = repoDir(repo);

  let headBefore = '';
  try {
    headBefore = (await execAsync(`git -C "${dir}" rev-parse HEAD`, { timeout: 10_000 })).stdout.trim();
  } catch {}

  try {
    await execAsync(`git -C "${dir}" pull --ff-only`, { timeout: 60_000 });
  } catch (e: any) {
    // If nothing to pull (already up to date), git exits 0 — any real error is thrown
    throw new Error(`git pull falló para ${repo}: ${e.message}`);
  }

  let headAfter = '';
  try {
    headAfter = (await execAsync(`git -C "${dir}" rev-parse HEAD`, { timeout: 10_000 })).stdout.trim();
  } catch {}

  if (headBefore && headAfter && headBefore !== headAfter) {
    try {
      const { stdout } = await execAsync(
        `git -C "${dir}" diff --name-only "${headBefore}" "${headAfter}"`,
        { timeout: 10_000 }
      );
      return stdout.trim().split('\n').filter(Boolean);
    } catch {}
  }
  return [];
}

// ── Symbol indexing via ctags ─────────────────────────────────────────────────

/**
 * Index symbols for an entire repo (or specific files after a pull).
 * Uses universal-ctags --output-format=json.
 * Returns number of symbols indexed.
 */
export async function indexSymbols(repo: string, changedFiles?: string[]): Promise<number> {
  const dir = repoDir(repo);
  if (!fs.existsSync(dir)) return 0;

  // Filter out excluded files
  const filesToIndex = changedFiles
    ? changedFiles.filter(f => !isExcludedPath(f, repo))
    : null;

  if (filesToIndex !== null && filesToIndex.length === 0) return 0;

  // Clear existing entries for the affected scope
  try {
    if (filesToIndex) {
      await pool.query(
        'DELETE FROM symbol_index WHERE repo = $1 AND file_path = ANY($2::text[])',
        [repo, filesToIndex]
      );
    } else {
      await pool.query('DELETE FROM symbol_index WHERE repo = $1', [repo]);
    }
  } catch (e: any) {
    console.warn(`[localRepos] No se pudo limpiar symbol_index para ${repo}:`, e.message);
  }

  // Build ctags target paths
  const targets = filesToIndex
    ? filesToIndex.map(f => path.join(dir, f))
    : [dir];

  let stdout = '';
  try {
    const args = [
      '--output-format=json',
      '--fields=+n',
      '--extras=-F',
      ...(filesToIndex ? [] : ['-R']),
      ...targets,
    ];
    const result = await execFileAsync('ctags', args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 120_000,
    });
    stdout = result.stdout;
  } catch (e: any) {
    // ctags not installed or failed
    console.warn(`[localRepos] ctags no disponible para ${repo}:`, e.message);
    return 0;
  }

  const rows: [string, string, string, number, string][] = [];

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const tag = JSON.parse(line) as {
        _type?: string;
        name?: string;
        path?: string;
        line?: number;
        kind?: string;
      };
      if (tag._type !== 'tag' || !tag.name || !tag.path || !tag.line) continue;

      // Make path relative to repo dir
      const relPath = path.isAbsolute(tag.path)
        ? path.relative(dir, tag.path)
        : tag.path;

      if (isExcludedPath(relPath, repo)) continue;

      rows.push([repo, tag.name, relPath, tag.line, tag.kind ?? 'unknown']);
    } catch {}
  }

  if (rows.length === 0) return 0;

  // Batch insert in chunks of 500
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const placeholders = chunk
      .map((_, j) => `($${j * 5 + 1}, $${j * 5 + 2}, $${j * 5 + 3}, $${j * 5 + 4}, $${j * 5 + 5})`)
      .join(', ');
    const flat = chunk.flat();
    try {
      await pool.query(
        `INSERT INTO symbol_index (repo, symbol_name, file_path, line_number, symbol_type)
         VALUES ${placeholders}`,
        flat
      );
    } catch (e: any) {
      console.warn(`[localRepos] Error insertando símbolos (chunk ${i}):`, e.message);
    }
  }

  return rows.length;
}

// ── Sync (clone/pull + index) ─────────────────────────────────────────────────

const syncLocks = new Set<string>();

export async function syncRepo(repo: string): Promise<{
  cloned: boolean;
  changedFiles: number;
  symbolsIndexed: number;
}> {
  if (syncLocks.has(repo)) {
    throw new Error(`Sync de ${repo} ya está en progreso — intentá en unos segundos`);
  }
  syncLocks.add(repo);

  try {
    const wasCloned = isCloned(repo);
    await ensureCloned(repo);
    const cloned = !wasCloned;

    let changedFiles: string[] = [];
    if (!cloned) {
      changedFiles = await pullRepo(repo);
    }

    // Index: if freshly cloned, index everything; if pulled, index only changed files
    const symbolsIndexed = await indexSymbols(
      repo,
      cloned ? undefined : (changedFiles.length > 0 ? changedFiles : undefined)
    );

    // Update sync log
    try {
      await pool.query(
        `INSERT INTO repo_sync_log (repo, synced_at, files_changed)
         VALUES ($1, NOW(), $2)
         ON CONFLICT (repo) DO UPDATE SET synced_at = NOW(), files_changed = $2`,
        [repo, changedFiles.length]
      );
    } catch (e: any) {
      console.warn(`[localRepos] No se pudo guardar sync_log para ${repo}:`, e.message);
    }

    return { cloned, changedFiles: changedFiles.length, symbolsIndexed };
  } finally {
    syncLocks.delete(repo);
  }
}

// ── Symbol lookup ─────────────────────────────────────────────────────────────

export interface SymbolMatch {
  filePath: string;
  lineNumber: number;
  symbolType: string;
}

/**
 * Exact symbol name lookup in the indexed DB.
 * Returns the first match or null.
 */
export async function lookupSymbol(symbolName: string, repo: string): Promise<SymbolMatch | null> {
  try {
    const r = await pool.query<{ file_path: string; line_number: number; symbol_type: string }>(
      'SELECT file_path, line_number, symbol_type FROM symbol_index WHERE repo = $1 AND symbol_name = $2 LIMIT 1',
      [repo, symbolName]
    );
    if (!r.rows[0]) return null;
    return {
      filePath: r.rows[0].file_path,
      lineNumber: r.rows[0].line_number,
      symbolType: r.rows[0].symbol_type,
    };
  } catch {
    return null;
  }
}

// ── ripgrep search ────────────────────────────────────────────────────────────

export interface RgMatch {
  path: string;
  line: number;
  text: string;
}

/**
 * Search the local clone using ripgrep.
 * Returns empty array if repo not cloned or rg not available.
 */
export async function rgSearch(pattern: string, repo: string): Promise<RgMatch[]> {
  if (!isCloned(repo)) return [];
  const dir = repoDir(repo);

  try {
    const { stdout } = await execFileAsync(
      'rg',
      [
        '--json',
        '--max-count=5',          // max 5 matches per file
        '--max-filesize=2M',
        '--no-heading',
        pattern,
        dir,
      ],
      { maxBuffer: 10 * 1024 * 1024, timeout: 15_000 }
    );

    const results: RgMatch[] = [];

    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as {
          type: string;
          data: {
            path: { text: string };
            line_number: number;
            lines: { text: string };
          };
        };
        if (obj.type !== 'match') continue;

        const absPath = obj.data.path.text;
        const relPath = path.relative(dir, absPath);
        if (isExcludedPath(relPath, repo)) continue;

        results.push({
          path: relPath,
          line: obj.data.line_number,
          text: obj.data.lines.text.trim().slice(0, 120),
        });

        if (results.length >= 20) break;
      } catch {}
    }

    return results;
  } catch (e: any) {
    if (e.code === 1) return []; // exit 1 = no matches (not an error)
    console.warn(`[localRepos] rg falló para ${repo}:`, e.message?.slice(0, 200));
    return [];
  }
}

// ── Status ────────────────────────────────────────────────────────────────────

const ALL_REPOS = ['quark-ide', 'Ahorar', 'Trade-SnipeOS', 'NEXUS-OS-app', 'Code-Coretest'];

export async function getRepoStatus(): Promise<{
  repo: string;
  cloned: boolean;
  syncedAt: string | null;
  filesChanged: number;
}[]> {
  let rows: { repo: string; synced_at: Date; files_changed: number }[] = [];
  try {
    const r = await pool.query<{ repo: string; synced_at: Date; files_changed: number }>(
      'SELECT repo, synced_at, files_changed FROM repo_sync_log WHERE repo = ANY($1)',
      [ALL_REPOS]
    );
    rows = r.rows;
  } catch {}

  return ALL_REPOS.map(repo => {
    const row = rows.find(x => x.repo === repo);
    return {
      repo,
      cloned: isCloned(repo),
      syncedAt: row?.synced_at?.toISOString() ?? null,
      filesChanged: row?.files_changed ?? 0,
    };
  });
}
