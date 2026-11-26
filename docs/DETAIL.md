# LangGraph workflows

Run a LangGraph graph from inside a DSH agent session, and continue it later.

## What it adds

- `langgraph_run` — run a graph by id with an initial state. Omitting `graph` lists
  the registered graphs **with their input schemas**.
- `langgraph_threads` — `list`, `state`, and `delete` durable threads.
- **Durable threads.** Every superstep is checkpointed in a DSH storage domain
  (`langgraph_checkpoints`), so a thread survives the turn and the Host process. Pass
  `thread` back to continue it; a profile without `storageDomain` falls back to an
  in-process saver and says so.
- **Interrupts.** A node that calls LangGraph's `interrupt(...)` stops the run; the tool
  reports `status: "interrupted"` with the payload, and
  `langgraph_run({ graph, thread, resume: <value> })` resumes exactly there.
- **Background runs.** `run_in_background: true` registers the run on `ctx.jobs` and returns
  `{ kind: "background", jobId, thread }` immediately. The model reads progress and the final
  value with `job_output`, and stops it with `job_kill`; the graph keeps its thread and its
  Trajectory sub-calls.
- **Subagent delegation.** `helpers.subagent(prompt, options)` starts a caller-delivered DSH
  child through `ctx.subagents`, awaits its result, and disposes that exact activation. The
  child has its own Session and tool scope; the graph receives text/structured output.
- A graph registry read from this package's `graphs/*.js` and from `config.graphs`
  (`[{ "id": "...", "module": "..." }]`).
- A bridge for nodes: `helpers.callTool(name, args)` runs a real DSH tool in the calling
  agent's scope — same sandbox, same approvals. The call is recorded as a log-only trace
  sub-call (see [Trajectory trace](#trajectory-trace)), not as a model-visible
  `tool/call`; only the enclosing `langgraph_run` call enters model history.
- A model bridge for nodes: `helpers.callModel(prompt, { system, provider, model, temperature, maxTokens })`
  returns `{ text, usage }` from this deployment's model (default route: the profile's
  selected model, overridable per call or with `config.model`).
- LangChain bridges: `helpers.chatModel()` is a `BaseChatModel` over that same route
  (supports `bindTools`), `helpers.tools([...names])` wraps DSH tools as LangChain tools,
  and `helpers.createReactAgent({...})` is LangGraph's prebuilt ReAct agent wired to both.
  `helpers.messages` re-exports the LangChain message classes.

## Trajectory trace

A run is not a black box. The `langgraph_run` row in **Trajectory** expands into the
graph's own activity:

```
langgraph_run
└─ langgraph:node scan
   └─ langgraph:tool glob          args: {"pattern":"**/*.js"}
└─ langgraph:node large
```

Nested LangGraph agents add their own level:

```
langgraph_run
└─ langgraph:node react
   └─ langgraph:node agent
      └─ langgraph:model           messages + model output + usage
   └─ langgraph:node tools
      └─ langgraph:tool read       args + result
```

How it works, without changing either project:

- **Source:** LangGraph's public callback surface (`on_chain_*`, `on_tool_*`,
  `on_chat_model_*`, `on_llm_*`) is attached to the run's `invoke` config. Node boundaries
  come from `metadata.langgraph_node` plus the `graph:step:*` tag; inner runnables inherit
  their node's trace.
- **Sink:** DSH's log-only `tool/ptc-dispatch-start` / `tool/ptc-dispatch` session events.
  They are the stock Trajectory view's nested sub-call vocabulary; `deriveMessages()`
  ignores them, so traces never enter model context.
- **Manual bridges:** `helpers.callTool` and `helpers.callModel` emit the same two events
  directly. `helpers.tools()` lets LangGraph's prebuilt ToolNode call DSH tools; the
  helper knows the real tool name where the ToolNode callback only exposes a wrapper.
- Traces are best-effort: a rejected append disables tracing for that run and never fails
  the graph. Node/tool/model payloads are clipped at 4,000 characters. A direct helper
  call inside a fan-out graph attaches to the most recently started node; LangChain
  callbacks keep exact nesting for prebuilt agents.

## Background runs

Set `run_in_background: true` on `langgraph_run`. The call returns before the graph starts:

```json
{ "kind": "background", "jobId": "langgraph-…", "graph": "typed-report", "thread": "lg_typed-report_…", "status": "started" }
```

