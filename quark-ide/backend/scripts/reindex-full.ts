/**
 * reindex-full.ts — one-off full re-index for a repo.
 *
 * Deletes ALL symbol_index rows for the given repo, then re-indexes
 * the local clone from scratch (respecting EXCLUDE_PATTERNS, so v3/ stays out).
 *
 * Usage (from quark-ide/backend/):
 *   npx tsx scripts/reindex-full.ts quark-ide
 *
 * Requirements:
 *   - REPOS_DIR (or /tmp/quark-repos) must have the local clone
 *   - DATABASE_URL must be set (same as the running backend)
 *   - universal-ctags must be installed
 */

import { indexSymbols } from '../src/services/localRepos.js';

const repo = process.argv[2];

if (!repo) {
  console.error('Usage: npx tsx scripts/reindex-full.ts <repo>');
  process.exit(1);
}

const ALLOWED = ['quark-ide', 'Ahorar', 'Trade-SnipeOS', 'NEXUS-OS-app', 'Code-Coretest'];
if (!ALLOWED.includes(repo)) {
  console.error(`Unknown repo: ${repo}. Allowed: ${ALLOWED.join(', ')}`);
  process.exit(1);
}

console.log(`[reindex-full] Starting full re-index for repo="${repo}" …`);
console.log(`[reindex-full] This will DELETE all current symbol_index rows for this repo, then re-index.`);

try {
  const symbolsIndexed = await indexSymbols(repo);
  console.log(`[reindex-full] Done. symbolsIndexed=${symbolsIndexed}`);
} catch (e: any) {
  console.error('[reindex-full] Failed:', e.message);
  process.exit(1);
}
