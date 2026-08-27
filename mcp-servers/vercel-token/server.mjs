#!/usr/bin/env node
// Minimal local MCP server that talks to Vercel's REST API using a
// Personal Access Token (Bearer), instead of mcp.vercel.com's OAuth-only
// remote server. See PR description for why: mcp.vercel.com only accepts
// OAuth from a small list of Vercel-approved clients, and its dynamic
// client registration rejects any custom HTTPS redirect_uri outright
// (confirmed via direct testing), which is incompatible with
// openchamber-service's server-hosted, ephemeral-container architecture.
//
// Requires the VERCEL_API_KEY environment variable (a Vercel Access
// Token). Optionally reads VERCEL_TEAM_ID to scope requests to a team.
//
// Implements exactly the tools this project's AGENTS.md preview/QA flow
// depends on: list_projects, get_deployment, get_deployment_build_logs,
// deploy_to_vercel (target defaults to "preview").

import { spawn } from 'node:child_process';
import readline from 'node:readline';

const VERCEL_API_KEY = process.env.VERCEL_API_KEY || '';
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || '';
const API_BASE = 'https://api.vercel.com';

function withTeam(params) {
  const p = new URLSearchParams(params || {});
  if (VERCEL_TEAM_ID) p.set('teamId', VERCEL_TEAM_ID);
  return p;
}

async function vercelFetch(path, { method = 'GET', params, body } = {}) {
  if (!VERCEL_API_KEY) {
    throw new Error('VERCEL_API_KEY is not set in the environment for this MCP server.');
  }
  const qs = withTeam(params).toString();
  const url = `${API_BASE}${path}${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${VERCEL_API_KEY}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const desc = json?.error?.message || json?.error?.code || res.statusText;
    throw new Error(`Vercel API ${method} ${path} -> ${res.status}: ${desc}`);
  }
  return json;
}

function runVercelCli(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn('npx', ['--yes', 'vercel@latest', ...args], {
      cwd: cwd || process.cwd(),
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err) }));
  });
}

const tools = [
  {
    name: 'list_projects',
    description: "List Vercel projects for the token's account/team.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max number of projects to return (default 20).' },
        search: { type: 'string', description: 'Filter projects by name substring.' },
      },
    },
    handler: async (args) => {
      const params = {};
      if (args?.limit) params.limit = String(args.limit);
      if (args?.search) params.search = args.search;
      const data = await vercelFetch('/v10/projects', { params });
      const projects = (data.projects || []).map((p) => ({
        id: p.id,
        name: p.name,
        latestDeploymentUrl: p.latestDeployments?.[0]?.url || null,
        framework: p.framework || null,
      }));
      return { projects, pagination: data.pagination || null };
    },
  },
  {
    name: 'get_deployment',
    description: 'Get a deployment by ID or hostname/URL, including its readyState (e.g. READY, BUILDING, ERROR).',
    inputSchema: {
      type: 'object',
      properties: {
        idOrUrl: { type: 'string', description: 'Deployment ID (starts with dpl_) or hostname/URL.' },
      },
      required: ['idOrUrl'],
    },
    handler: async (args) => {
      const data = await vercelFetch(`/v13/deployments/${encodeURIComponent(args.idOrUrl)}`);
      return {
        id: data.id,
        url: data.url,
        readyState: data.readyState,
        target: data.target,
        alias: data.alias || [],
        createdAt: data.createdAt,
      };
    },
  },
  {
    name: 'get_deployment_build_logs',
    description: 'Get build/runtime events (logs) for a deployment by ID or hostname/URL.',
    inputSchema: {
      type: 'object',
      properties: {
        idOrUrl: { type: 'string', description: 'Deployment ID (starts with dpl_) or hostname/URL.' },
        limit: { type: 'number', description: 'Maximum number of log lines (default 200).' },
      },
      required: ['idOrUrl'],
    },
    handler: async (args) => {
      const params = { limit: String(args?.limit || 200) };
      const data = await vercelFetch(`/v3/deployments/${encodeURIComponent(args.idOrUrl)}/events`, { params });
      const events = Array.isArray(data) ? data : data.events || [];
      const lines = events.map((e) => `[${e.type || 'log'}] ${e.payload?.text ?? e.text ?? JSON.stringify(e)}`);
      return { lines };
    },
  },
  {
    name: 'deploy_to_vercel',
    description: 'Deploy the current project directory to Vercel. target defaults to "preview"; use "production" only when explicitly requested.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['preview', 'production'], description: 'Deployment target. Defaults to preview.' },
        cwd: { type: 'string', description: 'Directory to deploy. Defaults to the current working directory.' },
      },
    },
    handler: async (args) => {
      const target = args?.target === 'production' ? 'production' : 'preview';
      const cliArgs = ['deploy', '--yes', '--token', VERCEL_API_KEY];
      if (VERCEL_TEAM_ID) cliArgs.push('--scope', VERCEL_TEAM_ID);
      if (target === 'production') cliArgs.push('--prod');
      const { code, stdout, stderr } = await runVercelCli(cliArgs, args?.cwd);
      const urlMatch = stdout.match(/https:\/\/[^\s]+\.vercel\.app\S*/g);
      const url = urlMatch ? urlMatch[urlMatch.length - 1] : null;
      if (code !== 0 && !url) {
        throw new Error(`vercel deploy failed (exit ${code}): ${stderr || stdout}`.slice(0, 4000));
      }
      return { target, url, stdout: stdout.slice(-4000), stderr: stderr.slice(-2000) };
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  const { id, method, params } = msg;
  const respond = (result) => { if (id !== undefined) send({ jsonrpc: '2.0', id, result }); };
  const respondError = (code, message) => { if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code, message } }); };

  try {
    if (method === 'initialize') {
      respond({
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'vercel-token', version: '1.0.0' },
      });
    } else if (method === 'notifications/initialized') {
      // no response for notifications
    } else if (method === 'ping') {
      respond({});
    } else if (method === 'tools/list') {
      respond({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    } else if (method === 'tools/call') {
      const tool = tools.find((t) => t.name === params?.name);
      if (!tool) {
        respond(toolError(`Unknown tool: ${params?.name}`));
        return;
      }
      try {
        const result = await tool.handler(params?.arguments || {});
        respond(toolResult(result));
      } catch (err) {
        respond(toolError(String(err?.message || err)));
      }
    } else if (id !== undefined) {
      respondError(-32601, `Method not found: ${method}`);
    }
  } catch (err) {
    if (id !== undefined) respondError(-32000, String(err?.message || err));
  }
});
