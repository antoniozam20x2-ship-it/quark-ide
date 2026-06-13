import pool from './db.js';

interface MemoryEntry {
  key: string;
  content: string;
  namespace: string;
  timestamp: string;
}

export async function saveToMemory(
  key: string,
  content: string,
  namespace: string = 'quark-ide'
): Promise<void> {
  await pool.query(
    `INSERT INTO memory_entries (key, content, namespace, timestamp)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (key, namespace)
     DO UPDATE SET content = EXCLUDED.content, timestamp = NOW()`,
    [key, content, namespace]
  );
}

export async function searchMemory(
  query: string,
  namespace: string = 'quark-ide'
): Promise<string[]> {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);

  if (words.length === 0) return [];

  const { rows } = await pool.query<MemoryEntry>(
    `SELECT key, content, namespace, timestamp
     FROM memory_entries
     WHERE namespace = $1`,
    [namespace]
  );

  const scored = rows
    .map((e) => {
      const text = `${e.key} ${e.content}`.toLowerCase();
      const hits = words.filter((w) => text.includes(w)).length;
      return { e, hits };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 5);

  return scored.map((x) => `[${x.e.namespace}/${x.e.key}]\n${x.e.content}`);
}

export async function saveProject(
  projectName: string,
  files: { name: string; content: string }[]
): Promise<void> {
  for (const file of files) {
    await saveToMemory(`${projectName}/${file.name}`, file.content, projectName);
  }
}

export async function listMemory(): Promise<{ namespaces: string[]; count: number; keys: string[] }> {
  const { rows } = await pool.query<MemoryEntry>(
    `SELECT key, namespace FROM memory_entries ORDER BY namespace, key`
  );
  const namespaces = [...new Set(rows.map((e) => e.namespace))];
  const keys = rows.map((e) => `${e.namespace}/${e.key}`);
  return { namespaces, count: rows.length, keys };
}

const JEFFERSON_PROJECTS: Record<string, Record<string, unknown>> = {
  'signal-os': {
    description: 'Autonomous trading bot Bitget USDT-M Futures',
    stack: 'Node.js TypeScript Railway PostgreSQL React',
    keyFiles: ['bias-engine', 'trailing-stop', 'signal-logic', 'bitget-api', 'position-manager'],
    riskParams: '1.5% risk, 10x leverage, max 4 positions, -10% circuit breaker, 1.5% trailing callback',
    signals: 'ADX-confirmed S3, EMA 10/20/34/55, RSI 14, Supertrend, RVOL, 7-phase market system',
  },
  'snipe-os': {
    description: 'Signal intelligence PWA Railway',
    stack: 'React TypeScript Railway PWA',
  },
  'nexus-capital': {
    description: 'OKX Spot with Snipe Radar + Smart Concept (SMC/CHoCH/BOS)',
    stack: 'React TypeScript',
    indicators: 'Snipe Radar momentum/slope 0-100, Smart Concept SMC CHoCH BOS',
  },
  'core-ai': {
    description: '6-agent trading council with Oracle verdict system',
    agents: 'ATLAS, CIPHER, VEGA, Oracle + 2 more',
    feature: 'Price projection + confidence % + timeframe analysis',
  },
  'quark-ide': {
    description: 'Personal AI development superapp built with Monaco + Gemini',
    stack: 'React TypeScript Monaco Vite Express Railway',
    features: 'AI chat, War Room, Board Room, Deep Search, memory',
  },
};

export async function seedOnce(): Promise<void> {
  const { rows } = await pool.query(
    `SELECT 1 FROM memory_entries WHERE key = '__seeded__' AND namespace = 'quark-ide' LIMIT 1`
  );
  if (rows.length > 0) return;

  for (const [name, data] of Object.entries(JEFFERSON_PROJECTS)) {
    await saveToMemory(name, JSON.stringify(data, null, 2), 'jefferson-projects');
  }
  await saveToMemory('__seeded__', new Date().toISOString(), 'quark-ide');
  console.log('⚛ QUARK Memory: seeded Jefferson project context');
}
