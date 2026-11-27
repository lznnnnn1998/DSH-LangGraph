# benchmark harness

A small, one-run-per-cell harness for the report in [`../docs/BENCHMARK.md`](../docs/BENCHMARK.md).
It compares the stock DSH ordinary loop with the plugin's ordinary loop and forced graphs on
two deterministic tasks.

## Prerequisites

- A DSH checkout at `DSH_ROOT` (default `/Users/zhinan/deepseek-harness`).
- The stock `headless` profile (no plugin) and the `lgh` profile with this plugin linked.
- A configured DeepSeek route; the same model for every arm.
- The tasks write under `$DSH_ROOT/.lg-bench/work` so DSH's workspace-write policy allows them.

## Run

```sh
# all six comparable headless cells (official / plain / default × two tasks)
DSH_ROOT=/Users/zhinan/deepseek-harness node bench/run.mjs

# one cell
DSH_ROOT=/Users/zhinan/deepseek-harness node bench/run.mjs fanout official
DSH_ROOT=/Users/zhinan/deepseek-harness node bench/run.mjs report plain

# forced graph cells (the task text asks for a graph)
DSH_ROOT=/Users/zhinan/deepseek-harness node bench/run.mjs fanout coarse
DSH_ROOT=/Users/zhinan/deepseek-harness node bench/run.mjs fanout fine
```

Conditions:

| Condition | Profile | What it does |
|---|---|---|
| `official` | `headless` | stock DSH, ordinary tools, no plugin |
| `plain` | `lgh` | plugin installed, but the task says ordinary tools / no graph |
| `default` | `lgh` | plugin prompt decides; no forced graph |
| `coarse` | `lgh` | task text asks for a coarse graph (agent nodes) |
| `fine` | `lgh` | task text asks for a fine graph (tool/model + map) |

## Metrics

`success` is a deterministic output check (`36` for the fan-out sum; `Beta: Chen` for the
report). `tokens` is the sum of `step_end` usage reported by DSH; it includes input, output
and cache reads, so it is comparable between cells but is not a bill. Graph-internal model
calls may not all appear as DSH `step_end` events; treat the graph arms' token counts as a
lower bound. `seconds` is wall time including model calls.

The 12-topic gate case in the report is Web-only (a headless profile has no answerer); its
numbers come from the real `lgtest` sessions, not this harness.

## Caveats

One run per cell; one model; one host; the forced graph arms were recorded before the
current guide/law and tool-schema validation, and include their failure/recovery costs. The
report is a directional comparison, not a leaderboard.
