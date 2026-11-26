# Delivery plan — one small version per gap, commit after each

Constraints: **no DSH source changes, no LangGraph source changes, no agent-loop
replacement.** All work is a plugin change on this checkout.

Current baseline (all versions below committed locally; nothing pushed or published):
- GitHub `main` = `ea9bf42`; npm = `@lzn1998/dsh-langgraph@0.5.0`
- local HEAD = `a9ea4ef`; 51 tests pass; typecheck green
- `0.6.0` system-prompt graph list is committed in `537292d` (21 tests pass)
- this plan is committed in `d8ab90e`
- `0.7.0` BaseStore is committed in `69051ac`
- `0.8.0` time travel is committed in `2178ba4`
- `0.9.0` retention is committed in `13e3203`
- `0.10.0` askUser is committed in `0f42f0a`
- `0.11.0` topology is committed in `e265e03`
- `0.12.0` ecosystem docs are committed in `4d869ed`
- `0.13.0` client panel is committed in `a9ea4ef` and verified in Web
- `0.14.0` sandbox worker is deferred after checking the sandbox surface (see below)

## Per-version checklist
For every version: implement → `npm test` → update docs/config → commit with author
`lznnnnn1998 <710859414@qq.com>` (no Claude attribution). Tag/publish only on
explicit request or at the end of the batch.

---

## 0.6.0 — model-facing graph list (DONE)
- `ctx.systemPrompt.section('tool:langgraph')` lists registered graph ids/descriptions.
- `config.prompt: false` disables it; eager scan for the list; 24-graph cap.
- Tests: `test/prompt.test.js`; total 21 passing.

## 0.7.0 — BaseStore / long-term memory (DONE)
- `dsh-store.js`: `DshStore extends BaseStore` over `langgraph_store`
  domain; get/put/delete, prefix search, filters, pagination, listNamespaces.
- Vector search (`query`) explicitly rejects; embeddings are a later item.
- `compile({ store })`, `api.store`, `helpers.store()`; fallback `InMemoryStore`;
  `config.store: false` passes none.
- Tests: store unit suite plus apply-level wiring (durable across runs, disabled path).
- Commit: `feat: add durable LangGraph BaseStore`.

## 0.8.0 — time travel / state edit / replay (DONE)
- `langgraph_threads` actions: `history`, `edit`, `state` with `checkpoint`.
- `langgraph_run({ checkpoint })` replays from a checkpoint.
- Unknown checkpoint ids are validated against the saver (`getState` synthesizes an
  empty snapshot otherwise).
- Tests: apply-level run → history → read checkpoint → edit → replay, plus errors.
- Commit: `feat: add thread history, state edit and checkpoint replay`.

## 0.9.0 — checkpoint retention (DONE)
- `retention` config (default 200, `0` unlimited); prune old checkpoints and writes
  after each put; thread counters reconciled to what is stored.
- Tests: put 5 with retention 2 → newest 2 remain; writes pruned; per-thread isolation;
  apply-level history capped.
- Commit: `feat: bound checkpoint history per thread`.
- Lazy load: per-thread domains is a follow-up if retention is not enough; the domain
  open currently loads all records.

## 0.10.0 — askUser HITL helper (DONE)
- `helpers.askUser(questions)` calls `ask_user_question` through `ctx.tools.execute`;
  native DSH question UI, no custom client. Normalizes options/ids, parses the answer
  batch, documents skip and subagent-origin restrictions.
- Example graph `ask-user`; tests with a stubbed question tool.
- Not yet verified in a live Web session (headless has no answerer).
- Commit: `feat: add native HITL questions from graph nodes`.

## 0.11.0 — topology host action (DONE)
- `langgraph_threads({ action: 'topology', graph })` compiles the graph and returns
  `Graph.toJSON()` as JSON-safe nodes/edges (conditional edges flagged).
- This is the host half; a client panel is 0.13.0.
- Tests: node/edge shape, conditional edges, unknown graph.
- Commit: `feat: expose graph topology for clients`.

## 0.12.0 — ecosystem surface (DONE)
- `docs/ECOSYSTEM.md`: bridge table, adding LangChain packages (single
  `@langchain/core`), vector stores via a custom compiled graph, LangSmith env,
  prebuilt agents, streaming seams, compatibility.
- No new runtime: the existing helpers already cover the friction points.
- Commit: `docs: document the LangChain ecosystem bridges`.

## 0.13.0 — client view (DONE)
- Same package, second export: `dsh.client` + `lib/client.js` browser bundle; slots
  `main` and `sidebar.panellist`; only React externals.
- Panel lists registered graphs with thread counts and draws `Graph.toJSON()` topology;
  host serves owner-only `GET /api/plugins/langgraph/ui` and `/topology` through
  `ctx.connection.fetch.register`. `config.ui: false` disables both.
- Verified in a real DSH 0.2.2-rc.5 Web session (sidebar row, 7 graphs, 17 threads,
  approval-gate topology, no console errors).
- Token-level streaming and action cards remain out of scope: streaming is not in the
  tool protocol, and HITL uses the native question UI (0.10.0).
- Commit: `feat: add the LangGraph Web panel`.

## 0.14.0 — sandboxed graph worker (DEFERRED — not a small version)
Checked against DSH 0.2.2-rc.5/0.2.3-alpha.2:
- `ctx.sandbox` / `SandboxExecutionPolicy` confine **shell and filesystem**
  execution (`mode`, `workspaceRoot`, writable roots). They are not a JavaScript
  VM or a capability boundary; a Node child process could still open sockets and
  run code as the same user.
- A worker that keeps the current feature set would need remote implementations of
  `BaseCheckpointSaver`, `BaseStore`, `BaseChatModel`, LangChain tools, question
  UI, subagents, and the trace callbacks, all over IPC, plus state serialization
  and cancellation. That is a distributed LangGraph runtime, not a version-sized
  change.
- Without those, a worker silently loses durable threads, long-term memory,
  prebuilt agents, and traces — a regression, not a hardening.
- Decision: keep the documented trust boundary (a graph module is code the profile
  author installed, like any plugin) and rely on DSH's tool sandbox/approval policy
  for the work a graph performs. Revisit only with a real VM/container runner and a
  dedicated RPC design.

## Optional 0.15.0 — schedule/webhook adapters (not done)
- `ctx.schedule` / `ctx.webhookRuntime` trigger a session that runs a graph.
- Needs a Session-trigger design and its own permission story; left out of this batch
  because it is optional and not required for the tool, trace, memory, time-travel, HITL,
  topology, or panel work above.

## Not fillable under the constraints
- Every turn graph-native (needs `AgentFactory`/loop integration).
- Hosted LangGraph Platform/Studio.
- Token streaming inside a single tool result (the tool protocol is one result;
  use background job output or a client view instead).
