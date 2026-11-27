/**
 * The `langgraph_compose` tool: describe, validate, compose, list, get, delete.
 *
 * `describe` is the on-demand IR manual. `validate` and `compose` parse a spec
 * object or a workspace `.json` file, check the tools visible to the calling
 * agent, and never execute the graph. A composed spec is stored under a content
 * id and owned by the calling session; `langgraph_run` then accepts that id.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import {
  END,
  GUARD_OPS,
  IR_VERSION,
  LIMITS,
  MAP_BODY_KINDS,
  REDUCERS,
  START,
  STATE_TYPES,
  TRANSFORMS,
} from './constants.js'
import { analyze, downstreamOf, upstreamOf } from './analysis.js'
import { buildSpecGraph } from './build.js'
import { inputSchemaOf } from './resolve.js'
import { validateSpec } from './schema.js'
import { specId } from './specs.js'
import { isPlainObject } from './template.js'

/** Actions this tool version accepts. */
export const COMPOSE_ACTIONS = Object.freeze(['describe', 'validate', 'compose', 'list', 'get', 'delete', 'fork'])

/** A small, valid spec returned by `describe`. */
const EXAMPLE = Object.freeze({
  ir: 1,
  name: 'scan-and-decide',
  description: 'Scan once, make one judgment, ask before continuing.',
  state: {
    pattern: { type: 'string', default: '**/*.js' },
    files: { type: 'string[]', default: [] },
    large: { type: 'boolean', default: false },
    decision: { type: 'string', default: '' },
  },
  nodes: [
    { id: 'scan', do: 'tool', tool: 'glob', args: { pattern: { $state: 'pattern' } }, out: { files: 'lines' } },
    {
      id: 'judge',
      do: 'model',
      prompt: ['There are ', { $state: 'files' }, '. Is this a large project? Reply true or false.'],
      out: { large: 'bool' },
    },
    { id: 'confirm', do: 'gate', question: 'Continue with this project?', options: ['Approve', 'Reject'], out: { decision: 'text' } },
  ],
  edges: [
    { from: 'START', to: 'scan' },
    { from: 'scan', to: 'judge' },
    { from: 'judge', to: 'confirm', when: { op: 'eq', args: [{ $state: 'large' }, true] } },
    { from: 'judge', to: 'END', when: true },
    { from: 'confirm', to: 'END' },
  ],
})

/**
 * A worked fine-grained spec: a glob becomes a string[], a map reads each file,
 * a model joins the results, a gate asks for approval, and a write tool saves.
 * This is the pattern to copy when a step is the contract.
 */
const MAP_GATE_WRITE_EXAMPLE = Object.freeze({
  ir: 1,
  name: 'map-gate-write',
  description: 'List files, read them with a map, summarize, approve, and write.',
  state: {
    pattern: { type: 'string', default: '*.txt' },
    files: { type: 'string[]', default: [] },
    contents: { type: 'string[]', default: [], reducer: 'append' },
    summary: { type: 'string', default: '' },
    decision: { type: 'string', default: '' },
  },
  nodes: [
    { id: 'list', do: 'tool', tool: 'glob', args: { pattern: { $state: 'pattern' } }, out: { files: 'lines' } },
    {
      id: 'read',
      do: 'map',
      over: 'files',
      body: { do: 'tool', tool: 'read', args: { file_path: { $state: 'item' } }, out: { contents: 'text' } },
    },
    { id: 'join', do: 'model', prompt: ['Summarize these files:\n', { $state: 'contents' }], out: { summary: 'text' } },
    { id: 'approve', do: 'gate', question: 'Write the summary?', options: ['Approve', 'Revise'], out: { decision: 'text' } },
    {
      id: 'write',
      do: 'tool',
      tool: 'write',
      args: { file_path: '.lg-big/summary.md', content: { $state: 'summary' } },
      out: {},
    },
  ],
  edges: [
    { from: 'START', to: 'list' },
    { from: 'list', to: 'read' },
    { from: 'read', to: 'join' },
    { from: 'join', to: 'approve' },
    { from: 'approve', to: 'write', when: { op: 'eq', args: [{ $state: 'decision' }, 'Approve'] } },
    { from: 'approve', to: 'END', when: true },
    { from: 'write', to: 'END' },
  ],
  output: ['summary', 'decision'],
  maxSteps: 25,
})

