# dsh-langgraph

A DSH bundle that registers LangGraph graphs, composes session-owned ones at runtime, and
exposes them to the agent as the `langgraph_run`, `langgraph_threads`, and
`langgraph_compose` tools. Graph nodes call the session's own DSH tools through
`helpers.callTool`; threads are checkpointed in a DSH storage domain, so a run survives
the turn — and the Host process — and an `interrupt()`ed graph resumes where it stopped.

- `langgraph_run` (`graph`, `input`, `thread`, `resume`, `maxSteps`, `run_in_background`;
  omit `graph` to list). A background run returns a DSH job id; read it with `job_output`
  and stop it with `job_kill`.
- `langgraph_threads` (`action`: `list` | `state` | `history` | `edit` | `topology` | `delete`).
  `history` lists checkpoints, `state` reads one by `checkpoint`, and `edit` forks a
  checkpoint with new values. Replay the fork with `langgraph_run({ graph, thread, checkpoint })`.
  `topology` returns a graph's JSON-safe nodes and edges for a client view.
- `langgraph_compose` (`action`: `describe` | `validate` | `compose` | `list` | `get` | `delete` | `fork`).
  A composed graph is a strict JSON `GraphSpec` stored as an immutable, session-owned
  spec (`lg_adhoc_...`); `langgraph_run` runs it with the same threads, interrupts,
  background jobs, traces, and time travel. `fork` returns an editable downstream spec
  after a failure. See [docs/COMPOSE.md](docs/COMPOSE.md).
- Registry: `graphs/*.js` (and `graphs/*.ts` on Node 24.22+) in this package plus `config.graphs`.
  Composed specs are a separate, session-owned source and do not enter the profile registry.
- Node helpers: `helpers.callTool(name, args)` for DSH tools, `helpers.askUser(questions)`
  for a question in DSH's native question UI, `helpers.subagent(prompt, options)` for a
  caller-delivered DSH child agent, `helpers.callModel(prompt, options)` for this
  deployment's model, and `helpers.chatModel()` / `helpers.tools([...])` /
  `helpers.createReactAgent({...})` when you want LangGraph's prebuilt agent to drive DSH
  tools with the DSH model. Node-level calls keep the agent's sandbox and approval scope.
- **Long-term memory:** graphs get a real LangGraph `BaseStore` over the
  `langgraph_store` storage domain. A node reads it with LangGraph's own
  `getStore(config)`, `build(api)` sees `api.store`, and a helper is available as
  `helpers.store()`. It supports get/put/delete, filtered pagination, and namespace
  listing; vector `query` search is rejected rather than faked. Without a storage domain
  it falls back to `InMemoryStore`; `config.store: false` passes no store at all.
- **Model-facing guidance:** while loaded, a system-prompt section lists the registered
  graph ids and descriptions, distinguishes `langgraph_run` from the `workflow` tool, and
  tells the model to use a matching graph rather than reimplement it. It also teaches
  when to compose, the coarse-first default (4–8 phase nodes; `agent` for open work,
  `model` for one judgment, `gate` for a human decision, `tool` for a known atomic
  action), and how to recover from a failed run. `config.prompt: false` disables it.
- **Trajectory trace:** each run shows up as one `langgraph_run` row; its graph nodes, DSH
  tool calls, and model calls appear as nested sub-calls in **Trajectory** — `langgraph:node`,
  `langgraph:tool`, `langgraph:model`, `langgraph:subagent`. The trace uses DSH's log-only
  `tool/ptc-dispatch-start` / `tool/ptc-dispatch` events, so it never enters the model's
  context. Neither DSH nor LangGraph source is modified: LangGraph's own callbacks are the
  source, and DSH's existing session-event vocabulary is the sink. Background runs keep the
  same trace under their `langgraph_run` row even though the events arrive after the tool result.
- Threads are owned by the session and graph that created them; another session cannot
  resume or delete them. Each thread keeps at most `retention` checkpoints (default 200;
  `0` keeps every checkpoint), with their writes pruned alongside.
- **Web panel:** in a Web profile the plugin contributes a **LangGraph** sidebar panel that
  lists the registered graphs, their thread counts, and the selected graph's topology
  (nodes, edges, conditional branches). It reads two owner-only `/api/plugins/langgraph/*`
  routes; `config.ui: false` registers neither. Token-level streaming is not part of this
  panel; runs stay visible in Trajectory.
- See `docs/COMPOSE.md` for the JSON IR, the compose tool, map/fan-out semantics,
  structured failures, recovery, fork, and limits.
- See `docs/DETAIL.md` for the graph module contract, trace mapping, thread semantics, and limits.
- See `docs/CONTEXT.md` for what is injected into the model context, the vocabulary, and
  how it stays distinct from DSH's `workflow`, `subagent`, and question tools.
- See `docs/ECOSYSTEM.md` for adding LangChain packages, vector stores, prebuilt agents,
  LangSmith tracing, and streaming.

From npm: `dsh plugin --profile <name> add @lzn1998/dsh-langgraph`, then restart that
profile's host. From a local checkout: `dsh plugin --profile <name> add <path-to-this-directory>`.
