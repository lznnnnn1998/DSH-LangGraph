# Composing graphs at runtime

`langgraph_run` runs graphs that were registered with the profile. `langgraph_compose`
adds a second source: a model can describe a graph as strict JSON in the middle of a
task, store it as an immutable **session-owned spec**, and run it with the same runtime,
checkpointer, thread, trace, and background-job path.

The division of labour is deliberate:

- **The graph owns the seams** — phases, dependencies, branches, parallel fan-out, the
  human gate, state, and durability.
- **A node owns its inside** — an `agent` node gets a prose brief and tools; a `model`
  node gets one judgment; a `tool` node gets one known atomic action.
- **The compiler owns translation** — JSON to `StateGraph`, with no model, no randomness,
  and no I/O. The same spec always produces the same graph.

## How to think about a composed graph

The model-facing `describe` reply separates a prose **guide** (why and how to think) from
a normative **law** (numbered MUST/MUST NOT rules), then gives the vocabulary reference
and archetype examples. The guide is written to be read as a mentor; the law is written
to be obeyed as a contract. In one paragraph: a graph is a contract about seams; the state is the ledger
that survives a seam, a node is a role that files one result, an edge is a handoff, a map
is one role repeated over a list, a gate is a signature, and a transform is the form a
result takes when filed. Start from the ledger and the seams, not the boxes; keep the
graph coarse, and split only where a step itself is the contract. The ledger's types and
reducers are its rules — a json field with default `[]` and `append` collects one object
per item, while `merge` shallow-merges one object and does not concatenate arrays. Tool
args pass through unchanged, a gate resumes with the raw answer, and a compiler rejection
is a disagreement between the ledger and the contract, not a reason to read the compiler.
The reference below is the exact vocabulary; the examples are archetypes, not templates.

## When to compose, and when not to

Compose when the task has:

- at least three dependent steps;
- a branch, retry, or repair loop;
- work that must survive across turns or a Host restart;
- a fan-out over a list plus an aggregation;
- a human gate between phases.

Do not compose for one or two linear steps, to wrap a single tool call, or when a
registered graph already matches. The ordinary agent loop remains the default; a graph
should earn its ceremony.

The system prompt only states the principle; the numbers live here and in the advisory
lint. Aim for **4–8 phase nodes**. `validate` and `compose` return advisory warnings for a
graph with more than 12 nodes, a chain longer than 8 phases, a literal-only single tool
node, a model that feeds one tool, or a one- or two-step linear graph. Warnings do not
block; use them to merge steps into an `agent` node.

## Lifecycle

```
langgraph_compose({ action: "describe" })         # guide + law + reference + examples
langgraph_compose({ action: "validate", spec })   # no store, no run
langgraph_compose({ action: "compose", spec })    # store, return the id + topology
langgraph_run({ graph: "lg_adhoc_..." })           # compile and execute
langgraph_threads({ action: "history" | "state" | "edit" | "topology" | "delete" })
langgraph_run({ graph, thread, resume })           # answer an interrupt
langgraph_compose({ action: "fork", graph, from }) # rewrite the downstream
```

A spec's id is `lg_adhoc_` plus 24 hex characters of the sha256 of its normalized JSON.
`name` and `description` are part of the content: changing either produces a new id.
Specs are immutable; a changed graph is a new spec and a new thread.

Composed graphs do not appear in the registered-graph list in the system prompt. They are
listed by `langgraph_compose({ action: "list" })` and by `langgraph_run` with no `graph`.

## The IR

```json
{
  "ir": 1,
  "name": "scan-and-decide",
  "description": "Scan once, make one judgment, ask before continuing.",
  "state": {
    "pattern": { "type": "string", "default": "**/*.js" },
    "files": { "type": "string[]", "default": [] },
    "large": { "type": "boolean", "default": false }
  },
  "nodes": [
    { "id": "scan", "do": "tool", "tool": "glob",
      "args": { "pattern": { "$state": "pattern" } },
      "out": { "files": "lines" } },
    { "id": "judge", "do": "model",
      "prompt": ["There are ", { "$state": "files" }, ". Is this large? Reply true or false."],
      "out": { "large": "bool" } }
  ],
  "edges": [
    { "from": "START", "to": "scan" },
    { "from": "scan", "to": "judge" },
    { "from": "judge", "to": "END", "when": true }
  ],
  "output": ["files", "large"],
  "maxSteps": 25
}
```