/**
 * A worked map-of-models spec: one JSON object per item is collected into a
 * `json` field with default [] and reducer append. `merge` is for one object.
 */
const MAP_EXTRACT_EXAMPLE = Object.freeze({
  ir: 1,
  name: 'map-extract',
  description: 'Read files, extract one JSON object per file, and outline the set.',
  state: {
    pattern: { type: 'string', default: '*.txt' },
    files: { type: 'string[]', default: [] },
    contents: { type: 'string[]', default: [], reducer: 'append' },
    extracts: { type: 'json', default: [], reducer: 'append' },
    outline: { type: 'string', default: '' },
  },
  nodes: [
    { id: 'list', do: 'tool', tool: 'glob', args: { pattern: { $state: 'pattern' } }, out: { files: 'lines' } },
    {
      id: 'read',
      do: 'map',
      over: 'files',
      body: { do: 'tool', tool: 'read', args: { file_path: { $state: 'item' } }, out: { contents: 'text' } },
    },
    {
      id: 'extract',
      do: 'map',
      over: 'contents',
      body: {
        do: 'model',
        prompt: ['Extract topic, claim and risk as JSON. Topic: ', { $state: 'item' }],
        schema: {
          type: 'object',
          required: ['topic', 'claim', 'risk'],
          properties: {
            topic: { type: 'string' },
            claim: { type: 'string' },
            risk: { type: 'string' },
          },
        },
        out: { extracts: 'json' },
      },
    },
    {
      id: 'join',
      do: 'model',
      prompt: ['Make an outline from these extracts:\n', { $state: 'extracts' }],
      out: { outline: 'text' },
    },
  ],
  edges: [
    { from: 'START', to: 'list' },
    { from: 'list', to: 'read' },
    { from: 'read', to: 'extract' },
    { from: 'extract', to: 'join' },
    { from: 'join', to: 'END' },
  ],
  output: ['extracts', 'outline'],
})

/**
 * The model-facing manual. The guide teaches the whole contract; the reference
 * below is the vocabulary and the examples are archetypes. Read it in that order.
 */
const GUIDE = `
A composed graph is a contract about seams.

You are the author, not the compiler. You are writing down what must remain true between
the moments that cannot be undone: a file has been read, a judgment has been made, a
human has signed, a list has been worked through. The state is the ledger that survives
those moments. A node is a role that reads the ledger and files one result. An edge is a
handoff: it says which role may act next, or which question decides the route. A map is
one role repeated over a list. A gate is a signature. A transform is the form a result
takes when it is filed. The compiler is a clerk: it turns the contract into a LangGraph
exactly as written, with no interpretation, no model and no creativity. Write it so a
careful colleague could execute it without asking what you meant.

Start from the ledger, not the boxes. Ask what must still be true after each phase: the
files that were found, the extracted facts, the outline, the decision, the text that will
be written. Those are the state fields. Their types and reducers are the ledger's rules
for what a value is and how many writers may settle it; the law below states them
exactly. The shape of the ledger will usually tell you the shape of the graph before you
draw a single edge.

Then find the seams. A seam is a place where the next step cannot be decided in advance:
a judgment that changes the route, a list that must be worked in parallel, a human
signature, a pause that must survive a restart. Seams are the only reasons to draw an
edge. Everything between two seams is one role. Put open-ended work in an agent's prose
brief; let the role carry the detail. A fine graph is justified only when the step itself
is the contract; otherwise the graph is a ceremony around a loop. Start coarse; split only
where a seam demands it.

The rest is bookkeeping with consequences. A tool node is a direct call; a model node is
one judgment; an agent is an open brief; a subagent is a separate session; a gate is a
signature. The edges decide sequence, choice, fan-out and join; a map expands one role
over a list; the join is where the ledger settles. The law below is the part you may not
reinterpret: it fixes the state vocabulary, the reducers, the node contracts, the edge
rules, the map and gate semantics, the failure result and the limits. The reference after
it is only the vocabulary; the examples are archetypes, not templates. If a case is not in
them, reason from the ledger, the seams, the roles and the forms. The plugin's source is
an implementation of this contract, not a second manual.
`.trim()

