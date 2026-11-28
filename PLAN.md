# Delivery plan — one small version per gap, commit after each

Constraints: **no DSH source changes, no LangGraph source changes, no agent-loop
replacement.** All work is a plugin change on this checkout.

Current release:
- tag `v1.6.0`; npm = `@lzn1998/dsh-langgraph@1.6.0`; main has the 1.6.0 release commit.
- `1.1.0`–`1.6.0` are released: pushed, tagged, and published.
- 166 tests pass; typecheck (`tsc --noEmit --skipLibCheck`) is green.
- `0.6.0`–`1.0.1` are commits on `main`; `v1.0.1` tags the first release.
- `0.6.0` system-prompt graph list is committed in `537292d` (21 tests pass)
- this plan is committed in `d8ab90e`
- `0.7.0` BaseStore is committed in `69051ac`
- `0.8.0` time travel is committed in `2178ba4`
- `0.9.0` retention is committed in `13e3203`
- `0.10.0` askUser is committed in `0f42f0a`
- `0.11.0` topology is committed in `e265e03`
- `0.12.0` ecosystem docs are committed in `4d869ed`
- `0.13.0` client panel is committed in `a9ea4ef` and verified in Web
- `0.13.1` prompt distinction is committed (53 tests pass) and verified in Web:
  “扫描一下这个目录里有多少 JS 文件” now lists graphs, then calls `scan-report`
- `1.0.0` is released (tag, npm)
- `1.0.1` open-shape guidance and structural prompt tests are implemented; released.
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

## 0.13.1 — prompt distinction (DONE)
- Diagnosis from the live `lg` session: `langgraph_run` was in every request and the
  graph list was in the system prompt. The final task still went to `subagent` because
  no graph matched it and the user named subagent; the section also sat next to the
  `workflow` tool's "ONLY when the user explicitly asks" rule and repeated the word
  "workflow", making it easier to discount.
