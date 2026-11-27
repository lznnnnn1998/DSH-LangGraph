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
      body: { do: 'tool', tool: 'read', args: { path: { $state: 'item' } }, out: { contents: 'text' } },
    },
    { id: 'join', do: 'model', prompt: ['Summarize these files:\n', { $state: 'contents' }], out: { summary: 'text' } },
    { id: 'approve', do: 'gate', question: 'Write the summary?', options: ['Approve', 'Revise'], out: { decision: 'text' } },
    {
      id: 'write',
      do: 'tool',
      tool: 'write',
      args: { path: '.lg-big/summary.md', content: { $state: 'summary' } },
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
      body: { do: 'tool', tool: 'read', args: { path: { $state: 'item' } }, out: { contents: 'text' } },
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
      'reducer?': `${REDUCERS.join(' | ')}; replace is the default; a json list uses append with default []`,
    },
    reducerNotes: {
      append: 'For arrays; a json field with default [] + append collects one value per item (objects included).',
      merge: 'Shallow-merges json objects ({...left, ...right}); it does not concatenate arrays. Use append + default [] to collect a list.',
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
        'options?': 'array of labels shown to the user; labels are not the resume value',
        out: 'state field -> transform applied to the raw resume value',
        resume: 'langgraph_run returns status "interrupted" with { thread, interrupts }; ask the user, then call langgraph_run({ graph, thread, resume: <raw answer> }). For label answers use out { decision: "text" } and an eq guard; bool accepts only true/false.',
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
    transforms: TRANSFORMS,
    transformNotes: {
      bool: 'A JSON boolean or the text "true"/"false" only. A verify-style node that returns a sentence should use `text` plus a guard, or a `model` with a boolean schema.',
    },
    guards: GUARD_OPS,
    limits: LIMITS,
    example: EXAMPLE,
    examples: {
      'map-gate-write': MAP_GATE_WRITE_EXAMPLE,
      'map-extract': MAP_EXTRACT_EXAMPLE,
    },
    guidance: [
      'Coarse-first heuristic: 4-8 phase nodes is a good default, not a rule; the lint warns when a graph is too fine.',
      'Open work -> agent (a prose brief plus tools); one judgment -> model; a human decision -> gate; a known atomic action -> tool. Merge steps unless the step itself is the contract.',
      'Put "how" in the node brief and "what/when" in the edges.',
      'Use { $state: "field" } references; dotted paths only enter json fields.',
      'A transform must fit the field type: text->string, lines->string[], json->json, bool->boolean, number->number, first->string, count->number.',
      '`bool` is strict: only a JSON boolean or the text "true"/"false". A verify node that returns a sentence should use `text` and a guard, or a `model` with a boolean schema.',
      '`glob` returns text: add `out: { files: "lines" }` to make the `string[]` that `map.over` needs. A map body reads `{ $state: "item" }` and writes a parent field with a mergeable reducer; `out: { contents: "text" }` into a `string[]` with `append` adds one string per item.',
      'A `gate` resumes with the raw answer. `options` are labels, not the resume value; for label answers use `out: { decision: "text" }` and an `eq` guard, for true/false use `bool`. The run returns `status: "interrupted"`; ask the user, then resume the same thread.',
      'Edges: one unconditional = sequence; conditional in order = choice (add a when:true fallback); two or more unconditional = static fan-out, and a node with multiple incoming edges waits for all of them.',
      'START has no incoming edges; END has no outgoing edges; do not mix conditional and unconditional out-edges from one node.',
      'Use map for dynamic fan-out over a string[] or number[] field. The body reads { $state: "item" } and { $state: "index" }; its out fields need append/add/max/min/merge reducers, and append order is the input order. `over` must be a list you control: a tool result such as "No files found" is one string, not an empty list.',
      'A tool node\'s args are the exact args you would pass to the DSH tool directly; the compiler does not rename them. A map body uses { $state: "item" } where an arg expects the item, e.g. read { path: { $state: "item" } }.',
      'To collect one JSON object per item, declare `json` with default [] and reducer append; a model body\'s out { extracts: "json" } appends one object per item. `merge` is for merging objects into one, not collecting a list; it does not concatenate arrays. The `map-extract` example is this pattern.',
      'For a write step, name the exact path and content/format in the node brief or args; an agent write may summarize instead of copying. The `map-gate-write` example is the full fine-grained pattern.',
      'Use subagent when the work deserves its own DSH session; prompt is the child task and schema asks for structured output.',
      'After a failure, read failedScc, upstream and downstream from the failure result. To change the graph, call fork with the failed node: it returns the downstream spec and the thread state; edit the spec, compose it, and run it with that state as input.',
      'A composed graph is immutable and session-owned: to change it, compose a new spec and start a new thread.',
      'Run the result with langgraph_run({ graph: "<id>" }); do not invent an id.',
    ],
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