const LAW = `
Article 1. State.
1.1 A state field MUST declare type and default, and the default MUST match the type.
1.2 The types are string, number, boolean, json, string[], number[]. A json default may be
any JSON value.
1.3 The reducers are replace, append, add, max, min, merge; replace is the default.
1.4 append MUST be used only with string[], number[], or a json field whose default is an
array. A json field with default [] and append collects one value per item, including
objects.
1.5 add, max and min MUST be used only with number.
1.6 merge MUST be used only with json. It shallow-merges objects (...left, ...right) and
MUST NOT be read as array concatenation.
1.7 A state field written by a map body or by parallel branches MUST have a mergeable
reducer. A map body MUST NOT write a field whose reducer is replace.
1.8 A $state reference MUST name a top-level field; a dotted path enters a json field only.

Article 2. Nodes.
2.1 A node id MUST be unique, MUST NOT equal a state field name, and MUST NOT be __start__,
__end__ or __interrupt__.
2.2 A tool node MUST name a tool visible to the calling agent. Its args are the DSH tool's
own args, passed through unchanged (glob {pattern}, read {file_path}, write {file_path, content});
the compiler MUST NOT rename or wrap them. Args may contain JSON literals or $state
references.
2.3 A model node MUST have a prompt; prompt is an array of strings and $state references.
schema, when present, MUST be a JSON Schema object and asks for a JSON reply.
2.4 An agent node MUST have a prompt and tools; the prompt is a prose brief and the
compiler MUST NOT inspect it.
2.5 A subagent node MUST have a prompt; it runs in a child DSH session; schema is optional.
2.6 A gate MUST have a question and MAY have options. options are labels shown to the user
and MUST NOT be treated as the resume value. out transforms apply to the raw resume value.
2.7 A map MUST have over, a string[] or number[] state field that the author controls. A
tool result such as "No files found" is one string, not an empty list. The body MUST be one
of tool, model, agent, subagent; it MUST NOT be a gate or a nested map. The body reads item
and index; its out fields MUST write mergeable parent fields. A body id is optional and
ignored.
2.8 A set node MUST have values; values are literals or $state references; there is no
arithmetic.
2.9 A node's out MUST map state fields to transforms; a transform MUST fit the field type.

Article 3. Edges and control.
3.1 START MUST have no incoming edges; END MUST have no outgoing edges. A START edge MUST
be unconditional.
3.2 A node's outgoing edges MUST be exactly one of: one unconditional edge (sequence); one
or more conditional edges (choice), evaluated in order, with a when: true fallback; two or
more unconditional edges (static fan-out). Conditional and unconditional out-edges MUST
NOT be mixed.
3.3 A node with multiple incoming edges MUST wait for all of them.
3.4 A cycle MUST have a way out and a budget via maxSteps; the whole SCC is one recovery
unit.

Article 4. Gates and resume.
4.1 A gate pauses the run with {question, options, node}; langgraph_run returns status
"interrupted" with the thread and interrupts.
4.2 To resume, the caller MUST call langgraph_run({graph, thread, resume: <raw answer>}) on
the same thread. The resume value is the user's raw answer.
4.3 For a label answer, the spec MUST file text and route with an eq guard. For a yes/no,
it MAY file bool; bool accepts only a JSON boolean or the text "true"/"false".

Article 5. Maps.
5.1 append order is the input order, not the completion order.
5.2 An empty array MUST send one sentinel item so the join runs; the graph continues with
the aggregate defaults.
5.3 The compiler expands a map into <id>__fanout, <id> and <id>__join. The join follows
the spec's out-edges.
5.4 maxItems defaults to 50 and is capped at 100; a longer array fails and MUST NOT be
truncated.
5.5 maxConcurrency defaults to 8 and is capped at 16; the strictest map cap is applied as
the whole run's cap.

Article 6. Transforms and guards.
6.1 The transforms are text (string), lines (string[]), json (json), bool (boolean;
accepts a JSON boolean or text "true"/"false"), number (number), first (first line or item
as string), count (number of lines or items).
6.2 A transform MUST fit the field type; a model with a string schema MAY write json into
a string field; a map body MAY write a scalar into an array field with append.
6.3 A guard is true, false, or {op, args} with eq, ne, in, gt, gte, lt, lte, exists, and,
or, not. There is no expression string and no eval. A missing value or type mismatch makes
the comparison false.

Article 7. Failure and recovery.
7.1 A failed run returns status "failed" with failedNode, failedScc, pending, downstream,
upstream, lastSupersteps, error (with itemIndex for a map item), state and hint.
7.2 Resume a transient error with the same thread; edit and replay a state error; fork the
downstream or SCC for a graph bug.
7.3 The runtime MUST NOT mutate a spec. A changed contract is a new spec and a new thread;
at-least-once applies.

Article 8. Limits.
8.1 Nodes 64; edges 128; state fields 64; spec JSON 256 KiB; maxSteps 1-200 (default 25);
map maxItems 1-100 (default 50); map maxConcurrency 1-16 (default 8); specs per session 64.
`.trim()

