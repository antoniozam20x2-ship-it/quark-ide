import { query, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getFileContent } from './github.js';

export interface AutoRunResult {
  success: boolean;
  workDir: string;
  changedFiles: string[];
  summary: string;
  totalCostUsd: number;
  error?: string;
}

const MAX_BUDGET_USD = 2.0; // solo informativo al final — NO es un corte en caliente (el SDK no expone cost por turno)
const MAX_TURNS = 15; // techo duro real — el SDK se detiene al llegar a este número de turnos

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

    send('action', { text: `🤖 Iniciando modo AUTO — máx ${MAX_TURNS} turnos` });

    let totalCostUsd = 0;
    let lastResult = '';

    // Prefijo estático (cacheable entre turnos) / sufijo dinámico (sesión-específico)
    const staticPrefix = `Eres QUARK Agent en modo AUTO — un agente que edita código directamente en el filesystem.

REGLAS DE TRABAJO:
- Aplica el fix MÍNIMO necesario para resolver la tarea descrita.
- Antes de modificar un archivo, léelo para entender la estructura actual.
- Si la tarea incluye un diagnóstico previo de FAST mode, úsalo como punto de partida y evita re-exploración amplia.
- Cuando hagas un cambio, verifica que sea correcto leyendo el resultado.
- Cuando termines, resume los cambios en 1-2 oraciones claras.
- No expliques más de lo necesario — el usuario quiere el fix, no un ensayo.`;

    const dynamicSuffix = `Repo activo: ${repo} (branch: ${branch})
Working directory: ${workDir}`;

    for await (const message of query({
      prompt,
      options: {
        cwd: workDir,
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
        permissionMode: 'acceptEdits',
        maxTurns: MAX_TURNS,
        model: 'sonnet',
        systemPrompt: [staticPrefix, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, dynamicSuffix],
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
        // Informativo post-hoc — el SDK ya terminó su loop cuando este mensaje llega
        send('action', { text: `💰 Costo final de la corrida: $${totalCostUsd.toFixed(4)}` });
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

export async function readChangedFileContents(
  workDir: string,
  changedFiles: string[],
  repo: string,
): Promise<{ path: string; content: string; originalContent?: string }[]> {
  return Promise.all(
    changedFiles.map(async (relPath) => {
      const content = readFileSync(path.join(workDir, relPath), 'utf-8');
      let originalContent: string | undefined;
      try {
        originalContent = await getFileContent(relPath, repo);
      } catch {
        // Archivo realmente nuevo — se omite originalContent; el diff se muestra como creación
      }
      return originalContent !== undefined
        ? { path: relPath, content, originalContent }
        : { path: relPath, content };
    }),
  );
}

export function cleanupWorkDir(workDir: string): void {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // no bloquear si falla la limpieza
  }
}
