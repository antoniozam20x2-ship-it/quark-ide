#!/usr/bin/env node
// cost-export — emit cost-tracking telemetry in formats consumable by
// external observability systems.
//
// Outputs:
//   --prometheus <path>   write Prometheus textfile-collector exposition
//   --webhook <url>       POST JSON payload (default Content-Type: application/json)
//   (no flag)             write JSON to stdout
//
// Env:
//   EXPORT_NAMESPACE=cost-tracking (default)
//   EXPORT_WEBHOOK_HEADER='Authorization: Bearer xxx'  optional, may repeat (comma-separated)
//   EXPORT_QUIET=1        suppress confirmation output (errors still printed)

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ADR-100 / #1748 Issue 3 — CLI_CORE=1 routes to lite cli-core (~2s cold-cache).
// Export is list+retrieve only; no search. JSON backend is fine.
const CLI_PKG = process.env.CLI_CORE === '1'
  ? '@claude-flow/cli-core@alpha'
  : '@claude-flow/cli@latest';

const NS = process.env.EXPORT_NAMESPACE || 'cost-tracking';

function memoryListKeys() {
  const r = spawnSync('npx', [
    CLI_PKG, 'memory', 'list',
    '--namespace', NS, '--format', 'json',
  ], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', shell: process.platform === 'win32' });
  if (r.status !== 0) return [];
  const m = /\[[\s\S]*\]/.exec(r.stdout || '');
  if (!m) return [];
  try { return JSON.parse(m[0]).map((e) => e.key).filter(Boolean); } catch { return []; }
}
function memoryRetrieve(key) {
  const r = spawnSync('npx', [
    CLI_PKG, 'memory', 'retrieve',
    '--namespace', NS, '--key', key,
  ], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', shell: process.platform === 'win32' });
  if (r.status !== 0) return null;
  const m = /\{[\s\S]*\}/.exec(r.stdout || '');
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function gather() {
  const keys = memoryListKeys();
  const sessions = keys.filter((k) => k.startsWith('session-')).map(memoryRetrieve).filter(Boolean);
  const budget = keys.filter((k) => /^budget-config(-\d+)?$/.test(k)).sort().reverse()
    .map(memoryRetrieve).filter(Boolean)[0] || null;
  const totalUsd = sessions.reduce((s, r) => s + (r.total_cost_usd || 0), 0);
  const byTier = { haiku: 0, sonnet: 0, opus: 0, unknown: 0 };
  for (const r of sessions) {
    if (r.byTier) for (const [t, v] of Object.entries(r.byTier)) byTier[t] = (byTier[t] || 0) + v;
  }
  return { sessions, budget, totalUsd, byTier, exportedAt: new Date().toISOString() };
}

function escLabel(v) {
  return String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function toPrometheus(data) {
  const lines = [];
  lines.push('# HELP cost_tracker_total_usd Total measured cost across all sessions in USD');
  lines.push('# TYPE cost_tracker_total_usd gauge');
  lines.push(`cost_tracker_total_usd ${data.totalUsd.toFixed(6)}`);
  lines.push('');
  lines.push('# HELP cost_tracker_tier_total_usd Total cost per tier across all sessions');
  lines.push('# TYPE cost_tracker_tier_total_usd gauge');
  for (const [tier, cost] of Object.entries(data.byTier)) {
    lines.push(`cost_tracker_tier_total_usd{tier="${escLabel(tier)}"} ${(cost || 0).toFixed(6)}`);
  }
  lines.push('');
  lines.push('# HELP cost_tracker_session_total_usd Cost per session in USD');
  lines.push('# TYPE cost_tracker_session_total_usd gauge');
  lines.push('# HELP cost_tracker_session_messages Assistant messages per session');
  lines.push('# TYPE cost_tracker_session_messages counter');
  for (const s of data.sessions) {
    const sid = (s.sessionId || '').slice(0, 8);
    lines.push(`cost_tracker_session_total_usd{session="${escLabel(sid)}"} ${(s.total_cost_usd || 0).toFixed(6)}`);
    lines.push(`cost_tracker_session_messages{session="${escLabel(sid)}"} ${s.messageCount || 0}`);
  }
  if (data.budget?.budget_usd) {
    lines.push('');
    lines.push('# HELP cost_tracker_budget_usd Configured budget limit in USD');
    lines.push('# TYPE cost_tracker_budget_usd gauge');
    lines.push(`cost_tracker_budget_usd ${data.budget.budget_usd.toFixed(2)}`);
    lines.push('# HELP cost_tracker_budget_utilization Spent / budget ratio (0.0–∞)');
    lines.push('# TYPE cost_tracker_budget_utilization gauge');
    lines.push(`cost_tracker_budget_utilization ${(data.totalUsd / data.budget.budget_usd).toFixed(6)}`);
  }
  return lines.join('\n') + '\n';
}

async function postWebhook(url, data) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.EXPORT_WEBHOOK_HEADER) {
    for (const h of process.env.EXPORT_WEBHOOK_HEADER.split(',')) {
      const [k, ...rest] = h.split(':');
      if (k && rest.length) headers[k.trim()] = rest.join(':').trim();
    }
  }
  const resp = await fetch(url, {
    method: 'POST', headers, body: JSON.stringify(data),
  });
  return { status: resp.status, ok: resp.ok };
}

function parseArgs() {
  const args = process.argv.slice(2);
  let prometheus = null, webhook = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prometheus') prometheus = args[++i];
    else if (args[i] === '--webhook') webhook = args[++i];
  }
  return { prometheus, webhook };
}

async function main() {
  const { prometheus, webhook } = parseArgs();
  const data = gather();
  if (process.env.EXPORT_QUIET !== '1') {
    console.error(`Exported ${data.sessions.length} sessions, total $${data.totalUsd.toFixed(2)}`);
  }
  if (prometheus) {
    mkdirSync(dirname(prometheus), { recursive: true });
    writeFileSync(prometheus, toPrometheus(data));
    if (process.env.EXPORT_QUIET !== '1') console.error(`Wrote Prometheus textfile: ${prometheus}`);
  }
  if (webhook) {
    const r = await postWebhook(webhook, data);
    if (!r.ok) {
      console.error(`Webhook POST failed: HTTP ${r.status}`);
      process.exit(1);
    }
    if (process.env.EXPORT_QUIET !== '1') console.error(`Webhook POST ok (HTTP ${r.status})`);
  }
  if (!prometheus && !webhook) {
    console.log(JSON.stringify(data, null, 2));
  }
}

main().catch((e) => { console.error('export failed:', e.message || e); process.exit(1); });
