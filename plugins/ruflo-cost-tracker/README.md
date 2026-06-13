# ruflo-cost-tracker

Token usage tracking, model cost attribution per agent, budget alerts, and optimization recommendations.

## Overview

Tracks token usage per agent, task, and model, then computes USD cost attribution using current model pricing. Monitors configurable budgets with tiered alerts (info at 50%, warning at 75%, critical at 90%, hard stop at 100%). Analyzes usage patterns and recommends optimizations such as model downgrades, prompt caching, and batch operations.

## Installation

```bash
claude --plugin-dir plugins/ruflo-cost-tracker
```

## Agents

| Agent | Model | Role |
|-------|-------|------|
| `cost-analyst` | haiku | Token usage tracking, USD cost attribution, budget monitoring, optimization recommendations |

## Skills

| Skill | Usage | Description |
|-------|-------|-------------|
| `cost-report` | `/cost-report [--period today]` | Generate a cost report with token usage and USD costs by tier, model, and agent |
| `cost-optimize` | `/cost-optimize` | Analyze usage patterns, recommend cost optimizations, and emit `hooks_model-outcome` events |
| `cost-track` | `/cost-track` | **Auto-capture** per-session token usage from the Claude Code jsonl into `cost-tracking` namespace (producer side) |
| `cost-budget-check` | `/cost-budget-check [--period today\|week\|month\|all]` | Read totals + budget config, emit 50/75/90/100% alert ladder; exit 1 on HARD_STOP |
| `cost-booster-route` | `/cost-booster-route <task>` | Route tasks via `hooks_route` and report Agent Booster (Tier 1) bypass utilization |
| `cost-booster-edit` | `/cost-booster-edit <intent> <file>` | **Apply** a Tier 1 transform via `agent-booster.apply()` (sub-millisecond, $0, deterministic) |
| `cost-benchmark` | `/cost-benchmark [--llm] [--anthropic]` | Run the corpus benchmark and persist measured-vs-claimed table to `docs/benchmarks/runs/` |
| `cost-trend` | `/cost-trend` | Read all bench runs and surface drift (win rate, latency, speedup) — flags regressions the smoke gate misses |
| `cost-conversation` | `/cost-conversation` | Per-conversation cost view (different lens from cost-report's per-agent / per-model) |
| `cost-export` | `/cost-export [--prometheus <path>] [--webhook <url>]` | Emit cost data as Prometheus textfile or POST to a webhook |
| `cost-federation` | `/cost-federation` | ADR-097 Phase 3 consumer — per-peer 1h/24h/7d federation_spend rolling windows |
| `cost-summary` | `/cost-summary [--format json\|markdown]` | Single-shot programmatic dump of all cost data (stable JSON contract for inter-plugin consumption) |
| `cost-compact-context` | `/cost-compact-context <query>` | Wrap `getTokenOptimizer().getCompactContext()` for retrieval-compacted analysis (graceful fallback when agentic-flow not installed) |

## Commands (15 subcommands)

```bash
cost track                                # Auto-capture this session's token usage (producer)
cost report [--period today|week|month]   # Cost report (with By-tier block, reads measured booster data)
cost breakdown [--by agent|model|task]    # Detailed breakdown by dimension
cost optimize                             # Analyze usage and suggest savings (+ auto-emits hooks_model-outcome via outcome.mjs)
cost outcome <task> <model> <outcome>     # Emit hooks_model-outcome (success|escalated|failure) so the router learns
cost budget set <amount>                  # Set USD budget (real impl, persists to cost-tracking)
cost budget get                           # Show current budget config
cost budget check [--period ...]          # Compute utilization + alert; exit 1 on HARD_STOP
cost benchmark [--llm] [--anthropic]      # Run measured benchmark — booster + optional Gemini/Sonnet/Opus baselines
cost trend                                # Drift across bench runs (win rate, latency, regressions)
cost conversation                         # Per-conversation cost view
cost summary [--format json|markdown]     # Programmatic JSON contract for inter-plugin consumption
cost export [--prometheus] [--webhook]    # External observability — Prometheus textfile + webhook POST
cost federation                           # ADR-097 Phase 3 federation_spend consumer
cost workers                              # Inspect optimize + benchmark loop-workers consumed
cost history                              # Show cost tracking over time
```

## Optimization integration (ADR-0002)

Four upstream capabilities are now wired to the cost-tracker surface — every optimization recommendation maps to a real tool, not a heuristic:

| Capability | Where | Surfaced by |
|---|---|---|
| **Agent Booster bypass** (Tier 1, $0, WASM) | `hooks_route` emits `[AGENT_BOOSTER_AVAILABLE]` (CLI: `npx @claude-flow/cli@latest hooks route --task ...`) | `cost-booster-route` skill |
| **Token optimizer / compact context** | `getTokenOptimizer().getCompactContext()` from `@claude-flow/integration` (uses `agentic-flow` when present) | `cost-compact-context` skill |
| **Model-outcome feedback loop** | `hooks_model-outcome` (typed equivalent of legacy `routing-outcomes`) | `cost-optimize` skill step 8 |
| **Optimize + benchmark loop workers** | `hooks_worker-status --worker optimize / --worker benchmark` (declared by ruflo-loop-workers) | `cost workers` command + `cost-analyst` agent |

CLAUDE.md root percentage claims (`-32%` retrieval, `-15%` booster edits, `352x` speedup, `95%` cache hit) are **claimed upstream, not yet verified** in this repo. The skills above tag every figure with that disclaimer; only the structural `$0` cost of Tier 1 bypasses is reported as a measured saving.

See [ADR-0002](./docs/adrs/0002-agentic-flow-and-agent-booster-integration.md) for the full rationale, including the riskiest assumption (no MCP wrapper for `getTokenOptimizer` — `cost-compact-context` shells a Node one-liner).

## Model Pricing (per 1M tokens)

| Model | Input | Output | Cache Write | Cache Read |
|-------|-------|--------|-------------|------------|
| Haiku | $0.25 | $1.25 | $0.30 | $0.03 |
| Sonnet | $3.00 | $15.00 | $3.75 | $0.30 |
| Opus | $15.00 | $75.00 | $18.75 | $1.50 |

## Budget Alert Thresholds

| Level | Threshold | Action |
|-------|-----------|--------|
| Info | 50% consumed | Log notification |
| Warning | 75% consumed | Display warning, suggest optimizations |
| Critical | 90% consumed | Urgent alert, recommend model downgrades |
| Hard Stop | 100% consumed | Halt non-essential agent spawns |

## Optimization Strategies

| Strategy | Savings | Impact |
|----------|---------|--------|
| Downgrade simple tasks to Haiku | 80-92% | Minimal for low-complexity work |
| Enable prompt caching | 90% on reads | None (same quality) |
| Batch similar operations | 15-25% | Slight latency increase |
| Use Agent Booster (Tier 1) | 100% | Only for simple transforms |
| Shorten system prompts | 10-20% | Requires careful pruning |

## Federation budget circuit breaker pairing (ruflo 3.6.25+)

This plugin pairs naturally with the federation budget envelope shipped in [ADR-097](../../v3/docs/adr/ADR-097-federation-budget-circuit-breaker.md). The `federation_send` MCP tool now accepts caller-supplied caps that this plugin's tracking should respect:

| Field | Default | Effect |
|---|---|---|
| `maxHops` | `8` | Hard ceiling on recursive delegation across federated peers — defangs cost cascades from runaway sub-swarms. |
| `maxTokens` | unbounded | Σ tokens across the whole hop chain. Returns `BUDGET_EXCEEDED` (constant string, no oracle leak) on overshoot. |
| `maxUsd` | unbounded | Σ USD across hops. Same enforcement. |
| `hopCount` | `0` | Pass-through for re-forwarded messages. |
| `spent.{tokens,usd}` | `0` | Caller-reported usage from previous legs. Negatives clamped to 0. |

Phase 1 of ADR-097 enforces at the **send** side. Two follow-up phases will tighten the integration:

- **Phase 2 (deferred)** — peer state machine `ACTIVE` / `SUSPENDED` / `EVICTED` driven by trailing 24h cost (default suspension threshold $5) + 1h failure ratio (>50% over ≥10 sends). Auto-recovery after 30 min cooldown.
- **Phase 3 (deferred)** — `federation_spend` event bus. Each `federation_send` completion publishes `{peerId, taskId, tokensUsed, usdSpent, ts}`. This plugin's cost-tracker should aggregate per-peer rolling windows (1h / 24h / 7d) and expose them via the existing `cost-report` skill. Breaker queries the aggregate to evaluate suspension thresholds.

Until Phase 3 ships, federated spend is **not** counted in the host's cost-tracker — only local agent spend. Treat `cost-report` numbers as a lower bound when federation is in use.

## Compatibility

- **CLI:** pinned to `@claude-flow/cli` v3.6 major+minor.
- **Verification:** `bash plugins/ruflo-cost-tracker/scripts/smoke.sh` is the contract.

## Namespace coordination

This plugin owns two AgentDB namespaces:

- `cost-tracking` — usage records (consumed by `cost-report`)
- `cost-patterns` — optimization recommendations (consumed by `cost-optimize`)

Both follow the kebab-case `<plugin-stem>-<intent>` convention from [ruflo-agentdb ADR-0001 §"Namespace convention"](../ruflo-agentdb/docs/adrs/0001-agentdb-optimization.md). Both are accessed via the `memory_*` tool family which routes by namespace.

> **Routing note:** The `agentdb_hierarchical-*` and `agentdb_pattern-*` tools route by tier / ReasoningBank, not by namespace string. Earlier versions of `cost-report` and `cost-optimize` passed namespace arguments to those tools and got silently-ignored behavior. ADR-0001 fixes this by switching the load path to `memory_*` and documenting the dual write path for optimization patterns.

Reserved namespaces (`pattern`, `claude-memories`, `default`) MUST NOT be shadowed.

## Verification

```bash
bash plugins/ruflo-cost-tracker/scripts/smoke.sh
# Expected: "44 passed, 0 failed"

CI: see [`.github/workflows/cost-tracker-smoke.yml`](../../.github/workflows/cost-tracker-smoke.yml).
On every PR touching this plugin, GitHub Actions runs smoke + booster-only bench
+ regression gate (Tier 1 winRate ≥ 0.80). LLM/Anthropic baselines are NOT run in CI
— they cost real money per invocation and belong in a manual / scheduled workflow.
```

## Architecture Decisions

- [`ADR-0001` — ruflo-cost-tracker plugin contract (namespace-routing fix, federation budget pairing, smoke as contract)](./docs/adrs/0001-cost-tracker-contract.md)
- [`ADR-0002` — agentic-flow + Agent Booster integration, model-outcome feedback loop, optimize-worker consumption, tier-aware reporting](./docs/adrs/0002-agentic-flow-and-agent-booster-integration.md)
- [`ADR-0003` — Implementation arc v0.5 → v0.15 (auto-capture, budget enforcement, model-outcome feedback, observability, federation consumer)](./docs/adrs/0003-implementation-arc-v0.5-to-v0.15.md)

## Related Plugins

- `ruflo-agentdb` — namespace convention owner; defines the routing rules ADR-0001 fixes a violation of
- `ruflo-observability` -- Token usage metrics collected via observability instrumentation
- `ruflo-neural-trader` -- PnL tracking and cost-adjusted return calculation
- `ruflo-federation` -- Budget circuit breaker on outbound federation_send (ADR-097)

## License

MIT