- The job is owned by the calling session; `job_kill` aborts the graph's `AbortController`,
  which reaches `compiled.invoke`, node tool calls, and model calls.
- `job_output` returns the job's progress ring followed by the final run envelope. Progress
  lines are `▶ langgraph:node scan`, `✓ langgraph:tool glob`, and so on.
- The returned `thread` is meaningful for a graph compiled with a checkpointer; a graph
  that returns its own compiled graph without one fails the job and the thread is unused.
  An interrupted background run reports `detail: "interrupted"` and can be resumed with the
  returned `thread`.
- Trajectory still nests the node/tool/model sub-calls under the `langgraph_run` row, even
  though those log-only events arrive after the tool result.
- Background runs require `ctx.jobs` (`@deepseek-ai/dsh-jobs-local` plus
  `@deepseek-ai/dsh-tool-jobs` in the shipped profiles). Without them the call returns an
  error naming the missing pieces.

## Subagent delegation

A node can delegate one task to a DSH child agent:

```ts
const result = await helpers.subagent('Read README.md and summarize it.', {
  label: 'readme summary',
  // provider: 'spawn',          // default; row config `subagentProvider` overrides
  // schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
})
return { summary: result.text, stopReason: result.stopReason }
```

- `delivery: 'caller'` means no parent completion notice; the helper awaits and disposes the
  activation. The child's final output is in `result.text` / `result.output`, with
  `result.structured` when `schema` was supplied.
- The child is a real DSH agent with its own Session, tools, sandbox and model route. Its own
  activity is visible in the child Session's Trajectory, not in the parent graph's model context.
- Trajectory shows the delegation as `langgraph:subagent` under the enclosing node, with
  provider, label, prompt, output and stop reason.
- A graph node cannot start a nested LangGraph run; delegate that work to a subagent or another
  top-level `langgraph_run` call instead.
- Requires `ctx.subagents` plus a registered provider. The default is `spawn`; set
  `config.subagentProvider` or pass `provider` per call. A local child stays in the parent's
  subagent catalog after disposal and can be continued with the usual subagent tools.
- **Shared tree, not a second registry.** The graph is not a subagent level: a
  `helpers.subagent` child is a child of the DSH agent that called `langgraph_run`. It therefore
  shares the parent's subagent tree, `maxActiveSubagents` capacity, child-name namespace, and
  the profile's `maxDepth` policy with the model-facing `subagent` tool. At capacity it fails
  with `ACTIVATION_LIMIT_REACHED`; at the depth limit it fails with `DEPTH_EXCEEDED`. Cancelling
  the graph disposes the child through the activation signal.
- If a graph exposes the stock `subagent` tool through `helpers.tools(['subagent'])`, the model
  inside LangGraph can call it. That is the stock tool path (`delivery: 'parent'`): the node
  does not wait for the child, and the parent later receives a completion notice. Use
  `helpers.subagent` when the graph needs the child's result to continue.

## Writing a graph (TypeScript or JavaScript)

```ts
export const id = 'my-workflow'
export const description = 'One line the agent sees when it lists workflows.'
export const input = {
  type: 'object',
  properties: { pattern: { type: 'string', description: 'Glob to scan.' } },
  additionalProperties: false,
}

export function build({ StateGraph, Annotation, START, END, helpers }) {
  const State = Annotation.Root({
    pattern: Annotation({ reducer: (_, b) => b, default: () => '**/*.md' }),
    files: Annotation({ reducer: (_, b) => b, default: () => '' }),
  })
  // Return the uncompiled StateGraph: the plugin compiles it with the durable
  // checkpointer. Returning a graph you compiled yourself opts out of durability.
  return new StateGraph(State)
    .addNode('scan', async state => ({ files: await helpers.callTool('glob', { pattern: state.pattern }) }))
    .addEdge(START, 'scan')
    .addEdge('scan', END)
}
```

`build(api)` returns a `StateGraph` (preferred) or an already-compiled graph. The API
object carries the LangGraph namespace, `helpers`, and `checkpointer`.

