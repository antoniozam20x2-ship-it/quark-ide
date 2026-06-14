import { getFileContent, createOrUpdateFile } from './github.js';

const RAILWAY_GQL = 'https://backboard.railway.app/graphql/v2';
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

async function fetchRailwayLogs(projectId: string): Promise<string> {
  const token = process.env.RAILWAY_API_TOKEN;
  if (!token) throw new Error('RAILWAY_API_TOKEN is not set');

  const query = `
    query GetDeploymentLogs($projectId: String!) {
      project(id: $projectId) {
        environments {
          edges {
            node {
              deployments(last: 1) {
                edges {
                  node {
                    id
                    logs(limit: 200) {
                      edges {
                        node {
                          message
                          timestamp
                          severity
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const res = await fetch(RAILWAY_GQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables: { projectId } }),
  });

  if (!res.ok) {
    throw new Error(`Railway API error: ${res.status} ${res.statusText}`);
  }

  const json = await res.json() as {
    data?: {
      project?: {
        environments?: {
          edges?: Array<{
            node?: {
              deployments?: {
                edges?: Array<{
                  node?: {
                    logs?: {
                      edges?: Array<{
                        node?: { message?: string; timestamp?: string; severity?: string };
                      }>;
                    };
                  };
                }>;
              };
            };
          }>;
        };
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (json.errors?.length) {
    throw new Error(`Railway GraphQL error: ${json.errors.map((e) => e.message).join(', ')}`);
  }

  const envEdges = json.data?.project?.environments?.edges ?? [];
  const logLines: string[] = [];

  for (const envEdge of envEdges) {
    const deployEdges = envEdge.node?.deployments?.edges ?? [];
    for (const depEdge of deployEdges) {
      const logEdges = depEdge.node?.logs?.edges ?? [];
      for (const logEdge of logEdges) {
        const { message, timestamp, severity } = logEdge.node ?? {};
        if (message) {
          logLines.push(`[${timestamp ?? ''}] [${severity ?? 'INFO'}] ${message}`);
        }
      }
    }
  }

  if (logLines.length === 0) {
    throw new Error('No logs found for the most recent deployment');
  }

  return logLines.join('\n');
}

async function analyzeLogsWithAI(logs: string): Promise<LogAnalysis> {
  const token = process.env.OPENROUTER_API_KEY;
  if (!token) throw new Error('OPENROUTER_API_KEY is not set');

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
  const logs = await fetchRailwayLogs(projectId);
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
