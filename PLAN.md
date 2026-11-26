# Delivery plan — one small version per gap, commit after each

Constraints: **no DSH source changes, no LangGraph source changes, no agent-loop
replacement.** All work is a plugin change on this checkout.

Current baseline:
- GitHub `main` = `ea9bf42`; npm = `@lzn1998/dsh-langgraph@0.5.0`
- `0.6.0` system-prompt graph list is committed in `537292d` (21 tests pass)
- this plan is committed in `d8ab90e`
- `0.7.0` BaseStore is committed in `69051ac`
- `0.8.0` time travel is committed in `2178ba4`
- `0.9.0` retention is committed in `13e3203`
- `0.10.0` askUser is committed in `0f42f0a`
- `0.11.0` topology is implemented (46 tests pass); commit pending

## Per-version checklist
For every version: implement → `npm test` → update docs/config → commit with author
`lznnnnn1998 <710859414@qq.com>` (no Claude attribution). Tag/publish only on
explicit request or at the end of the batch.

---

## 0.6.0 — model-facing graph list (DONE, commit pending)
- `ctx.systemPrompt.section('tool:langgraph')` lists registered graph ids/descriptions.
- `config.prompt: false` disables it; eager scan for the list; 24-graph cap.
- Tests: `test/prompt.test.js`; total 21 passing.

## 0.7.0 — BaseStore / long-term memory (DONE, commit pending)
- `dsh-store.js`: `DshStore extends BaseStore` over `langgraph_store`
  domain; get/put/delete, prefix search, filters, pagination, listNamespaces.
- Vector search (`query`) explicitly rejects; embeddings are a later item.
- `compile({ store })`, `api.store`, `helpers.store()`; fallback `InMemoryStore`;
  `config.store: false` passes none.
- Tests: store unit suite plus apply-level wiring (durable across runs, disabled path).
- Commit: `feat: add durable LangGraph BaseStore`.

## 0.8.0 — time travel / state edit / replay (DONE, commit pending)
- `langgraph_threads` actions: `history`, `edit`, `state` with `checkpoint`.
- `langgraph_run({ checkpoint })` replays from a checkpoint.
- Unknown checkpoint ids are validated against the saver (`getState` synthesizes an
  empty snapshot otherwise).
- Tests: apply-level run → history → read checkpoint → edit → replay, plus errors.
- Commit: `feat: add thread history, state edit and checkpoint replay`.

## 0.9.0 — checkpoint retention (DONE, commit pending)
- `retention` config (default 200, `0` unlimited); prune old checkpoints and writes
  after each put; thread counters reconciled to what is stored.
- Tests: put 5 with retention 2 → newest 2 remain; writes pruned; per-thread isolation;
  apply-level history capped.
- Commit: `feat: bound checkpoint history per thread`.
- Lazy load: per-thread domains is a follow-up if retention is not enough; the domain
  open currently loads all records.

## 0.10.0 — askUser HITL helper (DONE, commit pending)
- `helpers.askUser(questions)` calls `ask_user_question` through `ctx.tools.execute`;
  native DSH question UI, no custom client. Normalizes options/ids, parses the answer
  batch, documents skip and subagent-origin restrictions.
- Example graph `ask-user`; tests with a stubbed question tool.
- Not yet verified in a live Web session (headless has no answerer).
- Commit: `feat: add native HITL questions from graph nodes`.

## 0.11.0 — topology host action (DONE, commit pending)
- `langgraph_threads({ action: 'topology', graph })` compiles the graph and returns
  `Graph.toJSON()` as JSON-safe nodes/edges (conditional edges flagged).
- This is the host half; a client panel is 0.13.0.
- Tests: node/edge shape, conditional edges, unknown graph.
- Commit: `feat: expose graph topology for clients`.

## 0.12.0 — ecosystem surface
- Document `getStore()`, prebuilt imports, LangSmith env, retrieval/vector-store usage.
- Add small helpers only where they remove real friction; no new runtime.
- Commit: `docs: document the LangChain ecosystem bridges`.

## 0.13.0 — client UI (separate package)
- Topology panel, token-level streaming, action-card HITL.
- Requires a client bundle (`dsh.client.inject`, React/tsdown/slots); not a host-only
  change. Build/test in its own package; no DSH source changes.
- Commit: `feat: add langgraph client view`.

## 0.14.0 — sandboxed graph worker (separate architecture)
- Run graph modules in a child process confined by `ctx.sandbox`; bridge
  `callTool`/`callModel` over IPC. Current trust boundary is the graph author.
- Large, isolated change; commit only when the worker and RPC are tested.
- Commit: `feat: run graph code in a sandboxed worker`.

## Optional 0.15.0 — schedule/webhook adapters
- `ctx.schedule` / `ctx.webhookRuntime` trigger a session that runs a graph.
- Approximate, not a managed Platform.

## Not fillable under the constraints
- Every turn graph-native (needs `AgentFactory`/loop integration).
- Hosted LangGraph Platform/Studio.
- Token streaming inside a single tool result (the tool protocol is one result;
  use background job output or a client view instead).
