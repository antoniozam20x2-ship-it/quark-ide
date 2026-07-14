import { query } from '@anthropic-ai/claude-agent-sdk';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

export interface AutoRunResult {
  success: boolean;
  workDir: string;
  changedFiles: string[];
  summary: string;
  totalCostUsd: number;
  error?: string;
}

const MAX_BUDGET_USD = 0.05; // TEMPORAL — prueba de corte por presupuesto; volver a 2.0 después
const MAX_TURNS = 40;

export async function runAutoMode(
  prompt: string,
  repo: string,
  branch: string,
  send: (event: string, data: Record<string, unknown>) => void,
): Promise<AutoRunResult> {
  const owner = process.env.GITHUB_OWNER ?? 'antoniozam20x2-ship-it';
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { success: false, workDir: '', changedFiles: [], summary: '', totalCostUsd: 0, error: 'GITHUB_TOKEN no configurado' };
  }

  const workDir = mkdtempSync(path.join(tmpdir(), 'quark-auto-'));
  const cloneUrl = `https://${token}@github.com/${owner}/${repo}.git`;

  try {
    send('action', { text: `📦 Clonando ${repo} (${branch}) en working directory aislado...` });
    execSync(`git clone --depth 1 --branch ${branch} ${cloneUrl} .`, { cwd: workDir, stdio: 'pipe' });

    execSync('git config user.email "quark-auto@nexus.local"', { cwd: workDir });
    execSync('git config user.name "Quark AUTO"', { cwd: workDir });
    execSync('git add -A && git commit --allow-empty -m "checkpoint: estado inicial antes de AUTO"', { cwd: workDir, stdio: 'pipe' });

    send('action', { text: `🤖 Iniciando modo AUTO — presupuesto máx $${MAX_BUDGET_USD}, ${MAX_TURNS} turnos` });

    let totalCostUsd = 0;
    let lastResult = '';

    for await (const message of query({
      prompt,
      options: {
        cwd: workDir,
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
        permissionMode: 'acceptEdits',
        maxTurns: MAX_TURNS,
        model: 'sonnet',
      },
    })) {
      if (message.type === 'assistant') {
        const content: any[] = (message.message?.content ?? []) as any[];
        const textBlocks = content.filter((b) => b.type === 'text');
        for (const t of textBlocks) {
          if (t.text?.trim()) send('action', { text: `💭 ${t.text.trim().slice(0, 300)}` });
        }
        const toolBlocks = content.filter((b) => b.type === 'tool_use');
        for (const tb of toolBlocks) {
          send('action', { text: `🔧 ${tb.name}: ${JSON.stringify(tb.input).slice(0, 150)}` });
        }
      }

      if (message.type === 'result') {
        totalCostUsd = (message as any).total_cost_usd ?? 0;
        lastResult = (message as any).result ?? '';
        send('action', { text: `💰 Costo de la corrida: $${totalCostUsd.toFixed(4)}` });

        if (totalCostUsd > MAX_BUDGET_USD) {
          send('action', { text: `🛑 Presupuesto excedido ($${totalCostUsd.toFixed(2)} > $${MAX_BUDGET_USD}) — deteniendo` });
          break;
        }
      }
    }

    const diffOutput = execSync('git diff --name-only HEAD', { cwd: workDir, encoding: 'utf-8' }).trim();
    const changedFiles = diffOutput ? diffOutput.split('\n') : [];

    send('action', { text: `✅ AUTO terminó — ${changedFiles.length} archivo(s) modificado(s)` });

    return { success: true, workDir, changedFiles, summary: lastResult, totalCostUsd };
  } catch (err) {
    return {
      success: false,
      workDir,
      changedFiles: [],
      summary: '',
      totalCostUsd: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function readChangedFileContents(workDir: string, changedFiles: string[]): { path: string; content: string }[] {
  return changedFiles.map((relPath) => ({
    path: relPath,
    content: readFileSync(path.join(workDir, relPath), 'utf-8'),
  }));
}

export function cleanupWorkDir(workDir: string): void {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // no bloquear si falla la limpieza
  }
}
