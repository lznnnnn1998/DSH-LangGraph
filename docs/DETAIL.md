# LangGraph graphs

Run a LangGraph graph from inside a DSH agent session, and continue it later.

## What it adds

- `langgraph_run` — run a graph by id with an initial state. Omitting `graph` lists
  the registered graphs **with their input schemas**.
- `langgraph_threads` — `list`, `state`, `history`, `edit`, `topology`, and `delete`.
  A checkpoint can be inspected, forked with new values, and replayed; a graph's nodes
  and edges are available as JSON for a client view.
- **Durable threads.** Every superstep is checkpointed in a DSH storage domain
  (`langgraph_checkpoints`), so a thread survives the turn and the Host process. Pass
  `thread` back to continue it; a profile without `storageDomain` falls back to an
  in-process saver and says so.
- **Interrupts.** A node that calls LangGraph's `interrupt(...)` stops the run; the tool
  reports `status: "interrupted"` with the payload, and
  `langgraph_run({ graph, thread, resume: <value> })` resumes exactly there.
- **Long-term memory.** Graphs also get a LangGraph `BaseStore`, durable in the
  `langgraph_store` domain: nodes use LangGraph's own `getStore(config)`, `build(api)`
  sees `api.store`, and `helpers.store()` returns the same instance.
- **Native HITL.** `helpers.askUser(questions)` puts a question in DSH's stock question
  UI and returns the answer to the node; no custom client is involved.
- **Web panel.** A sidebar **LangGraph** panel lists the registry and draws a graph's
  topology; it reads the plugin's owner-only `/api/plugins/langgraph/*` routes.
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

## Model-facing guidance

While the plugin is active it registers a system-prompt section through DSH's public
`ctx.systemPrompt.section` API — no DSH source change. The section defines the vocabulary
(profile-registered graphs, not the `workflow` tool), the trigger policy (a named graph,
a description match, or a graph-specific need such as a durable thread, background job,
interrupt/resume, checkpoint replay, or Trajectory sub-calls), and the registry (up to 24
ids and descriptions; input schemas stay out of the prompt). The model therefore knows
what exists without spending a discovery call; `langgraph_run` with no `graph` still
returns the full list and input schemas.

- The section sits just before the subagent guidance, after the `workflow` tool's
  "only when the user asks" rule. An earlier placement at `TOOL_WORKFLOW` made the two
  "workflow" instructions read as one.
- Apart from the section and the two tool schemas, the plugin injects no runtime context;
  per-session thread facts are read on demand with `langgraph_threads`. See
  [CONTEXT.md](CONTEXT.md) for the mapping and the maintenance rules.

- The registry is scanned when the plugin activates, so graph modules should keep top-level
  code side-effect free.
- The section text is a function: after the asynchronous scan completes, the next prompt
  assembly replaces the short "call it to list" hint with the actual graph list.
- `config.prompt: false` disables the section (and the eager scan).
- The section is effect-owned: unloading the plugin retires the guidance.

## Long-term store

Checkpoints belong to one thread; a store is shared memory. Every run is compiled with a
LangGraph `BaseStore` that survives the turn and the Host process:

```ts
.addNode('remember', async (_state, config) => {
  const store = getStore(config)              // LangGraph's standard accessor
  await store.put(['memories', userId], 'preference', { tone: 'concise' })
  return { preference: (await store.get(['memories', userId], 'preference')).value.tone }
})
```

`build(api)` also receives `api.store`, and `helpers.store()` returns the same instance.
Inside a node, `getStore(config)` is LangGraph's `AsyncBatchedStore` wrapper over that same
`DshStore` (LangGraph batches node writes), so the wrapper is still backed by this domain.

- Backed by the `langgraph_store` storage domain, one record per `(namespace, key)`;
  writes resolve after the domain has accepted them.
- Supports `get`, `put`, `delete`, `search({ filter, limit, offset })`, and
  `listNamespaces({ prefix, suffix, maxDepth, limit, offset })`. Filters cover dotted
  field paths and `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`; search results are newest
  first (then by key).
- Values must be JSON objects. Vector search (`search({ query })`) is rejected with a
  clear error instead of returning unranked rows; use an embeddings-backed store when a
  graph needs similarity.
