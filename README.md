# dsh-langgraph

A DSH bundle that registers LangGraph workflows and exposes them to the agent as the
`langgraph_run` and `langgraph_threads` tools. Graph nodes call the session's own DSH
tools through `helpers.callTool`; threads are checkpointed in a DSH storage domain, so a
run survives the turn — and the Host process — and an `interrupt()`ed graph resumes
where it stopped.

- `langgraph_run` (`graph`, `input`, `thread`, `resume`, `maxSteps`, `run_in_background`;
  omit `graph` to list). A background run returns a DSH job id; read it with `job_output`
  and stop it with `job_kill`.
- `langgraph_threads` (`action`: `list` | `state` | `history` | `edit` | `topology` | `delete`).
  `history` lists checkpoints, `state` reads one by `checkpoint`, and `edit` forks a
  checkpoint with new values. Replay the fork with `langgraph_run({ graph, thread, checkpoint })`.
  `topology` returns a graph's JSON-safe nodes and edges for a client view.
- Registry: `graphs/*.js` (and `graphs/*.ts` on Node 24.22+) in this package plus `config.graphs`.
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
  graph ids and descriptions, so the model can choose `langgraph_run` without first listing.
  `config.prompt: false` disables it.
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
- See `docs/DETAIL.md` for the graph module contract, trace mapping, thread semantics, and limits.

From npm: `dsh plugin --profile <name> add @lzn1998/dsh-langgraph`, then restart that
profile's host. From a local checkout: `dsh plugin --profile <name> add <path-to-this-directory>`.