On Node 24.22+ a `graphs/*.ts` module loads directly (Node's type stripping), so a typed
graph needs no build step. Keep to erasable syntax: no `enum`, `namespace`, parameter
properties, or decorators. The package exports `GraphApi` and `GraphModule` types; a
typed module can use `import type` and `defineGraph(module)` without importing the plugin
at runtime. Build with the `StateGraph`/`Annotation` from `api` rather than importing a
second copy of `@langchain/langgraph`; the plugin compiles the graph with its own
checkpointer and LangGraph instance. A `.js` graph remains the portable option for older
Node releases.

An interrupt gate:

```ts
.addNode('gate', async () => ({ approved: interrupt({ question: 'Ship it?' }) }))
```

## Configuration

| key | meaning |
|---|---|
| `graphs` | extra `{ id, module }` entries; `module` is relative to the package or absolute |
| `recursionLimit` | default LangGraph superstep bound per run (default 25) |
| `model` | `{ provider, model, reasoningEffort }` used by `helpers.callModel`; defaults to the profile's selection |
| `trace` | log node/tool/model activity as Trajectory sub-calls (default `true`; `false` disables it) |
| `background` | expose `run_in_background` on `langgraph_run` (default `true`; `false` rejects the flag) |
| `subagentProvider` | default provider for `helpers.subagent` (default `spawn`; a per-call `provider` overrides it) |

Threads live in the `langgraph_checkpoints` storage domain (tables `checkpoints`,
`writes`, `threads`). `langgraph_threads({ action: 'delete', thread })` reclaims one.

## Limits

- Graphs run in the Host process, not in a separate sandbox: a node's blast radius is
  what its DSH tool calls are allowed to do.
- Every checkpoint of every thread is loaded when the domain opens; there is no
  retention policy yet, so delete finished threads you no longer need.
- `langgraph_threads` lists the calling session's threads by default; `all: true` lists
  every session's.
- What a graph inherits from the agent: **tools**, resolved in the calling agent's scope,
  but only those the graph names — `helpers.tools([...])` reads
  `ctx.tools.definitions(agent)` and throws with the visible names when one is missing,
  and `helpers.callTool` runs through the same executor. **Not inherited**: the session's
  system prompt, and with it the skill catalog, the runtime context (cwd, date), and
  AGENTS.md instructions. `helpers.chatModel()` therefore starts with no bound tools, and
  a model call does not know the working directory — either pass `{ system }`, bind tools
  explicitly, or let a DSH tool resolve a path in the session's cwd. To read a skill, call
  the `skill` tool through `helpers.callTool` and pass its text to `helpers.callModel`,
  or enumerate skills with `ctx.get('sessionSkillCatalog').list({ sessionId })`.
- A forked session inherits the session log, not the plugin's storage domain: threads do
  not follow a fork.
- A run's internal work is trace-only, not model-visible. The outer `langgraph_run` call
  is the model-facing `tool/call`/`tool/result` pair; node, tool, and model activity is
  recorded as log-only `tool/ptc-dispatch-start` / `tool/ptc-dispatch` events and appears
  in Trajectory, but `deriveMessages()` ignores it, so it never enters model context.
  `helpers.callTool` still executes in the calling agent's scope (sandbox and approval
  policy apply), and `helpers.callModel` uses the deployment route.
- A thread is owned by the graph and session that created it. Another session cannot
  resume, read, or delete it; `langgraph_threads` lists only this session's threads by
  default, and `all: true` is required for a cross-session listing.
- A node cannot start a nested LangGraph run; use `helpers.subagent` for a DSH child agent,
  or call another top-level `langgraph_run`. `helpers.callModel` is text-only (no tool
  calling inside that model request).
- A background run's trace events arrive after its `tool/result`; they are still log-only and
  stay under the same Trajectory row while the session is live. If append fails — for example
  a profile without the PTC event vocabulary — tracing disables for that run and the job's
  output ring remains the progress record.
- A subagent child has its own Session and tool scope. Its own tool/model activity is not in
  the parent graph's model context; it may message the parent through tools the profile grants
  (`send_message`), and it remains in the parent's subagent catalog after disposal.
- Six example graphs ship in `graphs/`: `scan-report` (tool only), `typed-report`
  (TypeScript, tool only), `ask-workspace` (tool plus one model call), `ask-tools`
  (LangGraph's prebuilt ReAct agent over DSH tools and the DSH model), `ask-subagent`
  (caller-delivered DSH child), and `approval-gate` (an `interrupt()` that waits for a
  decision before it scans).
- LangGraph only accepts tools that are LangChain Runnables, so `helpers.tools()` builds
  real `tool()` instances with a zod schema converted from the DSH tool's JSON schema; the
  original JSON schema is what the chat model sends to the provider.