/** Short IR topology for `validate`, which does not build a LangGraph. */
function irTopology(spec) {
  return {
    nodes: spec.nodes.map(node => ({
      id: node.id,
      do: node.do,
      ...(node.do === 'tool' ? { tool: node.tool } : {}),
    })),
    edges: spec.edges.map(edge => ({
      from: edge.from,
      to: edge.to,
      ...(edge.when === undefined ? {} : { when: edge.when }),
    })),
  }
}

/** The on-demand IR manual. */
function describe() {
  return {
    ir: IR_VERSION,
    guide: GUIDE,
    law: LAW,
    reference: {
      topLevel: {
        ir: IR_VERSION,
        'name?': 'non-empty human label; part of the content id',
        'description?': 'non-empty human label; part of the content id',
        state: 'object: field name -> StateField',
        nodes: `array of 1..${LIMITS.nodes} nodes`,
        edges: `array of 1..${LIMITS.edges} edges`,
        'output?': 'state field names returned to the caller; omit for all fields',
        'maxSteps?': `integer 1..${LIMITS.maxSteps}; default ${LIMITS.defaultMaxSteps}`,
      },
      stateField: {
        type: STATE_TYPES,
        default: 'required; must match the type',
        'reducer?': `${REDUCERS.join(' | ')}; replace is the default`,
      },
      nodes: {
        tool: {
          id: 'string',
          do: 'tool',
          tool: 'a tool visible to this agent',
          args: 'passed unchanged to the DSH tool: use the tool\'s own argument names (glob {pattern}, read {path}, write {path, content}); values may be JSON literals or { $state: "field" } references',
          out: 'state field -> transform',
        },
        model: {
          id: 'string',
          do: 'model',
          prompt: 'array of strings and { $state: "field" } references',
          'system?': 'string',
          'schema?': 'JSON Schema for a JSON reply',
          out: 'state field -> transform',
        },
        agent: {
          id: 'string',
          do: 'agent',
          prompt: 'array of strings and { $state: "field" } references; a prose brief',
          tools: 'tool names visible to this agent',
          out: 'state field -> transform',
        },
        gate: {
          id: 'string',
          do: 'gate',
          question: 'string',
          'options?': 'array of labels shown to the user; labels are not the answer',
          out: 'state field -> transform applied to the raw resume value',
        },
        map: {
          id: 'string',
          do: 'map',
          over: 'a string[] or number[] state field; it must be a list you control, and a tool result such as "No files found" is one string, not an empty list',
          body: `one of ${MAP_BODY_KINDS.join(' | ')}; the body reads { $state: "item" } and { $state: "index" } and writes parent fields with mergeable reducers; a body id is optional and ignored`,
          'maxItems?': `integer 1..${LIMITS.maxMapItems}; default ${LIMITS.defaultMapItems}`,
          'maxConcurrency?': `integer 1..${LIMITS.maxMapConcurrency}; default ${LIMITS.defaultMaxConcurrency}`,
        },
        set: {
          id: 'string',
          do: 'set',
          values: 'object of JSON literals or { $state: "field" } references',
        },
        subagent: {
          id: 'string',
          do: 'subagent',
          prompt: 'array of strings and { $state: "field" } references; the child gets its own DSH session',
          'schema?': 'JSON Schema for structured output',
          out: 'state field -> transform',
        },
      },
      edge: {
        from: 'START or a node id',
        to: 'a node id or END',
        'when?': 'true | false | { op, args }',
      },
      transforms: {
        text: 'string',
        lines: 'string[]',
        json: 'json',
        bool: 'boolean (JSON true/false or the text "true"/"false")',
        number: 'number',
        first: 'first line or item (string)',
        count: 'number of lines or items (number)',
      },
      guards: GUARD_OPS,
      limits: LIMITS,
    },
    examples: {
      'scan-and-decide': EXAMPLE,
      'map-gate-write': MAP_GATE_WRITE_EXAMPLE,
      'map-extract': MAP_EXTRACT_EXAMPLE,
    },
  }
}

