import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const COST_FILE = path.join(DATA_DIR, 'quark-costs.json');

const MODEL = 'gemini-3.1-flash-lite';
const INPUT_COST_PER_TOKEN = 0.075 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 0.30 / 1_000_000;

export interface APICall {
  timestamp: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUSD: number;
  endpoint: string;
}

interface CostStore {
  history: APICall[];
}

const sessionCalls: APICall[] = [];

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadStore(): CostStore {
  ensureDataDir();
  if (!existsSync(COST_FILE)) return { history: [] };
  try {
    return JSON.parse(readFileSync(COST_FILE, 'utf-8')) as CostStore;
  } catch {
    return { history: [] };
  }
}

function persistStore(store: CostStore): void {
  ensureDataDir();
  const trimmed = { history: store.history.slice(-500) };
  writeFileSync(COST_FILE, JSON.stringify(trimmed, null, 2), 'utf-8');
}

export function recordCall(
  endpoint: string,
  tokensIn: number,
  tokensOut: number
): void {
  const costUSD = tokensIn * INPUT_COST_PER_TOKEN + tokensOut * OUTPUT_COST_PER_TOKEN;
  const call: APICall = {
    timestamp: new Date().toISOString(),
    model: MODEL,
    tokensIn,
    tokensOut,
    costUSD,
    endpoint,
  };
  sessionCalls.push(call);

  try {
    const store = loadStore();
    store.history.push(call);
    persistStore(store);
  } catch {}
}

function estTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function recordEstimated(
  endpoint: string,
  promptText: string,
  responseText: string
): void {
  recordCall(endpoint, estTokens(promptText), estTokens(responseText));
}

interface CostSummary {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUSD: number;
}

function sumCalls(calls: APICall[]): CostSummary {
  return calls.reduce(
    (acc, c) => ({
      calls: acc.calls + 1,
      tokensIn: acc.tokensIn + c.tokensIn,
      tokensOut: acc.tokensOut + c.tokensOut,
      costUSD: acc.costUSD + c.costUSD,
    }),
    { calls: 0, tokensIn: 0, tokensOut: 0, costUSD: 0 }
  );
}

export function getCosts(): {
  today: CostSummary;
  total: CostSummary;
  session: CostSummary;
  history: APICall[];
} {
  const store = loadStore();
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayCalls = store.history.filter((c) => c.timestamp.startsWith(todayStr));

  return {
    today: sumCalls(todayCalls),
    total: sumCalls(store.history),
    session: sumCalls(sessionCalls),
    history: store.history.slice(-50).reverse(),
  };
}