- Without a `storageDomain` service the plugin uses `InMemoryStore`, so the graph still
  runs and only loses memories at process exit. `config.store: false` passes no store
  (`getStore(config)` returns `undefined` and `helpers.store()` is `undefined`).
- Long-term memory is separate from thread ownership: any run of any session sees the
  same namespaces. Namespace the data yourself (for example by user or workspace) when
  that matters.

## Time travel

Every checkpoint is addressable, so a thread is not a write-only log:

```text
langgraph_threads({ action: 'history', graph, thread })        → checkpoints, newest first
langgraph_threads({ action: 'state', graph, thread, checkpoint }) → values, next, interrupts
langgraph_threads({ action: 'edit', graph, thread, checkpoint, values }) → new checkpoint
langgraph_run({ graph, thread, checkpoint })                    → replay from that snapshot
```

- `history` returns `checkpoint`, `step`, `source`, `createdAt`, `next`, and `paused` for
  each snapshot, newest first; `limit` defaults to 20 (max 200).
- `state` and `edit` default to the thread head. `edit` writes the given `values` on top
  of that snapshot and returns the new checkpoint; `next` tells you what would run.
- `langgraph_run({ checkpoint })` uses `checkpoint_id` instead of the thread head. With no
  `input` or `resume` it runs that snapshot's pending tasks. A checkpoint whose `next` is
  empty has nothing to run, so a replay is a no-op; pick one from `history` that lists
  the node you want to rerun, or edit it first.
- An edit creates a fork: the original checkpoints stay, and the thread head becomes the
  fork when it is replayed. An unknown checkpoint id is rejected rather than treated as
  an empty state.
- History is bounded by `retention` (default 200 checkpoints per thread); older
  checkpoints and their writes are pruned, so a checkpoint that is no longer in `history`
  cannot be replayed.

## Topology

`langgraph_threads({ action: 'topology', graph })` compiles the graph and returns its
drawable structure without needing a thread:

```json
{
  "graph": "scan-report",
  "description": "…",
  "input": { "type": "object", "…": "…" },
  "nodes": [{ "id": "__start__", "type": "schema" }, { "id": "scan", "type": "runnable", "name": "scan" }],
  "edges": [{ "source": "__start__", "target": "scan" }, { "source": "scan", "target": "__end__" }]
}
```

- The response is plain JSON (`Graph.toJSON()`), safe to hand to a client panel; a
  conditional edge carries `conditional: true`.
- Compiling runs `build(api)`, so a graph module's build must stay side-effect free.
- This is the host half of the client view; it works from the model-facing tool and from
  any host code that can call the tool. A dedicated topology panel is a client change
  outside this package's host-only scope.

## Web panel

In a Web profile the package's `dsh.client` entry loads `lib/client.js`, a browser bundle
that contributes a **LangGraph** sidebar row and a `main` panel. The panel shows:

- the registered graphs with their descriptions and per-graph durable-thread counts;
- the selected graph's topology from `Graph.toJSON()` — left-to-right columns, dashed
  conditional edges, start/end nodes.

It reads two exact, owner-only routes registered through the public
`ctx.connection.fetch.register` service:

| route | answer |
|---|---|
| `GET /api/plugins/langgraph/ui` | `{ graphs, threads: { total, byGraph, durable } }` |
| `GET /api/plugins/langgraph/topology?graph=<id>` | the same payload as the `topology` action |

- The routes are optional: a headless Host has no `connection` service, so they are not
  registered. `config.ui: false` disables them in a Web profile too.
- The panel is read-only and polls `/ui` every 5 seconds. It does not read Session logs,
  thread contents, or tokens; run activity stays in Trajectory and `langgraph_threads`.
- The bundle imports only `react` and `react/jsx-runtime`, which the Web shell seeds into
  its module table. Rebuild it with the TypeScript compiler from a DSH checkout:

  ```bash
  DSH_TYPESCRIPT=/path/to/deepseek-harness/node_modules/typescript npm run build:client
  ```

  `lib/client.js` is committed, so installing from npm needs no build step.

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

## Asking the user

A node can ask a question through the same tool the model uses:

```js
const { answers } = await helpers.askUser([
  { id: 'ship', question: 'Ship it?', options: ['Yes', 'No'] },
  { id: 'note', question: 'Anything to add?', header: 'Optional' },
])
const ship = answers.find(answer => answer.id === 'ship')
```