/**
 * Read a spec file from the session workspace. The path must stay inside the
 * cwd after symlink resolution; a session without a cwd must pass `spec`.
 */
async function readSpecFile(pathArg, cwd) {
  if (typeof cwd !== 'string' || cwd === '') {
    return { error: 'the calling session has no cwd; read the file and pass its JSON as `spec` instead' }
  }
  if (isAbsolute(pathArg)) return { error: '`path` must be relative to the session workspace' }
  if (!pathArg.endsWith('.json')) return { error: '`path` must point at a .json file (`.lg.json` by convention)' }
  const file = resolve(cwd, pathArg)
  const rel = relative(cwd, file)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return { error: '`path` must stay inside the session workspace' }
  }
  let realRoot
  let realFile
  let info
  try {
    realRoot = await realpath(cwd)
    realFile = await realpath(file)
    info = await stat(realFile)
  } catch (error) {
    return { error: `cannot read "${pathArg}": ${error?.message ?? error}` }
  }
  const realRel = relative(realRoot, realFile)
  if (realRel === '' || realRel.startsWith('..') || isAbsolute(realRel)) {
    return { error: '`path` must stay inside the session workspace' }
  }
  if (!realFile.endsWith('.json')) return { error: '`path` must point at a .json file (`.lg.json` by convention)' }
  if (!info.isFile()) return { error: `"${pathArg}" is not a file` }
  if (info.size > LIMITS.specBytes) {
    return { error: `"${pathArg}" is ${info.size} bytes; the spec limit is ${LIMITS.specBytes}` }
  }
  let text
  try {
    text = await readFile(realFile, 'utf8')
  } catch (error) {
    return { error: `cannot read "${pathArg}": ${error?.message ?? error}` }
  }
  text = text.replace(/^\uFEFF/, '')
  try {
    return { spec: JSON.parse(text), source: text }
  } catch (error) {
    return { error: `"${pathArg}" is not JSON: ${error?.message ?? error}` }
  }
}

/**
 * Create the compose tool.
 * @param {object} deps - `ensureSpecStore`, `ensureSaver`, `topologyOf`,
 *   `withThreadLock`, `getVisibleTools`, `getSessionId`, `getCwd`.
 * @returns {(args: object, exec: object) => Promise<object>} the tool executor.
 */
