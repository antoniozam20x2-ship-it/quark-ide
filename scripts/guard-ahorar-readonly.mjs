#!/usr/bin/env node
let pg;
try { pg = await import('pg'); } catch {
  const pgPath = '/data/repos/Ahorar/node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/index.js';
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  pg = require(pgPath);
}
const { Pool } = pg.default || pg;
const url = process.env.AHORAR_DB_READONLY_URL;
if (!url) { console.error('[GUARD] AHORAR_DB_READONLY_URL no está seteada — abortando. No fallback a DATABASE_URL.'); process.exit(1); }
if (url.includes('mAhLTRZ') || url.includes('40586004Lin!')) {
  console.error('[GUARD] AHORAR_DB_READONLY_URL contiene contraseña vieja — sincronizá con Railway @workspace/api-server (actual 2ubW...)');
  process.exit(1);
}
if (url.includes('postgres:') && url.includes('@postgres.railway.internal') && !url.includes('ahorar_readonly')) {
  console.error('[GUARD] AHORAR_DB_READONLY_URL parece ser DATABASE_URL admin');
  process.exit(1);
}
const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 15000 });
try {
  const r = await pool.query('SELECT current_user as user');
  const user = r.rows[0]?.user;
  console.log(`[GUARD] Conectado como ${user}`);
  if (user !== 'ahorar_readonly') { console.error(`[GUARD] Usuario inesperado: ${user}`); process.exit(2); }
  try {
    await pool.query('CREATE TEMP TABLE _guard_test (id int); INSERT INTO _guard_test VALUES (1)');
    console.error('[GUARD] FAIL-OPEN: pudo INSERT — no es readonly');
    process.exit(3);
  } catch (e) {
    if (e.message.includes('permission denied') || e.code === '42501') console.log('[GUARD] OK: readonly bloquea INSERT');
    else console.log('[GUARD] escritura check:', e.message.slice(0,120));
  }
  console.log('[GUARD] PASS — sin fallback a admin');
  await pool.end(); process.exit(0);
} catch (e) {
  console.error('[GUARD] AHORAR_DB_READONLY_URL falló:', e.message, e.code||'');
  console.error('[GUARD] NO fallback a DATABASE_URL. Corregí env (probable desync Railway)');
  try { await pool.end(); } catch {}
  process.exit(2);
}