- DSH's stock `ask_user_question` tool renders the question, so the native question card
  (options, free text, skip) is the whole UI. The helper normalizes short strings into
  `{ label }` options and defaults a missing `id` to `q1`, `q2`, ….
- The result is `{ answers: [{ id, selected, custom? }] }`. For a single-select question
  `custom` overrides `selected`; `selected: []` with no `custom` means the user skipped it
  — continue without that answer and do not treat the skip as permission.
- The node waits for the answer. A profile without a question answerer fails with the
  tool's error (`no user-questions answerer accepted the request`), and headless runs may
  wait until the profile's question wait releases the turn.
- DSH rejects human interaction from subagent-origin sessions. Run the graph from a
  top-level session when it needs to ask; a graph started inside a child agent should
  return the question as its result instead.
- The ask is a normal tool call in this session and is traced as
  `langgraph:tool ask_user_question` under the node.

## Writing a graph (TypeScript or JavaScript)

```ts
export const id = 'my-graph'
export const description = 'One line the agent sees when it lists graphs.'
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
object carries the LangGraph namespace, `helpers`, `checkpointer`, and `store`.
Custom LangChain packages, vector stores, LangSmith, and streaming are covered in
[ECOSYSTEM.md](ECOSYSTEM.md).

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
| `prompt` | register the model-facing system-prompt guidance with the graph list (default `true`) |
| `background` | expose `run_in_background` on `langgraph_run` (default `true`; `false` rejects the flag) |
| `subagentProvider` | default provider for `helpers.subagent` (default `spawn`; a per-call `provider` overrides it) |
| `store` | give graphs the long-term `BaseStore` (default `true`; `false` passes none) |
| `retention` | checkpoints kept per thread and namespace (default `200`; `0` keeps every checkpoint) |
| `ui` | serve the owner-only Web panel routes (default `true`; `false` registers none) |

Threads live in the `langgraph_checkpoints` storage domain (tables `checkpoints`,
`writes`, `threads`). `langgraph_threads({ action: 'delete', thread })` reclaims one.
Long-term memories live in `langgraph_store` (table `items`).

## Limits

- Graphs run in the Host process, not in a separate sandbox: a node's blast radius is
  what its DSH tool calls are allowed to do. DSH's `ctx.sandbox` confines shell and
  filesystem execution, not JavaScript, so it is not an isolation boundary for a graph
  module; the trust boundary is the graph author, like any installed plugin.
- Process-isolating a graph would need remote checkpointer, store, model, tool, question,
  subagent, and trace bridges over IPC. Until such a worker exists, the plugin does not
  pretend to offer it.
- Every stored checkpoint is loaded when the domain opens; loading is not lazy. History
  is bounded per thread and namespace by `retention` (default 200), so a completed
  thread cannot grow without bound; `retention: 0` keeps everything. Pruned checkpoints
  cannot be read or replayed, so a graph that time-travels far back needs a larger
  window or `0`. Delete finished threads you no longer need.
- The long-term store has no TTL or eviction: entries remain until the graph deletes
  them. Vector search is not implemented, so `search({ query })` throws.
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
- The system-prompt guidance is global to the profile while the plugin is active. An agent
  whose tool policy hides `langgraph_run` still sees the section; use `config.prompt: false`
  in a profile/preset that should not advertise graphs.
- A subagent child has its own Session and tool scope. Its own tool/model activity is not in
  the parent graph's model context; it may message the parent through tools the profile grants
  (`send_message`), and it remains in the parent's subagent catalog after disposal.
- Seven example graphs ship in `graphs/`: `scan-report` (tool only), `typed-report`
  (TypeScript, tool only), `ask-workspace` (tool plus one model call), `ask-tools`
  (LangGraph's prebuilt ReAct agent over DSH tools and the DSH model), `ask-subagent`
  (caller-delivered DSH child), `ask-user` (native question UI), and `approval-gate`
  (an `interrupt()` that waits for a decision before it scans).
- LangGraph only accepts tools that are LangChain Runnables, so `helpers.tools()` builds
  real `tool()` instances with a zod schema converted from the DSH tool's JSON schema; the
  original JSON schema is what the chat model sends to the provider.
