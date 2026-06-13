---
name: ruflo-cost
description: Cost tracking operations — generate reports, view breakdowns, set budgets, and get optimization recommendations
---

Cost tracking commands:

**`cost report [--period today|week|month]`** -- Generate a cost report for the specified period.
1. Recall token usage records from `cost-tracking` namespace for the period
2. Compute costs by model using current pricing (haiku/sonnet/opus input/output rates)
3. Aggregate by agent, task, and model
4. Show budget utilization percentage if a budget is configured
5. Display: total cost, breakdown by model, breakdown by agent, budget status

**`cost breakdown [--by agent|model|task]`** -- Detailed cost breakdown by dimension.
1. Recall all usage records from `cost-tracking` namespace
2. Group by the specified dimension (agent, model, or task)
3. For each group: total tokens (input/output/cache), total cost, percentage of total
4. Sort by cost descending
5. Display: dimension value, input tokens, output tokens, cache tokens, total cost, share %

**`cost budget set <amount>`** -- Set a budget limit in USD (real implementation, persisted to `cost-tracking:budget-config`).
1. Run `node plugins/ruflo-cost-tracker/scripts/budget.mjs set <amount>` to write the config to the cost-tracking namespace
2. Thresholds default to: info 50% · warning 75% · critical 90% · hard_stop 100%
3. Report: confirmed amount + namespace key

**`cost budget get`** -- Show the current budget config.
1. Run `node plugins/ruflo-cost-tracker/scripts/budget.mjs get`
2. Report: amount, when set, threshold ladder

**`cost budget check [--period today|week|month|all]`** -- Compute utilization + alert level (50/75/90/100% ladder).
1. Run `node plugins/ruflo-cost-tracker/scripts/budget.mjs check`
2. Filter by `BUDGET_PERIOD=today|week|month|all` (default `all`)
3. Sum `total_cost_usd` across all `session-*` records in cost-tracking
4. Compute utilization vs. budget; emit 🟢 OK / 🟡 INFO / 🟠 WARNING / 🔴 CRITICAL / 🛑 HARD_STOP
5. Exit code 1 on HARD_STOP — wrap agent spawns in `budget check && spawn ...` to fail closed

**`cost optimize`** -- Analyze usage and suggest cost optimizations.
1. Recall recent usage data from `cost-tracking` namespace
2. For each agent, analyze: average task complexity, model used, token efficiency
3. Identify agents using expensive models for low-complexity tasks
4. Check cache hit rates and suggest caching improvements
5. Look for redundant agent spawns or duplicate work
6. Calculate estimated savings for each recommendation
7. Display: recommendation, current cost, projected cost, savings, impact assessment