`START` and `END` are the IR's sentinels (LangGraph's own sentinels are internal). `ir`
is required and must be `1`. No node id may equal a state field name; `__start__`,
`__end__`, and `__interrupt__` are reserved.

### State

| Type | Default must be |
|---|---|
| `string` | a string |
| `number` | a finite number |
| `boolean` | a boolean |
| `json` | any JSON value, including null, arrays, and objects |
| `string[]` | an array of strings |
| `number[]` | an array of finite numbers |

The reducer is one of `replace` (default), `append`, `add`, `max`, `min`, `merge`.
`append` is for arrays; a json field with default `[]` and `append` collects one value per
item (objects included). `add`/`max`/`min` are for numbers. `merge` shallow-merges json
objects with default `{}` (`{...left, ...right}`) and does **not** concatenate arrays; use
`append` with default `[]` to collect a list. A field written by parallel branches or a
`map` body must be mergeable.

A `$state` reference names a top-level field. A dotted path (`data.answer`) reads into a
`json` field only. A literal object may not use the `$state` key.

### Nodes

| `do` | Fields | What it does |
|---|---|---|
| `tool` | `tool`, `args`, `out` | One DSH tool in the calling session's scope. |
| `model` | `prompt`, `system?`, `schema?`, `out` | One model judgment; `schema` asks for JSON and validates it. |
| `agent` | `prompt`, `tools`, `out` | LangGraph's prebuilt ReAct agent over selected DSH tools; the brief is prose and the compiler never inspects it. |
| `subagent` | `prompt`, `schema?`, `out` | A child DSH session with its own tool scope; optional structured output. |
| `gate` | `question`, `options?`, `out` | LangGraph `interrupt()`; the resume value is written through `out`. |
| `set` | `values` | Literal or `$state` assignments, no arithmetic. |
| `map` | `over`, `body`, `maxItems?`, `maxConcurrency?` | Dynamic fan-out over a `string[]` or `number[]` field. |

`prompt` is an array of strings and `$state` references, concatenated exactly as written.
`args` and `set.values` may contain nested literals and references. A tool node's `args`
are passed unchanged to the DSH tool; use the tool's own argument names (`glob {pattern}`,
`read {file_path}`, `write {file_path, content}`). A map body can put `{ $state: "item" }` anywhere
an arg expects the item.

A `gate` pauses the run with `{ question, options, node }`; `langgraph_run` returns
`status: "interrupted"` with the thread and interrupts. Ask the user, then resume the
same thread with `resume: <raw answer>`. `options` are labels only; the resume value
goes through `out`. For label answers use `out: { decision: "text" }` and an `eq` guard;
`bool` accepts only `true`/`false`.

### Transforms

The `out` map names state fields and how a node result becomes the value:

| Transform | Produces | Typical field |
|---|---|---|
| `text` | string | `string` |
| `lines` | string[] | `string[]` |
| `json` | parsed JSON | `json` |
| `bool` | boolean (accepts `"true"`/`"false"`) | `boolean` |
| `number` | finite number | `number` |
| `first` | the first line or item | `string` |
| `count` | lines or items | `number` |

A transform must fit the field type. A `model` with a string `schema` may write `json`
into a string field. A map body may additionally write a scalar into an array field with
`append` (one element per item).

`bool` is strict: it accepts a JSON boolean or the text `true`/`false` only. A verify node
that returns a sentence should use `text` plus a guard, or a `model` with a boolean
schema.

A `model` or `subagent` `schema` is checked with a JSON Schema subset: `type`, `enum`,
`const`, `required`, `properties`, `additionalProperties`, `items`, and min/max length,
items, and numeric bounds. Other keywords (such as `pattern` or `$ref`) are ignored.

### Guards

`when` is `true`, `false`, or `{ "op": "...", "args": [...] }` with one of `eq`, `ne`,
`in`, `gt`, `gte`, `lt`, `lte`, `exists`, `and`, `or`, `not`. There is no expression
string and no `eval`. A missing value or a type mismatch makes a comparison false rather
than throwing. `gt`/`gte`/`lt`/`lte` need numbers; `in` needs an array on the right;
`and`/`or`/`not` nest guards.

### Edges

Each node's outgoing edges are exactly one of:

1. **sequence** — one unconditional edge;
2. **choice** — one or more conditional edges, evaluated in array order; add a
   `when: true` fallback, or a run with no match fails;
3. **parallel** — two or more unconditional edges = static fan-out.

Do not mix conditional and unconditional edges from one node. `START` has no incoming
edges; `END` has no outgoing edges; `START` edges are unconditional. A node with multiple
incoming edges waits for all of them (LangGraph's implicit join). Cycles are allowed and
analyzed as strongly connected components; `maxSteps` bounds them.

## Map

`map` fans out over an array. The body reads the hidden `item` and `index` references; a
parent field named `item` or `index` is shadowed inside the body.

```json
{
  "id": "read",
  "do": "map",
  "over": "files",
  "maxItems": 50,
  "maxConcurrency": 8,
  "body": {
    "do": "tool",
    "tool": "read",
    "args": { "file_path": { "$state": "item" } },
    "out": { "reports": "text" }
  }
}
```

- `over` must be a list you control. A tool result such as `No files found` is one
  string, not an empty list; check or guard it before mapping.
- To map over files: a `glob` tool node with `out: { files: "lines" }` produces the
  `string[]`; the body's `read` args use `{ file_path: { $state: "item" } }`, and
  `out: { contents: "text" }` into a `string[]` with `append` adds one string per item.
  `langgraph_compose({ action: "describe" })` returns this full pattern as the
  `map-gate-write` example.
- The body may be `tool`, `model`, `agent`, or `subagent`; no `gate`, no nested `map`.
- Every body `out` field must use a mergeable reducer. `text`/`first` into
  `string[]` + `append` appends one string per item; `lines` appends an array; `number`
  and `count` into `number[]` + `append`.
- For one structured object per item, declare the field as
  `{ "type": "json", "default": [], "reducer": "append" }` and have the body write
  `{ "extracts": "json" }`; each item appends one value. `json` into `json` + `merge`
  (default `{}`) is for merging objects into one object, not for a list. The `describe`
  reply returns this pattern as the `map-extract` example.
- `maxItems` defaults to 50 and is capped at 100. A longer array fails the map; it is
  never truncated.
- `maxConcurrency` defaults to 8 and is capped at 16. In this version the strictest map
  limit is applied as the whole run's LangGraph concurrency cap.
- **Order:** `append` follows LangGraph's `Send` order, which is the input order, not
  completion order. This is deterministic and was verified against LangGraph 1.7.5.
- An empty array sends one sentinel item so the join still runs; the downstream graph
  continues with the aggregate defaults instead of silently ending.
- The compiler builds three nodes: `<id>__fanout` (dispatch), `<id>` (one item), and
  `<id>__join` (runs once after all items). The join follows the spec's out-edges, so a
  guard after a map sees the aggregated state.

## The compose tool

| Action | Behaviour |
|---|---|
| `describe` | The prose guide, the normative law, the vocabulary reference and archetype examples. On demand, so it costs no prompt tokens. |
| `validate` | Parse and check; returns `{ ok, errors, warnings, topology }`; stores nothing. |
| `compose` | Validate, build once to prove the spec compiles, store, and return `{ graph, name, input, topology, warnings, created }`. The topology is IR-level; `langgraph_threads({ action: "topology" })` returns the compiled nodes, including the hidden map fanout/join. |
| `list` | This session's specs with thread counts. |
| `get` | The stored spec and input schema. |
| `delete` | Delete the spec; refuses while threads exist unless `delete_threads: true`. |
| `fork` | Return an editable downstream spec plus the current state. |

Errors carry an exact IR path (`nodes[2].do`, `edges[3].to`), the expected shape and,
where useful, a hint, so a model can repair a spec from the reply. Tool references are
checked against the tools visible to the calling agent; when the caller passes full tool
definitions, a tool node's args are also checked against the tool's own parameters
(required keys, unknown keys when `additionalProperties` is false, literal types, and
top-level `$state` reference types) at compose time and enforced again at run time.

### Specs from a file

`compose` and `validate` accept `path` instead of `spec`: a `.json` file inside the
session's cwd. Absolute paths, `..` escapes, and symlinks that leave the cwd are
rejected. A profile without a session cwd must pass the parsed object. The file is only
a source; resuming a thread never re-reads it. Editing the file produces a new spec.

### Storage and ownership

Specs live in the `langgraph_specs` storage domain, one record per content id, capped at
64 per session. A record is `{ spec, source, sessionId, createdAt, compilerVersion }`.
Without a storage domain the store is process-local, like the in-memory checkpoint
fallback. A spec is owned by the session that composed it; another session cannot run,
read, or delete it. The Web panel's owner-only topology route may inspect any spec.

## Running, failure, and recovery

`langgraph_run` accepts a registered id or a composed id. A composed run carries the
spec's `maxSteps` (default 25) and map concurrency cap. Threads, interrupts, background
jobs, time travel, topology, and traces work exactly as for registered graphs.

### Failure result

A failed run returns `status: "failed"` instead of throwing:

```json
{
  "status": "failed",
  "graph": "lg_adhoc_7f3a...",
  "thread": "lg_lg_adhoc_7f3a..._...",
  "checkpoint": "1ef...",
  "failedNode": "read",
  "failedScc": ["read"],
  "pending": ["read"],
  "downstream": ["END", "judge", "read"],
  "upstream": ["START", "scan"],
  "lastSupersteps": [
    { "step": 2, "source": "loop", "next": ["read"], "tasks": [{ "id": "judge", "error": null }],
      "values": { "verdict": "large" } }
  ],
  "error": { "name": "ToolError", "message": "read: ENOENT", "node": "read", "itemIndex": 1 },
  "state": { "reports": [] },
  "hint": "transient -> resume with the same thread; state -> edit/replay; graph -> fork the downstream and compose"
}
```

- `failedNode` comes from the node wrapper; a map item also carries `itemIndex`.
- `failedScc` is the cycle the failure belongs to (a singleton for a non-cyclic node).
- `upstream` is the completed dependency side; `downstream` includes the failed region
  and everything after it.
- `pending` is the boundary checkpoint's next work, with hidden map nodes reported as
  the spec's map id.
- `lastSupersteps` holds the failure boundary and at most two prior checkpoints, with
  `state`/`values` bounded by `output` and a 4000-character cap.
- A registered graph gets the error and thread history, but no SCC/dependency fields
  because it has no IR.

Background jobs report the same structured result in `job_output`.

### Recovery

1. **Transient** — `langgraph_run({ graph, thread })` resumes the pending work on the
   same thread. Completed map items are checkpointed; the failed superstep is retried.
2. **State error** — `langgraph_threads edit` at the failure `checkpoint`, then
   `langgraph_run({ graph, thread, checkpoint })` replays from the edit.
3. **Graph bug** — `langgraph_compose({ action: "fork", graph, from: failedNode, thread })`
   returns the downstream nodes/edges as a new spec skeleton, with `START` pointing at
   the failed region's external entries, plus the thread's current state. Edit the spec,
   `compose` it, and run the new graph with that state as input. The old spec and thread
   remain.
4. **Loop bug** — fork the whole SCC; the loop is one recovery unit.
5. The runtime never mutates a spec. Every rewrite is a new immutable spec.

At-least-once applies: a failed node may already have produced side effects. Destructive
actions should be idempotent or guarded by a `gate`.

## Limits

| Item | Limit |
|---|---|
| nodes | 64 |
| edges | 128 |
| state fields | 64 |
| spec JSON | 256 KiB |
| `maxSteps` | 1–200 (default 25) |
| map `maxItems` | 1–100 (default 50) |
| map `maxConcurrency` | 1–16 (default 8) |
| specs per session | 64 |

## Not supported

- No arbitrary JavaScript: only the IR's node kinds. The compiler never runs model-written
  code, and a spec is never written to `graphs/*.js`.
- No subgraphs, LangGraph Platform/Studio, token streaming inside a tool result, or vector
  search in the store.
- No per-map concurrency in v1; the strictest map cap is global.
- No automatic spec promotion to a profile module. Reuse across sessions means writing a
  graph module and installing it, which requires the profile's normal restart.

## Examples

`test/fixtures/specs/` holds the conformance specs:

- `scan-report` — tool, model, choice.
- `approval-gate` / `ask-user` — gate and resume.
- `ask-tools` — agent over session tools.
- `ask-workspace` — tool then model.
- `ask-subagent` — child session.
- `map-report` — map, append, join.
- `parallel` — static fan-out and a join.