- Renamed the intro to "LangGraph graphs", added "this is not the `workflow` tool", a
  match rule ("name or description match → call it; do not reimplement with
  bash/subagent"), and moved the section to `TOOL_SUBAGENT - 10`.
- Tests: prompt text plus apply-level order/text (53 total).
- Verified in Web: "扫描一下这个目录里有多少 JS 文件，看看多不多" called
  `langgraph_run` with no graph (list), then `scan-report`, then one bash count.
- Commit: `fix: distinguish LangGraph graphs from the workflow tool` (`d0b3269`).

## 1.0.0 — context/prompt audit and release
- Audited the two model-facing layers (tool schemas and one prompt section); no runtime
  context is injected.
- Rewrote the section around one vocabulary (graphs, LangGraph thread, DSH job,
  Trajectory) and one trigger/non-trigger policy; removed the misleading long-term-memory
  trigger; made "not a DSH Session" explicit.
- Tool descriptions now split selection (section) from mechanics (tools); UI, docs,
  locale, and example comments normalized to "graphs".
- `docs/CONTEXT.md` records the boundary with `workflow`, `subagent`, `ask_user_question`,
  jobs, Sessions, and Trajectory, plus the maintenance checklist.
- Tests: prompt text/order plus apply-level tool descriptions (53 total).
- Verified in fresh Web sessions: an exact file count used glob + bash (no graph, because
  `scan-report` reports a verdict, not an exact count); “只要多还是少，不用精确数”
  called `langgraph_run({ graph: 'scan-report' })`. The prompt section sits at 2790,
  after the `workflow` rule and before subagent guidance.
- Release: pushed `main`, tagged `v1.0.0`, published `@lzn1998/dsh-langgraph@1.0.0`.

## 1.0.1 — open shapes and structural tests
- Added prose guidance for unregistered or still-unclear shapes: `langgraph_run` only
  runs registered graphs and cannot define one; one-off work uses ordinary DSH tools,
  ad-hoc fan-out uses `workflow`, and a reusable shape belongs in a profile graph module.
  No concrete examples, so the model composes the shape.
- Repo prompt tests now assert concepts and structure (name, requested output, thread vs
  session, no invented ids) instead of full sentences. Detailed behavior tests live in a
  private `/tmp` matrix, not the repo.
- Private matrix (fresh Web sessions): explicit graph → `langgraph_run`; output match
  (large/small) → `scan-report`; exact count → bash; subagent → `subagent`; background →
  `langgraph_run` + `run_in_background` + `job_output`; thread history →
  `langgraph_threads history`; workflow fan-out → `workflow`; ambiguous release shape →
  no graph, ordinary tools.
- 53 tests; typecheck green. Release: pushed `main`, tagged `v1.0.1`, published.

## 1.1.0 — graph spec compiler core (DONE)
- `compose/`: constants, strict validation with exact IR paths, structured guards,
  templates/transforms, Tarjan SCC + reachability + writer/reducer analysis, node
  executors for `tool`/`model`/`agent`/`gate`/`set`, and `buildSpecGraph` for sequence,
  choice, static fan-out, and join.
- 36 tests; v1 conformance specs `scan-report`, `approval-gate`, `ask-tools`, `parallel`.
- Commit `5e12fca`; plan committed in `7a2e745`.

## 1.2.0 — spec store and resolve (DONE)
- `langgraph_specs`: content-addressed ids, owner checks, idempotent saves, 64/session
  cap, memory fallback, close-on-dispose.
- `resolveEntry` per owner; `langgraph_run`, `langgraph_threads`, and the topology route
  accept `lg_adhoc_` ids; a spec's `maxSteps` bounds the run.
- 12 tests; commit `80d2ab9`.

## 1.3.0 — compose tool and run (DONE)
- `langgraph_compose`: `describe`/`validate`/`compose`/`list`/`get`/`delete`, workspace
  `.json` path confined to the session cwd, tool-visibility checks.
- Prompt gained compose/coarse-first guidance; over-decomposition lint; no-arg
  `langgraph_run` lists composed graphs; interrupt/resume/history/edit/replay/background
  work on composed ids.
- 24 tests; commit `7aff06a`.

## 1.4.0 — map and subagent (DONE)
- `map` over `string[]`/`number[]` via `Send` with hidden fanout/body/join, `item`/`index`,
  `maxItems`, `maxConcurrency`, empty-array sentinel, and input-order `append`.
- `subagent` nodes; map-report/ask-workspace/ask-subagent/ask-user conformance specs.
- 18 tests; commit `203f10c`.

## 1.5.0 — failure, recovery, and docs (DONE)
- Structured failure result: failed node/SCC, upstream/downstream, pending, last three
  bounded supersteps, error with `itemIndex`, state, recovery hint; background jobs carry
  it too. Success results carry a small run report.
- resume/edit/replay, `fork` downstream or SCC + re-compose, cycle recovery, GraphSpec
  types, `docs/COMPOSE.md`, README/DETAIL/ECOSYSTEM/CONTEXT updates.
- Prompt relaxed to principles (seams, coarse graph, open work in `agent`); prompt tests
  assert tool names, boundaries, and the registry rather than sentences; numeric
  thresholds stay in the lint and `describe`.
- A 10-run headless matrix showed the default prompt did not over-compose small tasks,
  while forced coarse/fine graphs cost 2.6–4.9x tokens; `describe` now calls out the
  strict `bool` transform and that `map.over` must be a controlled list. A real Web
  session on a new `lgtest` profile/3085 passed compose → run.
- Big-task comparison (12 topics + approval): the default ordinary loop took 53s / 124K
  and succeeded; a forced coarse 4-node agent graph took 1m38s / 462K and succeeded but
  its write node dropped headings and needed a manual fix; the forced fine run was
  stopped at 19 steps / 506K with no output after it started reading the harness/plugin
  source instead of using `describe`.
- The fine failure's root cause was the manual, not the model: `describe` lacked a
  map/gate/write example and gate resume semantics. It now returns a full
  `map-gate-write` example, explains gate options/labels and raw resume values, adds
  glob→lines→map guidance, map error hints, and a gate options+bool warning. A small
  3-topic fine e2e then composed and ran a 5-node map/gate graph without reading source.
- A second big fine attempt exposed the remaining design gap: per-item JSON could not
  use `json` + `append`, and `merge` semantics were unclear, so the model returned to
  source reading. `json` fields with default `[]` now accept `append`; `describe` returns
  `reducerNotes` and a `map-extract` example; docs state that `merge` does not
  concatenate arrays.
- A third big fine attempt doubted the `read` tool args. `describe` and docs now state
  that a tool node's args pass through unchanged and name `glob {pattern}`,
  `read {path}`, `write {path, content}`.
- The per-failure notes had become whack-a-mole. The model-facing `describe` is now a
  single coherent guide (contract about seams; state as ledger; nodes as roles; edges as
  handoffs; gates as signatures; transforms as forms), followed by an exact reference and
  archetype examples. The prompt uses the same vocabulary and points at the guide first.
- The guide was then split by tone: a prose guide for the method, a numbered `law` for
  MUST/MUST NOT rules (reducers, nodes, edges, maps, gates, failures, limits), a vocabulary
  reference, and archetype examples. The prompt points at the guide and the law.
- A big fine attempt failed because the manual itself was wrong: it said `read {path}`, but
  DSH `read` requires `file_path`. The guide, law, examples and docs now use `file_path`
  (and `write {file_path, content}`); `validate`/`compose` also check tool node args
  against the visible tool's parameters (required, additional properties, literal types)
  so this disagrees at compose time instead of inside a map.
- With those fixes, the same fine task completed: 55s / 9 steps / 226K, a 7-node IR graph
  (list, map read x12, map extract x12, outline, gate, compose, write), 11 supersteps,
  and 12 correct rows. It used about half the coarse graph's tokens (462K) and slightly
  more than the default loop (124K / 53s). The earlier "fine is harmful" result was the
  manual and validation, not the fine graph.
- The audit found and fixed: `merge` accepted a non-object json default (an array default
  became `{}`), tool `$state` refs were not type-checked against the tool schema, the law
  overstated three advisory lints, and docs still said "IR manual/minimal example".
  Hidden map ids, registered-graph failure fields and the tool-schema authority are now
  stated precisely; merge/limit/ref tests added. 165 tests; typecheck (skipLibCheck) green.
- 165 tests; released as v1.5.0 (166 tests now; see 1.6.0).

## 1.6.0 — gallery, benchmark, demo, README (DONE)
- Six copyable GraphSpecs (`research-brief`, `repo-scan`, `pr-review`, `incident-triage`,
  `data-extract`, `approval-plan`), an attractive static gallery with inline topology and
  prompts, and a test that validates every spec.
- A reproducible official-DSH-vs-plugin benchmark harness (`bench/run.mjs`) and a short
  report with the 12-topic Web case; the small-task variance is documented.
- A 57s Playwright recording of a completed 12-topic Web session, plus the screenshot.
- README rewritten around the high-star DSH plugin pattern: centered icon/badges, real
  screenshot/video, install, 60s quickstart, gallery, benchmark, when not to use,
  reference, trust boundary, compatibility and community.
- No runtime changes; the npm tarball now includes `gallery`, `bench` and `media`;
  166 tests; typecheck green. Released as v1.6.0.

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
