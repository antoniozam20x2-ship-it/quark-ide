import { getFileContent, createOrUpdateFile } from './github.js';

const RAILWAY_GQL = 'https://backboard.railway.app/graphql/v2';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'anthropic/claude-opus-4-5';

export interface DebugResult {
  hasError: boolean;
  errorMessage?: string;
  affectedFile?: string;
  fixed?: boolean;
  commitMessage?: string;
  fix?: string;
  rawAnalysis?: string;
}

export interface DebugLoop {
  fixed: boolean;
  attempts: number;
  lastError?: string;
  commits?: string[];
}

const MAX_RETRIES = 3;

interface LogAnalysis {
  hasError: boolean;
  errorMessage: string;
  affectedFile: string;
  fix: string;
}

async function gqlRequest<T>(query: string): Promise<T> {
  const token = process.env.RAILWAY_API_TOKEN;
  if (!token) throw new Error('RAILWAY_API_TOKEN is not set');

  const res = await fetch(RAILWAY_GQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) {
    throw new Error(`Railway API error: ${res.status} ${res.statusText}`);
  }

  const json = await res.json() as { data?: T; errors?: Array<{ message: string }> };

  if (json.errors?.length) {
    throw new Error(`Railway GraphQL error: ${json.errors.map((e) => e.message).join(', ')}`);
  }

  return json.data as T;
}

async function getLatestDeploymentId(projectId: string): Promise<string> {
  const query = `
    query {
      project(id: "${projectId}") {
        services {
          edges {
            node {
              deployments(first: 1) {
                edges {
                  node {
                    id
                    status
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await gqlRequest<{
    project?: {
      services?: {
        edges?: Array<{
          node?: {
            deployments?: {
              edges?: Array<{ node?: { id?: string; status?: string } }>;
            };
          };
        }>;
      };
    };
  }>(query);

  const serviceEdges = data.project?.services?.edges ?? [];
  for (const svc of serviceEdges) {
    const depEdges = svc.node?.deployments?.edges ?? [];
    for (const dep of depEdges) {
      const id = dep.node?.id;
      if (id) return id;
    }
  }

  throw new Error(`No deployments found for project: ${projectId}`);
}

async function fetchDeploymentLogs(deploymentId: string): Promise<string> {
  const query = `
    query {
      deploymentLogs(deploymentId: "${deploymentId}") {
        message
        timestamp
        severity
      }
    }
  `;

  const data = await gqlRequest<{
    deploymentLogs?: Array<{ message?: string; timestamp?: string; severity?: string }>;
  }>(query);

  const entries = data.deploymentLogs ?? [];

  if (entries.length === 0) {
    throw new Error(`No logs found for deployment: ${deploymentId}`);
  }

  return entries
    .map((e) => `[${e.timestamp ?? ''}] [${e.severity ?? 'INFO'}] ${e.message ?? ''}`)
    .join('\n');
}

async function analyzeLogsWithAI(logs: string): Promise<LogAnalysis> {
  const token = process.env.GROQ_API_KEY;
  if (!token) throw new Error('GROQ_API_KEY is not set');

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'Eres un experto debugger. Analiza estos logs de Railway y devuelve en JSON: { "hasError": boolean, "errorMessage": string, "affectedFile": string, "fix": string }. Responde SOLO con el JSON, sin markdown ni texto adicional.',
        },
        {
          role: 'user',
          content: logs,
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter API error: ${res.status} ${res.statusText}`);
  }

  const json = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = json.choices?.[0]?.message?.content ?? '';

  const raw = content
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();

  try {
    return JSON.parse(raw) as LogAnalysis;
  } catch {
    throw new Error(`Failed to parse AI response as JSON: ${raw.slice(0, 200)}`);
  }
}

async function generateAndApplyFix(
  affectedFile: string,
  errorMessage: string,
  suggestedFix: string,
): Promise<{ commitMessage: string; fix: string }> {
  const token = process.env.OPENROUTER_API_KEY;
  if (!token) throw new Error('OPENROUTER_API_KEY is not set');

  const fileContent = await getFileContent(affectedFile);

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'Eres un experto en debugging y corrección de código. Devuelve SOLO un JSON con este formato: { "fixedCode": string, "commitMessage": string }. El fixedCode debe ser el archivo completo corregido. Sin markdown.',
        },
        {
          role: 'user',
          content: `Error encontrado: ${errorMessage}\n\nSugerencia inicial: ${suggestedFix}\n\nCódigo actual del archivo "${affectedFile}":\n\n${fileContent}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter API error: ${res.status} ${res.statusText}`);
  }

  const json = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = json.choices?.[0]?.message?.content ?? '';

  let parsed: { fixedCode: string; commitMessage: string };
  try {
    parsed = JSON.parse(content) as { fixedCode: string; commitMessage: string };
  } catch {
    throw new Error(`Failed to parse fix response as JSON: ${content.slice(0, 200)}`);
  }

  await createOrUpdateFile(
    affectedFile,
    parsed.fixedCode,
    parsed.commitMessage,
  );

  return { commitMessage: parsed.commitMessage, fix: parsed.fixedCode };
}

async function generateFixWithGroq(
  affectedFile: string,
  errorMessage: string,
  code: string,
): Promise<string> {
  const token = process.env.GROQ_API_KEY;
  if (!token) throw new Error('GROQ_API_KEY is not set');

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        {
          role: 'system',
          content: `Eres un experto en Node.js y TypeScript. Se detectó este error en producción: ${errorMessage}. Este es el código del archivo ${affectedFile}: ${code}. Devuelve SOLO el código corregido completo, sin explicaciones ni markdown.`,
        },
        {
          role: 'user',
          content: 'Genera el fix.',
        },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Groq API error: ${res.status} ${res.statusText}`);

  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? '';
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runDebugger(projectId: string): Promise<DebugLoop> {
  const commits: string[] = [];
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const deploymentId = await getLatestDeploymentId(projectId);
    const logs = await fetchDeploymentLogs(deploymentId);
    const analysis = await analyzeLogsWithAI(logs);

    if (!analysis.hasError) {
      return { fixed: true, attempts: attempt, commits };
    }

    lastError = analysis.errorMessage;

    if (!analysis.affectedFile) {
      if (attempt === MAX_RETRIES) break;
      await wait(30_000);
      continue;
    }

    const code = await getFileContent(analysis.affectedFile);
    const fixedCode = await generateFixWithGroq(
      analysis.affectedFile,
      analysis.errorMessage,
      code,
    );

    const commitMessage = `fix(auto): attempt ${attempt} — ${analysis.errorMessage.slice(0, 72)}`;
    await createOrUpdateFile(analysis.affectedFile, fixedCode, commitMessage);
    commits.push(commitMessage);

    if (attempt < MAX_RETRIES) {
      await wait(30_000);
    }
  }

  return { fixed: false, attempts: MAX_RETRIES, lastError, commits };
}