**`cost track`** -- Auto-capture token usage for the active Claude Code session and persist to the `cost-tracking` namespace. Run after significant work or at session end so `cost report` has real data.
1. Invoke `node plugins/ruflo-cost-tracker/scripts/track.mjs` (no flags = current cwd's most-recent session)
2. Print: total cost, per-model and per-tier breakdown, persisted memory key
3. Sets the `cost-tracking` namespace record at key `session-<sessionId>` (consumed by `cost-report` step 1)

**`cost outcome <task> <model> <outcome>`** -- Emit a `hooks_model-outcome` event so the router learns from applied recommendations. Auto-wired into `cost-optimize` step 8.
1. Validates `outcome ∈ {success, escalated, failure}`
2. Runs `node plugins/ruflo-cost-tracker/scripts/outcome.mjs "<task>" <model> <outcome>`
3. The script wraps `npx @claude-flow/cli hooks model-outcome -t ... -m ... -o ...` with explicit-argv spawnSync so quoting is safe
4. Without this, the router doesn't learn from cost-optimize recommendations and the Tier 1 bypass rate doesn't tighten over time

**`cost summary [--format json|markdown]`** -- Single-shot programmatic dump of all cost data. Other plugins/scripts can shell out and parse the JSON.
1. Run `node plugins/ruflo-cost-tracker/scripts/summary.mjs --format json`
2. Output: total_cost_usd, sessionCount, byTier, byModel, topSession, budget, federation aggregate
3. Default `--format markdown`; JSON contract is stable for programmatic consumers
4. ADR-0002 considered an MCP-tool form but deferred (requires v3 source change); this is the plugin-local equivalent

**`cost federation`** -- Consumer-side wiring for ADR-097 Phase 3 federation_spend events. Aggregates per-peer 1h/24h/7d rolling windows and flags peers exceeding the suspension threshold (default $5/24h).
1. Run `node plugins/ruflo-cost-tracker/scripts/federation.mjs`
2. Optional: `FED_FORMAT=json`, `FED_NAMESPACE=federation-spend`, `FED_SUSPEND_THRESHOLD_USD=5.0`
3. Reports gracefully when no events present (Phase 3 not yet landed upstream)
4. Activates automatically when upstream publishes `{peerId, taskId, tokensUsed, usdSpent, ts}` to the `federation-spend` namespace

**`cost export [--prometheus <path>] [--webhook <url>]`** -- Export cost-tracking telemetry to external observability systems.
1. `--prometheus <path>` writes the node_exporter textfile-collector format (gauges + counters with session labels)
2. `--webhook <url>` POSTs JSON; auth via `EXPORT_WEBHOOK_HEADER='K: V'`
3. No flag → stdout JSON
4. Metrics emitted: `cost_tracker_total_usd`, `cost_tracker_tier_total_usd{tier=...}`, `cost_tracker_session_total_usd{session=...}`, `cost_tracker_session_messages{session=...}`, `cost_tracker_budget_usd`, `cost_tracker_budget_utilization`

**`cost conversation`** -- Per-conversation cost view: list every session in `cost-tracking` with started-at, message count, top model, total cost. Different lens from `cost report` (which is per-agent/per-model).
1. Run `node plugins/ruflo-cost-tracker/scripts/conversation.mjs`
2. Optional `CONV_FORMAT=json`, `CONV_LIMIT=N`, `CONV_NAMESPACE=...`
3. Reports: total across conversations, per-tier rollup, per-session table

**`cost trend`** -- Read all docs/benchmarks/runs/*.json and surface drift in the gate metrics — win rate, avg latency, p99, escalation rate, speedup vs LLM. Flags regressions the binary smoke gate misses.
1. Run `node plugins/ruflo-cost-tracker/scripts/trend.mjs`
2. Optional `TREND_FORMAT=json` for machine-readable output, `TREND_LIMIT=N` to truncate
3. Reports: first→last deltas + per-run series + regression flags (win rate drop or ≥1.5× latency rise)

**`cost benchmark [--llm] [--anthropic]`** -- Run the corpus benchmark to verify booster claims with measured numbers.
1. Without flags: booster-only (free, ~85 ms wall-time, no API keys needed)
2. `--llm`: also run Gemini 2.0 Flash baseline (uses GCP `GOOGLE_AI_API_KEY` secret)
3. `--anthropic`: also run Claude Sonnet 4.6 + Opus 4.7 (uses GCP `ANTHROPIC_API_KEY` secret)
4. Writes results to `docs/benchmarks/runs/latest.json` and timestamped sibling
5. Print: win rate (Tier 1 cases), escalation rate (adversarial cases), per-endpoint avg latency, cost/edit, measured speedup
6. Smoke step 23 fails the build if `winRate < 0.80`. See `cost-benchmark` skill for env-var overrides.

**`cost workers`** -- Inspect the `optimize` and `benchmark` background workers consumed from ruflo-loop-workers.
1. Call `mcp__claude-flow__hooks_worker-status --worker optimize` -- report last-run timestamp, outcome, and any pending recommendations
2. Call `mcp__claude-flow__hooks_worker-status --worker benchmark` -- report last-run timestamp, outcome, and any pending benchmark deltas
3. Cross-link [ruflo-loop-workers ADR-0001 §"12-worker trigger map"](../../ruflo-loop-workers/docs/adrs/0001-loop-workers-contract.md) — the contract this command honors
4. Display: worker name, status, last-run timestamp, outcome, last-summary

**`cost history`** -- Show cost tracking history over time.
1. Recall all cost reports from `cost-tracking` namespace
2. Show daily/weekly totals with trend direction
3. Highlight days with unusual spending (>2x average)
4. Display: date, total cost, top agent, top model, budget status