export function createComposeTool(deps) {
  const {
    ensureSpecStore,
    ensureSaver,
    topologyOf,
    withThreadLock,
    getVisibleTools = () => [],
    getSessionId = () => undefined,
    getCwd = () => undefined,
    readStateOf,
  } = deps

  function sessionOf(exec) {
    const sessionId = getSessionId(exec)
    return typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
  }

  function graphArg(args) {
    return typeof args?.graph === 'string' ? args.graph.trim() : ''
  }

  async function loadSpec(args, exec) {
    const hasSpec = args?.spec !== undefined
    const hasPath = typeof args?.path === 'string' && args.path.trim() !== ''
    if (hasSpec && hasPath) return { error: 'pass either `spec` or `path`, not both' }
    if (hasSpec) {
      if (!isPlainObject(args.spec)) return { error: '`spec` must be a GraphSpec JSON object' }
      return { spec: args.spec, source: args.spec }
    }
    if (hasPath) return await readSpecFile(args.path.trim(), getCwd(exec))
    return { error: 'pass `spec` (the GraphSpec object) or `path` (a .json file in the session workspace)' }
  }

  async function list(exec, args) {
    const sessionId = sessionOf(exec)
    if (sessionId === undefined) return { error: 'listing composed graphs needs a calling session' }
    const store = await ensureSpecStore()
    const specs = store.listSpecs(sessionId, {
      ...(Number.isInteger(args?.limit) ? { limit: args.limit } : {}),
    })
    const { store: saver, durable } = await ensureSaver()
    const counts = new Map()
    if (saver !== undefined && typeof saver.listThreads === 'function') {
      for (const row of saver.listThreads({ sessionId })) {
        if (typeof row.graph === 'string') counts.set(row.graph, (counts.get(row.graph) ?? 0) + 1)
      }
    }
    return {
      graphs: specs.map(spec => ({ ...spec, threads: counts.get(spec.id) ?? 0 })),
      durable,
    }
  }

  async function get(exec, args) {
    const sessionId = sessionOf(exec)
    if (sessionId === undefined) return { error: 'reading a composed graph needs a calling session' }
    const id = graphArg(args)
    if (id === '') return { error: '`graph` is required to read a composed graph' }
    const store = await ensureSpecStore()
    const spec = store.getSpec(id, sessionId)
    if (spec === undefined) return { error: `no composed graph "${id}" in this session` }
    return {
      graph: id,
      spec,
      input: inputSchemaOf(spec),
      ...(typeof spec.name === 'string' ? { name: spec.name } : {}),
      ...(typeof spec.description === 'string' ? { description: spec.description } : {}),
    }
  }

  async function remove(exec, args) {
    const sessionId = sessionOf(exec)
    if (sessionId === undefined) return { error: 'deleting a composed graph needs a calling session' }
    const id = graphArg(args)
    if (id === '') return { error: '`graph` is required to delete a composed graph' }
    const store = await ensureSpecStore()
    const spec = store.getSpec(id, sessionId)
    if (spec === undefined) return { error: `no composed graph "${id}" in this session` }

    const { store: saver } = await ensureSaver()
    const threads = saver === undefined || typeof saver.listThreads !== 'function'
      ? []
      : saver.listThreads({ graph: id, sessionId })
    if (threads.length > 0 && args?.delete_threads !== true) {
      return { error: `graph "${id}" has ${threads.length} thread(s); pass \`delete_threads: true\` to delete them too` }
    }
    for (const row of threads) {
      await withThreadLock(row.thread, () => saver.forgetThreadRecords(row.thread))
    }
    const result = await store.deleteSpec(id, sessionId)
    if (!result.deleted) {
      return { error: result.reason === 'owner' ? `graph "${id}" belongs to another session` : `no composed graph "${id}" in this session` }
    }
    return { deleted: id, threadsDeleted: threads.length }
  }

  async function fork(exec, args) {
    const sessionId = sessionOf(exec)
    if (sessionId === undefined) return { error: 'forking a composed graph needs a calling session' }
    const id = graphArg(args)
    if (id === '') return { error: '`graph` is required to fork a composed graph' }
    const from = typeof args?.from === 'string' ? args.from.trim() : ''
    if (from === '') return { error: '`from` is required: the failed node to fork from' }
    const store = await ensureSpecStore()
    const spec = store.getSpec(id, sessionId)
    if (spec === undefined) return { error: `no composed graph "${id}" in this session` }
    const analysis = analyze(spec)
    if (!analysis.nodes.has(from)) {
      return { error: `"${from}" is not a node in "${id}"`, nodes: [...analysis.nodes.keys()].sort() }
    }

    const scc = [...analysis.sccs[analysis.sccOf.get(from)]]
    const reachable = downstreamOf(analysis, scc)
    const downstreamNodes = reachable.filter(node => analysis.nodes.has(node))
    const downstreamSet = new Set(downstreamNodes)
    const upstream = upstreamOf(analysis, [from]).filter(node => node !== from && !scc.includes(node))
    // START points at the failed region's external entries; a loop with no
    // external entry (a disconnected cycle) starts at the failed node.
    const externalEntries = downstreamNodes.filter(node =>
      (analysis.incoming.get(node) ?? []).some(edge => !downstreamSet.has(edge.from)))
    const entries = externalEntries.length > 0 ? externalEntries : [from]

    const forkSpec = {
      ir: spec.ir,
      name: `${spec.name ?? 'graph'} (fork)`,
      description: `${spec.description ?? 'A composed graph'} (forked downstream of ${from})`,
      state: JSON.parse(JSON.stringify(spec.state)),
      nodes: spec.nodes
        .filter(node => downstreamSet.has(node.id))
        .map(node => JSON.parse(JSON.stringify(node))),
      edges: [
        ...entries.map(node => ({ from: START, to: node })),
        ...spec.edges
          .filter(edge => downstreamSet.has(edge.from) && (edge.to === END || downstreamSet.has(edge.to)))
          .map(edge => JSON.parse(JSON.stringify(edge))),
      ],
      ...(Array.isArray(spec.output) ? { output: [...spec.output] } : {}),
      ...(Number.isInteger(spec.maxSteps) ? { maxSteps: spec.maxSteps } : {}),
    }
    const validation = validateSpec(forkSpec, { tools: getVisibleTools(exec) })
    let state
    if (typeof args?.thread === 'string' && args.thread.trim() !== '' && typeof readStateOf === 'function') {
      try {
        state = await readStateOf(id, args.thread.trim(), sessionId)
      } catch (error) {
        return { error: `cannot read thread "${args.thread.trim()}": ${error?.message ?? error}` }
      }
    }
    return {
      graph: id,
      from,
      failedScc: scc,
      downstream: reachable,
      upstream,
      ...(state === undefined ? {} : { state }),
      ok: validation.ok,
      errors: validation.errors,
      warnings: validation.warnings,
      spec: forkSpec,
      hint: 'Edit the spec, then call compose; run the new graph with the current state as input.',
    }
  }

  return async function composeGraph(args, exec) {
    const action = typeof args?.action === 'string' ? args.action.trim() : ''
    if (action === 'describe') return describe()
    if (!COMPOSE_ACTIONS.includes(action)) {
      return { error: `unknown action "${action || '(missing)'}"; expected ${COMPOSE_ACTIONS.join(', ')}` }
    }
    if (action === 'list') return await list(exec, args)
    if (action === 'get') return await get(exec, args)
    if (action === 'delete') return await remove(exec, args)
    if (action === 'fork') return await fork(exec, args)

    if (action === 'compose') {
      const sessionId = sessionOf(exec)
      if (sessionId === undefined) return { error: 'composing a graph needs a calling session' }
      const loaded = await loadSpec(args, exec)
      if (loaded.error !== undefined) return { error: loaded.error }
      const validation = validateSpec(loaded.spec, { tools: getVisibleTools(exec) })
      if (!validation.ok) return { ok: false, errors: validation.errors, warnings: validation.warnings }

      const id = specId(loaded.spec)
      const entry = {
        id,
        ...(typeof loaded.spec.name === 'string' ? { name: loaded.spec.name } : {}),
        ...(typeof loaded.spec.description === 'string' ? { description: loaded.spec.description } : {}),
        input: inputSchemaOf(loaded.spec),
        build: api => buildSpecGraph(api, loaded.spec),
      }
      try {
        // Build once to prove the spec compiles; the reply shows the IR
        // topology, not the compiler's hidden map fanout/join nodes.
        await topologyOf(entry)
      } catch (error) {
        return {
          ok: false,
          errors: [{ path: '', message: `the spec did not build: ${error?.message ?? error}` }],
          warnings: validation.warnings,
        }
      }
      const store = await ensureSpecStore()
      let saved
      try {
        saved = await store.save(loaded.spec, { sessionId, source: loaded.source })
      } catch (error) {
        return { error: error?.message ?? String(error) }
      }
      return {
        ok: true,
        graph: saved.id,
        ...(typeof loaded.spec.name === 'string' ? { name: loaded.spec.name } : {}),
        ...(typeof loaded.spec.description === 'string' ? { description: loaded.spec.description } : {}),
        input: inputSchemaOf(loaded.spec),
        topology: irTopology(loaded.spec),
        created: saved.created,
        warnings: validation.warnings,
        hint: `Run it with \`langgraph_run({ graph: "${saved.id}" })\`; inspect threads with \`langgraph_threads\`.`,
      }
    }

    // validate: parse and check, but do not store or build a LangGraph.
    const loaded = await loadSpec(args, exec)
    if (loaded.error !== undefined) return { error: loaded.error }
    const validation = validateSpec(loaded.spec, { tools: getVisibleTools(exec) })
    return {
      ok: validation.ok,
      errors: validation.errors,
      warnings: validation.warnings,
      ...(validation.ok ? { topology: irTopology(loaded.spec) } : {}),
    }
  }
}
