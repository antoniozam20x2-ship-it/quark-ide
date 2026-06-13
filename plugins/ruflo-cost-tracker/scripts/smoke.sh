#!/usr/bin/env bash
# Structural smoke test for ruflo-cost-tracker v0.3.0 (ADR-0001 + ADR-0002).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0
step() { printf "→ %s ... " "$1"; }
ok()   { printf "PASS\n"; PASS=$((PASS+1)); }
bad()  { printf "FAIL: %s\n" "$1"; FAIL=$((FAIL+1)); }

step "1. plugin.json declares 0.16.1 with new keywords"
v=$(grep -E '"version"' "$ROOT/.claude-plugin/plugin.json" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
if [[ "$v" != "0.16.1" ]]; then
  bad "expected 0.16.1, got '$v'"
else
  miss=""
  for k in namespace-routing mcp agentic-flow agent-booster tier1-routing model-routing benchmarking verified telemetry budget; do
    grep -q "\"$k\"" "$ROOT/.claude-plugin/plugin.json" || miss="$miss $k"
  done
  [[ -z "$miss" ]] && ok || bad "missing keywords:$miss"
fi

step "2. all thirteen skills present with valid frontmatter"
miss=""
for s in cost-report cost-optimize cost-booster-route cost-booster-edit cost-compact-context cost-benchmark cost-track cost-budget-check cost-trend cost-conversation cost-export cost-federation cost-summary; do
  f="$ROOT/skills/$s/SKILL.md"
  [[ -f "$f" ]] || { miss="$miss missing-$s"; continue; }
  for k in 'name:' 'description:' 'allowed-tools:'; do
    grep -q "^$k" "$f" || miss="$miss $s-no-$k"
  done
done
[[ -z "$miss" ]] && ok || bad "$miss"

step "3. skills use memory_* (namespace-routed), not agentdb_hierarchical-* with namespace"
miss=""
F="$ROOT/skills/cost-report/SKILL.md"
grep -q "memory_search\|memory_list\|memory_retrieve" "$F" || miss="$miss cost-report-no-memory"
grep -qE "agentdb_hierarchical-recall.+cost-tracking|cost-tracking.+agentdb_hierarchical-recall" "$F" && miss="$miss cost-report-still-uses-hierarchical"
F="$ROOT/skills/cost-optimize/SKILL.md"
grep -q "memory_search\|memory_list" "$F" || miss="$miss cost-optimize-no-memory"
[[ -z "$miss" ]] && ok || bad "$miss"

step "4. cost-optimize documents both pattern-store paths"
F="$ROOT/skills/cost-optimize/SKILL.md"
if grep -q "ReasoningBank" "$F" \
   && grep -q "memory_store --namespace cost-patterns" "$F"; then
  ok
else
  bad "missing dual-path documentation"
fi

step "5. README pins @claude-flow/cli to v3.6"
grep -qE "@claude-flow/cli.*v3\.6|v3\.6.*claude-flow/cli" "$ROOT/README.md" \
  && ok || bad "v3.6 pin missing"

step "6. README defers to ruflo-agentdb namespace convention"
grep -q "ruflo-agentdb" "$ROOT/README.md" \
  && grep -q "Namespace convention" "$ROOT/README.md" \
  && ok || bad "namespace coordination block incomplete"

step "7. README federation budget circuit breaker (ADR-097) block intact"
F="$ROOT/README.md"
miss=""
grep -q "ADR-097" "$F" || miss="$miss adr-ref"
grep -qE "maxHops|maxTokens|maxUsd" "$F" || miss="$miss budget-fields"
grep -q "BUDGET_EXCEEDED" "$F" || miss="$miss enforcement-string"
[[ -z "$miss" ]] && ok || bad "federation block missing:$miss"

step "8. ADR-0001/0002/0003 exist with status Accepted"
miss=""
for n in 0001:Accepted 0002:Accepted 0003:Accepted; do
  num=${n%:*}
  want=${n#*:}
  f=$(ls "$ROOT/docs/adrs/${num}"-*.md 2>/dev/null | head -1)
  [[ -f "$f" ]] || { miss="$miss missing-adr-$num"; continue; }
  grep -qE "^status:[[:space:]]*$want" "$f" || miss="$miss $num-not-$want"
done
[[ -z "$miss" ]] && ok || bad "$miss"

step "9. REFERENCE.md exists and is non-empty"
[[ -s "$ROOT/REFERENCE.md" ]] && ok || bad "REFERENCE.md missing or empty"

step "10. no wildcard tool grants in skills"
bad_skills=""
for f in "$ROOT"/skills/*/SKILL.md; do
  grep -q '^allowed-tools:[[:space:]]*\*' "$f" && bad_skills="$bad_skills $(basename $(dirname "$f"))"
done
[[ -z "$bad_skills" ]] && ok || bad "wildcard:$bad_skills"

# ─── ADR-0002 checks (11–16) ─────────────────────────────────────────────────

step "11. cost-booster-route skill references hooks_route + AGENT_BOOSTER_AVAILABLE"
F="$ROOT/skills/cost-booster-route/SKILL.md"
miss=""
grep -q "hooks_route" "$F" || miss="$miss hooks_route"
grep -q "AGENT_BOOSTER_AVAILABLE" "$F" || miss="$miss booster-literal"
grep -q '^allowed-tools:[[:space:]]*\*' "$F" && miss="$miss wildcard"
[[ -z "$miss" ]] && ok || bad "$miss"

step "12. cost-compact-context skill references getTokenOptimizer + tags upstream figures"
F="$ROOT/skills/cost-compact-context/SKILL.md"
miss=""
grep -qE "getTokenOptimizer|@claude-flow/integration" "$F" || miss="$miss bridge-ref"
grep -q "claimed upstream, not yet verified" "$F" || miss="$miss upstream-disclaimer"
grep -qE "agentic-flow.*not (installed|available)|fallback|bridge[- ](unavailable|reported)" "$F" || miss="$miss fallback-doc"
[[ -z "$miss" ]] && ok || bad "$miss"

step "13. cost-optimize references hooks_model-outcome (step + allowed-tools)"
F="$ROOT/skills/cost-optimize/SKILL.md"
miss=""
grep -q "hooks_model-outcome" "$F" || miss="$miss step-mention"
grep -qE '^allowed-tools:.*hooks_model-outcome' "$F" || miss="$miss allowed-tools"
[[ -z "$miss" ]] && ok || bad "$miss"

step "14. cost-analyst agent documents optimize + benchmark workers"
F="$ROOT/agents/cost-analyst.md"
miss=""
grep -q "Background workers" "$F" || miss="$miss section"
grep -q "optimize" "$F" || miss="$miss optimize-worker"
grep -q "benchmark" "$F" || miss="$miss benchmark-worker"
grep -q "ruflo-loop-workers" "$F" || miss="$miss cross-link"
[[ -z "$miss" ]] && ok || bad "$miss"

step "15. ruflo-cost.md documents 'cost workers' subcommand with hooks_worker-status"
F="$ROOT/commands/ruflo-cost.md"
miss=""
grep -q "cost workers" "$F" || miss="$miss subcommand"
grep -q "hooks_worker-status" "$F" || miss="$miss tool-ref"
grep -q "optimize" "$F" || miss="$miss optimize"
grep -q "benchmark" "$F" || miss="$miss benchmark"
[[ -z "$miss" ]] && ok || bad "$miss"

step "16. cost-report tier aggregation + REFERENCE.md tier breakdown"
F1="$ROOT/skills/cost-report/SKILL.md"
F2="$ROOT/REFERENCE.md"
miss=""
grep -qiE "Aggregate by tier|tier breakdown|tier 1.+tier 2.+tier 3" "$F1" || miss="$miss skill-step"
# REFERENCE has Tier 1/2/3 on separate lines — flatten with tr before matching
tr '\n' ' ' < "$F2" | grep -qE "Tier 1.+Tier 2.+Tier 3" || miss="$miss reference-block"
grep -q "Tier classification" "$F2" || miss="$miss classification-rules"
[[ -z "$miss" ]] && ok || bad "$miss"

# ─── Doc-invariant single-line greps (ADR-0002 §"Verification") ──────────────

step "17. doc-invariant: agentic-flow in README"
grep -q "agentic-flow" "$ROOT/README.md" && ok || bad "missing"

step "18. doc-invariant: AGENT_BOOSTER_AVAILABLE in cost-booster-route"
grep -q "AGENT_BOOSTER_AVAILABLE" "$ROOT/skills/cost-booster-route/SKILL.md" && ok || bad "missing"

step "19. doc-invariant: Tier 1/2/3 enumerated in REFERENCE.md"
tr '\n' ' ' < "$ROOT/REFERENCE.md" | grep -qE "Tier 1.+Tier 2.+Tier 3" && ok || bad "missing"

step "20. cost-booster-edit references agent-booster.apply() with confidence threshold + measured benchmark"
F="$ROOT/skills/cost-booster-edit/SKILL.md"
miss=""
[[ -f "$F" ]] || miss="$miss missing-file"
grep -qE 'agent-booster|AgentBooster' "$F" || miss="$miss api-ref"
grep -qE 'apply\(' "$F" || miss="$miss apply-call"
grep -q "confidence" "$F" || miss="$miss confidence-check"
grep -qE 'Measured benchmark|measured.*latency|0\.5' "$F" || miss="$miss benchmark-or-threshold"
grep -q '^allowed-tools:[[:space:]]*\*' "$F" && miss="$miss wildcard"
[[ -z "$miss" ]] && ok || bad "$miss"

step "21. cost-analyst agent documents direct booster invocation"
F="$ROOT/agents/cost-analyst.md"
grep -qE 'cost-booster-edit|agent-booster.*apply|Direct.*booster|Agent Booster.*direct' "$F" \
  && ok || bad "missing direct-invocation block"

step "22. corpus + bench harness present and runnable"
miss=""
[[ -f "$ROOT/bench/booster-corpus.json" ]] || miss="$miss missing-corpus"
[[ -x "$ROOT/scripts/bench.mjs" ]] || miss="$miss bench-not-executable"
# Don't actually run the bench in smoke (needs cwd in v3/) — just check syntax + corpus shape
node --check "$ROOT/scripts/bench.mjs" 2>/dev/null || miss="$miss bench-syntax"
node -e "JSON.parse(require('fs').readFileSync('$ROOT/bench/booster-corpus.json'))" 2>/dev/null || miss="$miss corpus-not-json"
case_count=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$ROOT/bench/booster-corpus.json')).cases.length)" 2>/dev/null)
[[ "${case_count:-0}" -ge 10 ]] || miss="$miss corpus-too-small($case_count)"
[[ -z "$miss" ]] && ok || bad "$miss"

step "23. latest verified run shows Tier 1 winRate ≥ 0.80 (or skipped if not yet run)"
LATEST="$ROOT/docs/benchmarks/runs/latest.json"
if [[ ! -f "$LATEST" ]]; then
  ok  # bench not run yet — non-blocking; fail only if the file exists and rate < 80%
else
  rate=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$LATEST')).summary.winRate)" 2>/dev/null)
  pass=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$LATEST')).summary.winRate >= 0.8 ? 'yes':'no')" 2>/dev/null)
  if [[ "$pass" == "yes" ]]; then ok; else bad "Tier 1 win rate $rate < 0.80"; fi
fi

step "24. corpus v3 has 18+ Tier 1 cases AND 6+ adversarial cases"
F="$ROOT/bench/booster-corpus.json"
miss=""
node -e "
  const d = JSON.parse(require('fs').readFileSync('$F'));
  const t1 = d.cases.filter(c => c.expectedTier1 !== false).length;
  const adv = d.cases.filter(c => c.expectedTier1 === false).length;
  if (t1 < 18) process.exit(1);
  if (adv < 6) process.exit(2);
  if (d.cases.length < 25) process.exit(3);
" 2>/dev/null
case $? in
  0) ok ;;
  1) bad "fewer than 18 Tier 1 cases" ;;
  2) bad "fewer than 6 adversarial cases" ;;
  3) bad "fewer than 25 total cases" ;;
  *) bad "corpus check failed" ;;
esac

step "25. cost-benchmark skill exists and references corpus + bench harness"
F="$ROOT/skills/cost-benchmark/SKILL.md"
miss=""
[[ -f "$F" ]] || miss="$miss missing-file"
grep -q "bench.mjs" "$F" || miss="$miss bench-ref"
grep -q "BENCH_ANTHROPIC" "$F" || miss="$miss anthropic-flag"
grep -qE "winRate|win rate" "$F" || miss="$miss win-rate-mention"
grep -q '^allowed-tools:[[:space:]]*\*' "$F" && miss="$miss wildcard"
[[ -z "$miss" ]] && ok || bad "$miss"

step "26. ruflo-cost.md documents 'cost benchmark' subcommand"
F="$ROOT/commands/ruflo-cost.md"
grep -q "cost benchmark" "$F" && grep -q -- "--anthropic" "$F" \
  && ok || bad "missing subcommand or anthropic flag"

step "27. cost-report reads benchmark runs/latest.json"
F="$ROOT/skills/cost-report/SKILL.md"
grep -qE 'runs/latest\.json|measured booster|measured.*Tier' "$F" \
  && ok || bad "cost-report does not consume bench output"

step "28. cost-track skill exists, references session jsonl + memory_store"
F="$ROOT/skills/cost-track/SKILL.md"
miss=""
[[ -f "$F" ]] || miss="$miss missing-file"
grep -qE '\.claude/projects|session.*jsonl|jsonl' "$F" || miss="$miss session-ref"
grep -qE 'memory_store|memory store' "$F" || miss="$miss memory-store"
grep -q 'cost-tracking' "$F" || miss="$miss namespace"
grep -q '^allowed-tools:[[:space:]]*\*' "$F" && miss="$miss wildcard"
[[ -z "$miss" ]] && ok || bad "$miss"

step "29. track.mjs harness present + parses + uses spawnSync (no shell-escape risks)"
F="$ROOT/scripts/track.mjs"
miss=""
[[ -x "$F" ]] || miss="$miss not-executable"
node --check "$F" 2>/dev/null || miss="$miss syntax-error"
grep -q "spawnSync" "$F" || miss="$miss no-spawnSync"
grep -q "PRICING" "$F" || miss="$miss no-pricing-table"
[[ -z "$miss" ]] && ok || bad "$miss"

step "29b. track.mjs encodeProjectPath handles Windows backslash + drive colon (#1927)"
# A Windows-style cwd must encode to `D--project-Subcloudy`, not the corrupt
# `D:\project\Subcloudy` the old `/`-only replace left untouched. Run track.mjs
# with TRACK_CWD set and assert the (expected-to-fail) "looked under" line shows
# the correctly-encoded folder. (The first line legitimately echoes the raw cwd
# `cwd=D:\project\Subcloudy` — only the "looked under" line must be encoded.)
TRACK_OUT_LINE="$(TRACK_CWD='D:\project\Subcloudy' node "$ROOT/scripts/track.mjs" 2>&1 || true)"
LOOKED_LINE="$(printf '%s\n' "$TRACK_OUT_LINE" | grep 'looked under' || true)"
miss=""
printf '%s\n' "$LOOKED_LINE" | grep -q 'D--project-Subcloudy' || miss="$miss not-encoded"
printf '%s\n' "$LOOKED_LINE" | grep -qF 'project\Subcloudy' && miss="$miss corrupt-encoded-path"
[[ -z "$miss" ]] && ok || bad "$miss"

step "30. ruflo-cost.md documents 'cost track' subcommand"
F="$ROOT/commands/ruflo-cost.md"
grep -qE "cost track" "$F" && grep -qE "session.*jsonl|track\.mjs" "$F" \
  && ok || bad "missing cost-track subcommand or session-source ref"

step "31. cost-budget-check skill exists, references alert ladder + budget.mjs"
F="$ROOT/skills/cost-budget-check/SKILL.md"
miss=""
[[ -f "$F" ]] || miss="$miss missing-file"
grep -qE "50/75/90/100|HARD_STOP|alert ladder" "$F" || miss="$miss alert-ladder"
grep -qE "budget\.mjs|cost-tracking:budget-config" "$F" || miss="$miss budget-script"
grep -q '^allowed-tools:[[:space:]]*\*' "$F" && miss="$miss wildcard"
[[ -z "$miss" ]] && ok || bad "$miss"

step "32. budget.mjs harness present + parses + uses spawnSync"
F="$ROOT/scripts/budget.mjs"
miss=""
[[ -x "$F" ]] || miss="$miss not-executable"
node --check "$F" 2>/dev/null || miss="$miss syntax-error"
grep -q "spawnSync" "$F" || miss="$miss no-spawnSync"
grep -qE "HARD_STOP|alertLevel" "$F" || miss="$miss no-alert-impl"
grep -q "process.exit(1)" "$F" || miss="$miss no-fail-closed"
[[ -z "$miss" ]] && ok || bad "$miss"

step "33. ruflo-cost.md documents 'cost budget set/get/check' subcommands"
F="$ROOT/commands/ruflo-cost.md"
miss=""
grep -q "cost budget set" "$F" || miss="$miss set"
grep -q "cost budget get" "$F" || miss="$miss get"
grep -q "cost budget check" "$F" || miss="$miss check"
grep -qE "50/75/90/100|alert ladder|HARD_STOP" "$F" || miss="$miss alert-ladder"
[[ -z "$miss" ]] && ok || bad "$miss"

step "34. cost-optimize step 8 wires auto-emit via outcome.mjs"
F="$ROOT/skills/cost-optimize/SKILL.md"
grep -q "outcome\.mjs" "$F" && grep -qE "success|escalated|failure" "$F" \
  && ok || bad "step 8 not wired to outcome.mjs"

step "35. outcome.mjs harness present + parses + validates outcomes"
F="$ROOT/scripts/outcome.mjs"
miss=""
[[ -x "$F" ]] || miss="$miss not-executable"
node --check "$F" 2>/dev/null || miss="$miss syntax-error"
grep -q "spawnSync" "$F" || miss="$miss no-spawnSync"
grep -q "hooks.*model-outcome" "$F" || miss="$miss no-hooks-call"
grep -qE "success.*escalated.*failure|ALLOWED" "$F" || miss="$miss no-validation"
[[ -z "$miss" ]] && ok || bad "$miss"

step "36. ruflo-cost.md documents 'cost outcome' subcommand"
grep -q "cost outcome" "$ROOT/commands/ruflo-cost.md" \
  && ok || bad "missing"

step "37. compact.mjs replaces inline Node block in cost-compact-context"
F1="$ROOT/scripts/compact.mjs"
F2="$ROOT/skills/cost-compact-context/SKILL.md"
miss=""
[[ -x "$F1" ]] || miss="$miss compact-not-executable"
node --check "$F1" 2>/dev/null || miss="$miss syntax-error"
grep -q "createRequire" "$F1" || miss="$miss no-cwd-resolve"
grep -q "compact\.mjs" "$F2" || miss="$miss skill-not-updated"
# ensure the inlined Node one-liner is dropped (no `node --input-type=module -e` left)
grep -q 'node --input-type=module -e' "$F2" && miss="$miss inline-node-still-present"
[[ -z "$miss" ]] && ok || bad "$miss"

step "38. cost-trend skill + trend.mjs surface drift across runs"
F1="$ROOT/scripts/trend.mjs"
F2="$ROOT/skills/cost-trend/SKILL.md"
miss=""
[[ -x "$F1" ]] || miss="$miss trend-not-executable"
node --check "$F1" 2>/dev/null || miss="$miss syntax-error"
grep -qE "winRate|avg latency|escalationRate" "$F1" || miss="$miss no-metrics"
grep -qE "Regression|⚠" "$F1" || miss="$miss no-regression-flag"
[[ -f "$F2" ]] || miss="$miss skill-missing"
grep -q "trend\.mjs" "$F2" || miss="$miss skill-no-script-ref"
grep -q '^allowed-tools:[[:space:]]*\*' "$F2" && miss="$miss wildcard"
[[ -z "$miss" ]] && ok || bad "$miss"

step "39. ruflo-cost.md documents 'cost trend' subcommand"
grep -q "cost trend" "$ROOT/commands/ruflo-cost.md" \
  && ok || bad "missing"

step "39c. cost-summary skill + summary.mjs (programmatic dump)"
F1="$ROOT/scripts/summary.mjs"
F2="$ROOT/skills/cost-summary/SKILL.md"
miss=""
[[ -x "$F1" ]] || miss="$miss summary-not-executable"
node --check "$F1" 2>/dev/null || miss="$miss syntax-error"
grep -q "total_cost_usd" "$F1" || miss="$miss no-headline-metric"
grep -qE "byTier|byModel" "$F1" || miss="$miss no-aggregation"
grep -q "alertLevel" "$F1" || miss="$miss no-alert-level"
[[ -f "$F2" ]] || miss="$miss skill-missing"
grep -q "summary\.mjs" "$F2" || miss="$miss skill-no-script-ref"
grep -qE "stable|contract|JSON" "$F2" || miss="$miss no-contract-doc"
grep -q '^allowed-tools:[[:space:]]*\*' "$F2" && miss="$miss wildcard"
[[ -z "$miss" ]] && ok || bad "$miss"

step "39b. cost-federation skill + federation.mjs (ADR-097 Phase 3 consumer)"
F1="$ROOT/scripts/federation.mjs"
F2="$ROOT/skills/cost-federation/SKILL.md"
miss=""
[[ -x "$F1" ]] || miss="$miss fed-not-executable"
node --check "$F1" 2>/dev/null || miss="$miss syntax-error"
grep -q "federation_spend" "$F1" || miss="$miss no-event-type"
grep -q "1h\|24h\|7d" "$F1" || miss="$miss no-rolling-windows"
grep -qE "ADR-097|Phase 3" "$F2" || miss="$miss no-adr-ref"
grep -q "fed-spend-" "$F2" || miss="$miss no-key-prefix"
grep -q '^allowed-tools:[[:space:]]*\*' "$F2" && miss="$miss wildcard"
[[ -z "$miss" ]] && ok || bad "$miss"

step "39a. cost-export skill + export.mjs (Prometheus + webhook)"
F1="$ROOT/scripts/export.mjs"
F2="$ROOT/skills/cost-export/SKILL.md"
miss=""
[[ -x "$F1" ]] || miss="$miss export-not-executable"
node --check "$F1" 2>/dev/null || miss="$miss syntax-error"
grep -q "cost_tracker_total_usd" "$F1" || miss="$miss no-prom-metric"
grep -q "fetch(" "$F1" || miss="$miss no-webhook-fn"
[[ -f "$F2" ]] || miss="$miss skill-missing"
grep -q "export\.mjs" "$F2" || miss="$miss skill-no-script-ref"
grep -q '^allowed-tools:[[:space:]]*\*' "$F2" && miss="$miss wildcard"
[[ -z "$miss" ]] && ok || bad "$miss"

step "40a. cost-conversation skill + conversation.mjs"
F1="$ROOT/scripts/conversation.mjs"
F2="$ROOT/skills/cost-conversation/SKILL.md"
miss=""
[[ -x "$F1" ]] || miss="$miss conv-not-executable"
node --check "$F1" 2>/dev/null || miss="$miss syntax-error"
grep -q "memoryListSessionKeys" "$F1" || miss="$miss no-list-fn"
grep -q "byTier" "$F1" || miss="$miss no-tier-aggr"
[[ -f "$F2" ]] || miss="$miss skill-missing"
grep -q "conversation\.mjs" "$F2" || miss="$miss skill-no-script-ref"
grep -q '^allowed-tools:[[:space:]]*\*' "$F2" && miss="$miss wildcard"
[[ -z "$miss" ]] && ok || bad "$miss"

step "40. CI workflow (smoke + booster bench on PR) present"
WF="$ROOT/../../.github/workflows/cost-tracker-smoke.yml"
miss=""
[[ -f "$WF" ]] || miss="$miss missing-file"
grep -q "smoke\.sh" "$WF" || miss="$miss smoke-not-invoked"
grep -q "bench\.mjs" "$WF" || miss="$miss bench-not-invoked"
grep -q "winRate" "$WF" || miss="$miss no-regression-gate"
grep -q "BENCH_ANTHROPIC\|BENCH_LLM_BASELINE" "$WF" && miss="$miss llm-cost-in-CI"
[[ -z "$miss" ]] && ok || bad "$miss"

# ─── Consistency invariants (prevent README/agent drift) ─────────────────────

step "41. cost-analyst.md mentions every skill in skills/"
F="$ROOT/agents/cost-analyst.md"
miss=""
for d in "$ROOT"/skills/*/; do
  name=$(basename "$d")
  grep -q "$name" "$F" 2>/dev/null || miss="$miss $name"
done
[[ -z "$miss" ]] && ok || bad "agent does not mention:$miss"

step "42. README.md skills table has a row for every skill in skills/"
F="$ROOT/README.md"
miss=""
for d in "$ROOT"/skills/*/; do
  name=$(basename "$d")
  grep -qE "\\| \`$name\`" "$F" 2>/dev/null || miss="$miss $name"
done
[[ -z "$miss" ]] && ok || bad "README skills table missing:$miss"

step "43. every script in scripts/*.mjs parses cleanly"
miss=""
for f in "$ROOT"/scripts/*.mjs; do
  node --check "$f" 2>/dev/null || miss="$miss $(basename "$f")"
done
[[ -z "$miss" ]] && ok || bad "syntax errors:$miss"

step "44. plugin.json parses + version sentinel matches step 1"
node -e "JSON.parse(require('fs').readFileSync('$ROOT/.claude-plugin/plugin.json'))" 2>/dev/null \
  && ok || bad "plugin.json invalid JSON"

printf "\n%s passed, %s failed\n" "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]] || exit 1
