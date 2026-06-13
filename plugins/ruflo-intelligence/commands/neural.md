---
name: neural
description: Neural pattern training, prediction, compression, and pipeline optimization
---

Neural system commands — dispatch by subcommand parsed from the user's input:

1. **train** — `mcp__claude-flow__neural_train` with `--pattern-type` (`coordination|edit|task`) and `--epochs N`.
2. **status** — `mcp__claude-flow__neural_status` (SONA + MoE state, active patterns, training in flight).
3. **patterns** — `mcp__claude-flow__neural_patterns` to list learned patterns; supports `--list` and `--filter`.
4. **predict** — `mcp__claude-flow__neural_predict` with `--input "<task description>"` to get a predicted outcome.
5. **optimize** — `mcp__claude-flow__neural_optimize` to retune the pipeline based on recent outcomes.
6. **compress** — `mcp__claude-flow__neural_compress` to compact stored patterns (storage efficiency, runs after consolidation).

Present results clearly. For `train`, surface the loss curve summary; for `predict`, show the predicted agent + confidence; for `optimize`/`compress`, show before/after counts.
