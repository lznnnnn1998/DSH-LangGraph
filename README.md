# dsh-langgraph

A DSH bundle that registers LangGraph workflows and exposes them to the agent as the
`langgraph_run` and `langgraph_threads` tools. Graph nodes call the session's own DSH
tools through `helpers.callTool`; threads are checkpointed in a DSH storage domain, so a
run survives the turn — and the Host process — and an `interrupt()`ed graph resumes
where it stopped.

- `langgraph_run` (`graph`, `input`, `thread`, `resume`, `maxSteps`, `run_in_background`;
  omit `graph` to list). A background run returns a DSH job id; read it with `job_output`
  and stop it with `job_kill`.
- `langgraph_threads` (`action`: `list` | `state` | `delete`).
- Registry: `graphs/*.js` (and `graphs/*.ts` on Node 24.22+) in this package plus `config.graphs`.
- Node helpers: `helpers.callTool(name, args)` for DSH tools, `helpers.subagent(prompt, options)`
  for a caller-delivered DSH child agent, `helpers.callModel(prompt, options)` for this
  deployment's model, and `helpers.chatModel()` / `helpers.tools([...])` /
  `helpers.createReactAgent({...})` when you want LangGraph's prebuilt agent to drive DSH
  tools with the DSH model. Node-level calls keep the agent's sandbox and approval scope.
- **Trajectory trace:** each run shows up as one `langgraph_run` row; its graph nodes, DSH
  tool calls, and model calls appear as nested sub-calls in **Trajectory** — `langgraph:node`,
  `langgraph:tool`, `langgraph:model`, `langgraph:subagent`. The trace uses DSH's log-only
  `tool/ptc-dispatch-start` / `tool/ptc-dispatch` events, so it never enters the model's
  context. Neither DSH nor LangGraph source is modified: LangGraph's own callbacks are the
  source, and DSH's existing session-event vocabulary is the sink. Background runs keep the
  same trace under their `langgraph_run` row even though the events arrive after the tool result.
- Threads are owned by the session and graph that created them; another session cannot
  resume or delete them.
- See `docs/DETAIL.md` for the graph module contract, trace mapping, thread semantics, and limits.

From npm: `dsh plugin --profile <name> add @lzn1998/dsh-langgraph`, then restart that
profile's host. From a local checkout: `dsh plugin --profile <name> add <path-to-this-directory>`.
