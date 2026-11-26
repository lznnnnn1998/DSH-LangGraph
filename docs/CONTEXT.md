# Context and prompt design

This plugin adds one vocabulary and two tools to a DSH profile. This page records
exactly what it injects, what it deliberately does not inject, and how that layer stays
distinct from DSH's own prompt and tools.

## What is injected

| Layer | Contribution | Lifetime |
|---|---|---|
| Tool schemas | `langgraph_run`, `langgraph_threads` | While the plugin is loaded; `config.prompt: false` does not remove them. |
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
| **graph** | A module registered with the profile (`id`, `description`, `input`, `build`). | The `workflow` tool's ad-hoc JavaScript script. |
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

The tool description covers mechanics (arguments, thread/resume/checkpoint, background
job), not selection; the section covers selection, not mechanics. This split is the main
rule for future edits.

## Boundaries with DSH's own context

| DSH facility | Boundary |
|---|---|
| `workflow` tool | `workflow` writes an ad-hoc JavaScript fan-out script; `langgraph_run` runs a profile-registered, named graph with a durable thread. The section sits **after** the workflow tool's "only when the user asks" rule and **before** subagent guidance (`TOOL_SUBAGENT - 10`), so that rule cannot read as part of this section. |
| `subagent` | One-off delegation stays `subagent`; a graph may delegate internally, and `helpers.subagent` creates a normal DSH child. |
| `ask_user_question` | The native question tool is the default for one question; the `ask-user` graph only adds value when a graph or thread is wanted. |
| `job_output` / `job_kill` | A background graph run is a DSH job; use the stock job tools. |
| DSH Session | A LangGraph thread is not a Session; the prompt and tool schema say so explicitly. |
| Trajectory | Graph activity appears as nested log-only sub-calls; it is not injected into model context. |
| Goals, schedules | Out of scope; the plugin does not create either. |

## Placement

- Order: `ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') - 10`, fallback `2790`.
  The earlier `TOOL_WORKFLOW` (2600) placement put the section between two copies of the
  workflow tool's "ONLY when..." guidance and made the two "workflow" instructions read
  as one.
- The section is global to the profile while the plugin is active, including agents whose
  tool policy hides `langgraph_run`; `config.prompt: false` is the escape hatch.
- Registry entries are sorted by id; broken modules are skipped from the list.

## Maintenance checklist

When changing this layer:

1. Keep the words **graph**, **thread**, **checkpoint**, and **DSH job** consistent in the
   prompt, tool descriptions, error messages, UI, and docs.
2. Do not use "workflow" as a synonym for a graph; it belongs only in the explicit
   distinction from the `workflow` tool.
3. Add a trigger only if it is a property the plugin actually provides; do not advertise
   long-term memory unless a graph uses the store.
4. Keep the section about selection and the tool descriptions about mechanics.
5. Keep graph descriptions one line, unique, and specific about the graph's value; avoid
   demo overlap.
6. Re-check section order when a DSH release adds or renames prompt sections.
