import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const MEMORY_FILE = path.join(DATA_DIR, 'quark-memory.json');

interface MemoryEntry {
  key: string;
  content: string;
  namespace: string;
  timestamp: string;
}

interface MemoryStore {
  entries: MemoryEntry[];
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadStore(): MemoryStore {
  ensureDataDir();
  if (!existsSync(MEMORY_FILE)) return { entries: [] };
  try {
    return JSON.parse(readFileSync(MEMORY_FILE, 'utf-8')) as MemoryStore;
  } catch {
    return { entries: [] };
  }
}

function persistStore(store: MemoryStore): void {
  ensureDataDir();
  writeFileSync(MEMORY_FILE, JSON.stringify(store, null, 2), 'utf-8');
}

export async function saveToMemory(
  key: string,
  content: string,
  namespace: string = 'quark-ide'
): Promise<void> {
  const store = loadStore();
  const idx = store.entries.findIndex((e) => e.key === key && e.namespace === namespace);
  const entry: MemoryEntry = { key, content, namespace, timestamp: new Date().toISOString() };
  if (idx >= 0) store.entries[idx] = entry;
  else store.entries.push(entry);
  persistStore(store);
}

export async function searchMemory(
  query: string,
  namespace: string = 'quark-ide'
): Promise<string[]> {
  const store = loadStore();
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);

  const scored = store.entries
    .filter((e) => !namespace || e.namespace === namespace)
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
  const store = loadStore();
  const namespaces = [...new Set(store.entries.map((e) => e.namespace))];
  const keys = store.entries.map((e) => `${e.namespace}/${e.key}`);
  return { namespaces, count: store.entries.length, keys };
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

async function seedOnce(): Promise<void> {
  const store = loadStore();
  if (store.entries.some((e) => e.key === '__seeded__' && e.namespace === 'quark-ide')) return;
  for (const [name, data] of Object.entries(JEFFERSON_PROJECTS)) {
    await saveToMemory(name, JSON.stringify(data, null, 2), 'jefferson-projects');
  }
  await saveToMemory('__seeded__', new Date().toISOString(), 'quark-ide');
  console.log('⚛ QUARK Memory: seeded Jefferson project context');
}

seedOnce().catch(() => {});
