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

  try {
    return JSON.parse(content) as LogAnalysis;
  } catch {
    throw new Error(`Failed to parse AI response as JSON: ${content.slice(0, 200)}`);
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

export async function runDebugger(projectId: string): Promise<DebugResult> {
  const deploymentId = await getLatestDeploymentId(projectId);
  const logs = await fetchDeploymentLogs(deploymentId);
  const analysis = await analyzeLogsWithAI(logs);

  if (!analysis.hasError) {
    return { hasError: false };
  }

  if (!analysis.affectedFile) {
    return {
      hasError: true,
      errorMessage: analysis.errorMessage,
      affectedFile: '',
      rawAnalysis: analysis.fix,
    };
  }

  const { commitMessage, fix } = await generateAndApplyFix(
    analysis.affectedFile,
    analysis.errorMessage,
    analysis.fix,
  );

  return {
    hasError: true,
    errorMessage: analysis.errorMessage,
    affectedFile: analysis.affectedFile,
    fixed: true,
    commitMessage,
    fix,
  };
}
