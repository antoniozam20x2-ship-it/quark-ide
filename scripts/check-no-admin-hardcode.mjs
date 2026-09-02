#!/usr/bin/env node
import { execSync } from 'node:child_process';
import fs from 'node:fs';
const patterns = ['mAhLTRZ'];
let found = false;
// check git tracked files (excluding this guard)
try {
  const out = execSync('git grep -n "mAhLTRZ" -- . 2>&1', { encoding: 'utf8' });
  const lines = out.trim().split('\n').filter(l=> l && !l.includes('check-no-admin-hardcode'));
  if (lines.length) { console.error('[GUARD] Hardcode en repo:\n' + lines.join('\n')); found = true; }
} catch (e) { if (e.status !== 1) console.error(e.message); }
for (const p of ['/tmp/opencode']) {
  if (!fs.existsSync(p)) continue;
  for (const file of fs.readdirSync(p)) {
    const full = `${p}/${file}`;
    try {
      const c = fs.readFileSync(full, 'utf8');
      if (c.includes('mAhLTRZ')) { console.error(`[GUARD] Hardcode en ${full}`); found = true; }
    } catch {}
  }
}
if (found) { console.error('[GUARD] FAIL — limpiar'); process.exit(1); }
console.log('[GUARD] OK — no hay hardcodes admin viejos');
