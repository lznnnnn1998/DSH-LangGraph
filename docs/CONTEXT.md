# Context and prompt design

This plugin adds one vocabulary and three tools to a DSH profile. This page records
exactly what it injects, what it deliberately does not inject, and how that layer stays
distinct from DSH's own prompt and tools.

## What is injected

| Layer | Contribution | Lifetime |
|---|---|---|
| Tool schemas | `langgraph_run`, `langgraph_threads`, `langgraph_compose` | While the plugin is loaded; `config.prompt: false` does not remove them. |
| System-prompt section | `tool:langgraph`, order `TOOL_SUBAGENT - 10` | Effect-owned by the plugin; `config.prompt: false` disables it. |
| Runtime context | **none** | — |
| Session events | none from the model's point of view | Traces are log-only DSH PTC events for Trajectory. |

The section is a text function, so the model sees a short "call it to list" hint until
the asynchronous registry scan finishes, then the graph list (up to 24 ids and one-line
descriptions; input schemas stay out of the prompt). `langgraph_run` with no `graph`
always returns the full list and schemas.

### Why no runtime context

`ctx.systemPrompt.context` materializes durable user-role snapshots. The plugin does not
use it because:

- The graph catalog is a profile-level fact, not a per-turn fact; a section is the right
  layer and can be cached.
- The only genuinely dynamic facts are the calling session's threads and checkpoints.
  Those are read on demand with `langgraph_threads`; injecting them every turn would
  duplicate state, grow tokens, and go stale.
- `AssembleContext` carries no session identity, so a context contribution could not be
  scoped to the calling session without a new DSH seam. The plugin does not invent one.

## Vocabulary

| Term | Meaning in this plugin | Not |
|---|---|---|
| **graph** | A module registered with the profile (`id`, `description`, `input`, `build`), or a session-owned composed spec; both run with `langgraph_run`. | The `workflow` tool's ad-hoc JavaScript script. |
| **composed graph** | An immutable `GraphSpec` stored in `langgraph_specs`, compiled by the plugin, with an id `lg_adhoc_<hash>`. | A `graphs/*.js` module, a file, or a DSH Session. |
| **spec** | One stored IR record; editing means composing a new spec. | A mutable document or a running graph. |
| **graph run** | One execution with an input, returning a state. | A DSH turn or Session. |
| **thread** | A durable LangGraph checkpoint chain for one graph run, owned by the session and graph that created it. | A DSH Session. |
| **checkpoint** | One snapshot in a thread; `history`, `edit`, and replay address it by id. | A DSH session checkpoint. |
| **background run** | A graph run started as a DSH job; read with `job_output`, stop with `job_kill`. | A detached process. |
| **Trajectory record** | The log-only `langgraph:node` / `langgraph:tool` / `langgraph:model` sub-calls under the `langgraph_run` row. | Model-visible conversation content. |
| **store** | An optional graph-owned `BaseStore`; not a model-facing facility by itself. | A reason to call `langgraph_run`. |

## Trigger policy

The section states one policy, in the same words the model sees:

1. **Name** — the user names one of the registered graph ids.
2. **Match** — a graph's description matches the **requested output**, not merely the
   same files or tools. `scan-report` matches “is this a lot?”; an exact file count is a
   glob/bash task, so the graph is not a match even though it also counts.
3. **Property** — the task needs a durable thread, a background run (DSH job),
   checkpoint history or replay, a Trajectory sub-call record, or a graph that interrupts.

It also says what *not* to do: when no graph's output matches, use ordinary DSH tools;
do not wrap a single tool call in a graph for ceremony, and do not reimplement a matching
graph with `bash`, `subagent`, or ad-hoc steps. This keeps graph
use from becoming ceremony while still letting a matching graph win over a hand-rolled
sequence.

`langgraph_compose` is for work with seams that should not be re-decided every turn:
cross-turn persistence, parallel fan-out with aggregation, a human decision, or a retry
boundary. The section states that principle and the hard boundaries; the numeric
coarse-first thresholds and node-kind heuristics live in the advisory lint and the
on-demand `describe`, not in the always-on prompt.

The tool description covers mechanics (arguments, thread/resume/checkpoint, background
job), not selection; the section covers selection, not mechanics. This split is the main
rule for future edits.

## Leaving the shape open

The prompt does not prescribe a decision tree or concrete examples. It states the
boundaries and the available moves:

- a graph that is already registered and whose output matches → `langgraph_run`;
- a one-off task, or a task whose shape is still unclear → ordinary DSH tools;
- an ad-hoc fan-out whose shape is generated for this run → `workflow`;
- a shape worth a durable, inspectable graph → `langgraph_compose` with a JSON spec;
- a shape worth reusing across sessions → a profile graph module (authored outside this tool).

`langgraph_run` cannot define a graph; the model is told not to invent an id. A composed
spec is not a file and not a DSH Session, and it is immutable: changing it means composing
a new one. The prompt does not prescribe a node count or a node-kind checklist: it gives
the seam principle and the escape valve (`agent` for open work), and `describe` is the
manual. The only concrete list in the prompt is the registry itself — data the model must
select from, not an example to copy. This is deliberate: the model should choose or
compose the shape, not imitate a canned one.

## Boundaries with DSH's own context

| DSH facility | Boundary |
|---|---|
| `workflow` tool | `workflow` writes an ad-hoc JavaScript fan-out script; `langgraph_run` runs a named graph (registered or composed) with a durable thread. The section sits **after** the workflow tool's "only when the user asks" rule and **before** subagent guidance (`TOOL_SUBAGENT - 10`), so that rule cannot read as part of this section. |
| `subagent` | One-off delegation stays `subagent`; a graph may use an `agent` node for open work in this session or a `subagent` node for a child Session. |
| `ask_user_question` | The native question tool is the default for one question; a `gate` node is for a decision inside a durable graph. |
| `job_output` / `job_kill` | A background graph run is a DSH job; use the stock job tools. |
| DSH Session | A LangGraph thread is not a Session; a composed spec is not a Session either. The prompt and tool schemas say so explicitly. |
| Trajectory | Graph activity appears as nested log-only sub-calls; it is not injected into model context. |
| Goals, schedules | Out of scope; the plugin does not create either. |

## Placement

- Order: `ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') - 10`, fallback `2790`.
  The earlier `TOOL_WORKFLOW` (2600) placement put the section between two copies of the
  workflow tool's "ONLY when..." guidance and made the two "workflow" instructions read
  as one.
- The section is global to the profile while the plugin is active, including agents whose
  tool policy hides the graph tools; `config.prompt: false` is the escape hatch.
- Registry entries are sorted by id; broken modules are skipped from the list.

## Maintenance checklist

When changing this layer:

1. Keep the words **graph**, **composed graph**, **spec**, **thread**, **checkpoint**, and
   **DSH job** consistent in the prompt, tool descriptions, error messages, UI, and docs.
2. Do not use "workflow" as a synonym for a graph; it belongs only in the explicit
   distinction from the `workflow` tool.
3. Add a trigger only if it is a property the plugin actually provides; do not advertise
   long-term memory unless a graph uses the store.
4. Keep the section about selection and the tool descriptions about mechanics. Compose
   mechanics live in `langgraph_compose` and its on-demand `describe`, not in the prompt.
5. Keep the prompt principle-based: seams, coarse graph, open work in `agent`. Keep
   numeric thresholds and node-kind heuristics in the advisory lint and `describe`, not
   in the always-on section.
6. Keep graph descriptions one line, unique, and specific about the graph's value; avoid
   demo overlap.
7. Re-check section order when a DSH release adds or renames prompt sections.
