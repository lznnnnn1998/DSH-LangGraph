# A small DSH benchmark: ordinary loop vs dsh-langgraph graphs

**Date:** 2026-11-27 · **Plugin:** dsh-langgraph 1.5.0 (runtime unchanged in 1.6.1) ·
**DSH:** local `deepseek-harness` checkout · **Model:** DeepSeek-V4.1-Flash · **Host:** one
macOS machine.

This is a directional comparison, not a leaderboard. The question: when does an explicit
graph buy enough at a seam to justify its cost over the stock DSH ordinary loop?

## Setup

The stock **official** arm uses the `headless` profile with no plugin. The **plugin**
arms use the `lgh` profile with this package linked. Both use the same model, workspace
policy, and task text. The headless tasks have no human gate, so they can run unattended.

Two deterministic tasks:

| Task | Input | Output check |
|---|---|---|
| `fanout` | 8 files, each `Score: N` | exactly `36` |
| `report` | 3 project files with a service count | exactly `Beta: Chen` |

The task text for `plain` explicitly asks for ordinary DSH tools and forbids the graph
tools. `default` leaves the choice to the plugin's prompt. `coarse` and `fine` force a
graph in the task text. One run per cell. The harness is in
[`bench/run.mjs`](../bench/run.mjs); the commands are in [`bench/README.md`](../bench/README.md).

`tokens` is the sum of DSH `step_end` usage (input + output + cache reads). It is
comparable between cells but is not a bill. Graph-internal model calls may not all appear
as `step_end`; treat the graph arms as a lower bound.

## Headless results

`time / reported tokens / steps`; every cell produced the expected file.

| Task | Official DSH (headless) | Plugin `plain` | Plugin `default` | Forced coarse | Forced fine |
|---|---:|---:|---:|---:|---:|
| `fanout` (8 files, sum) | 16s / 72.5K / 5 | 9s / 65.2K / 4 | 9s / 64.0K / 4 | 45s / 264.9K / 12 | 60s / 393.4K / 15 |
| `report` (3 files, pick) | 7s / 41.1K / 3 | 9s / 63.3K / 4 | 10s / 79.7K / 5 | 30s / 124.2K / 6 | 39s / 229.0K / 10 |

The six ordinary-loop cells come from one `bench/run.mjs` run
([results](../bench/results-harness.json)); the forced-graph columns are the earlier
1.5.0 matrix, because that run deliberately forced coarse/fine graphs. A second official
run measured 12s / 73.9K / 5 and 7s / 41.2K / 3; a second plain run measured 7s / 81.1K
and 9s / 46.9K. The variance at this size is large.

At n=1 there is **no consistent winner** between the official loop and the plugin's
ordinary loop: they sit in the same roughly 40–80K reported-token band, and the faster
arm changes between tasks. The plugin's system prompt and three tools do not impose a
reliable tax; the extra tokens are within run-to-run noise. The default plugin prompt did
**not** compose on either small task — it stayed with the ordinary loop. That is the
intended conservative behavior.

The forced graphs cost roughly **3–5×** the ordinary loop in tokens. The coarse graph is
agent-heavy; the fine graph has more tool/model rows. Both forced arms are the earlier
1.5.0 runs; they first hit a strict `bool` / `No files found` failure and recovered
through fork or re-compose, so their time/token totals include that recovery. The current
guide/law, `file_path` correction and compose-time tool-argument validation remove two of
those first-failure classes; the numbers are still a useful upper bound on the cost of
forcing a graph at a small seam.

## The 12-topic Web case

The larger case is Web-only because it has a human gate; a headless profile has no
answerer. It is the same 12-topic brief used by the gallery and the demo video:

| Approach | Wall | Steps | Tokens | Result |
|---|---:|---:|---:|---|
| Ordinary loop + native question | 53s | 7 | 124K | correct 12-row brief |
| Coarse agent graph + gate | 1m38s | 17 | 462K | correct after a manual heading fix |
| Fine map graph + gate | 55s | 9 | 226K | correct 12 rows; gate/resume |

The fine graph is two 12-item maps (read + extract), an outline model, a human gate, a
compose model and a write. It is slower than the ordinary loop by ~2s, uses ~1.8× the
reported tokens, and is about **half** the coarse agent graph. The coarse graph's write
node dropped headings and needed a manual fix; the fine graph wrote the approved outline
faithfully.

## What this says

- **Do not reach for a graph on a one- or two-step task.** The ordinary loop — official
  or plugin — is the baseline; at these sizes the two are within noise.
- **A graph is a seam tax.** At 8 files and 3 files the tax does not pay. The 12-topic
  map/extract case is the first shape where the explicit fan-out, the human signature and
  the durable thread start to earn their overhead; even there, the loop is cheaper in
  tokens.
- **Fine is not automatically worse than coarse.** For a genuine per-item fan-out, a
  map of the same role (fine) was about half the cost of four open-ended agent phases
  (coarse), and produced a more faithful file. The earlier "fine is harmful" result was
  the manual and validation, not the shape.
- **The only robust signal is the graph tax.** Small ordinary-loop differences move with
  the run; the 3–5× graph cost and the 12-topic fine/coarse gap do not.
- **The honest default is the product.** The plugin's system prompt says "compose only
  at seams"; the benchmark shows why.

## Threats to validity

One run per cell, one model, one host, two small headless tasks plus one Web case. The
official and plugin profiles differ in system prompt/tool surface by construction; that is
the intervention. Small-task variance is large: a repeated ordinary-loop cell moved by
15–50K tokens and several seconds. The forced graph arms include recovery from the earlier
1.5.0 manual. Token accounting includes cache reads and may undercount graph-internal
model calls. The 12-topic case is a single Web session. Treat the table as a decision aid,
not a statistical claim.

## Reproduce

```sh
DSH_ROOT=/Users/zhinan/deepseek-harness node bench/run.mjs
DSH_ROOT=/Users/zhinan/deepseek-harness node bench/run.mjs fanout official
DSH_ROOT=/Users/zhinan/deepseek-harness node bench/run.mjs fanout coarse
```

The 12-topic case is the `research-brief` gallery graph, run in the `lgtest` Web profile;
[the demo video](../media/dsh-langgraph-demo.webm) is a recording of that completed
session. The gallery page is [`gallery/index.html`](../gallery/index.html).
