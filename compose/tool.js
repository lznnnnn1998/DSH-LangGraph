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
  GUARD_OPS,
  IR_VERSION,
  LIMITS,
  REDUCERS,
  STATE_TYPES,
  TRANSFORMS,
} from './constants.js'
import { buildSpecGraph } from './build.js'
import { inputSchemaOf } from './resolve.js'
import { validateSpec } from './schema.js'
import { specId } from './specs.js'
import { isPlainObject } from './template.js'

/** Actions this tool version accepts. */
export const COMPOSE_ACTIONS = Object.freeze(['describe', 'validate', 'compose', 'list', 'get', 'delete'])

/** A small, valid spec returned by `describe`. */
const EXAMPLE = Object.freeze({
  ir: 1,
  name: 'scan-and-decide',
  description: 'Scan once, make one judgment, ask before continuing.',
  state: {
    pattern: { type: 'string', default: '**/*.js' },
    files: { type: 'string[]', default: [] },
    large: { type: 'boolean', default: false },
    approved: { type: 'boolean', default: false },
  },
  nodes: [
    { id: 'scan', do: 'tool', tool: 'glob', args: { pattern: { $state: 'pattern' } }, out: { files: 'lines' } },
    {
      id: 'judge',
      do: 'model',
      prompt: ['There are ', { $state: 'files' }, '. Is this a large project? Reply true or false.'],
      out: { large: 'bool' },
    },
    { id: 'confirm', do: 'gate', question: 'Continue with this project?', out: { approved: 'bool' } },
  ],
  edges: [
    { from: 'START', to: 'scan' },
    { from: 'scan', to: 'judge' },
    { from: 'judge', to: 'confirm', when: { op: 'eq', args: [{ $state: 'large' }, true] } },
    { from: 'judge', to: 'END', when: true },
    { from: 'confirm', to: 'END' },
  ],
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
      'reducer?': `${REDUCERS.join(' | ')}; replace is the default`,
    },
    nodes: {
      tool: {
        id: 'string',
        do: 'tool',
        tool: 'a tool visible to this agent',
        args: 'object of JSON literals, or { $state: "field" } references',
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
        'options?': 'array of option labels',
        out: 'state field -> transform',
      },
      set: {
        id: 'string',
        do: 'set',
        values: 'object of JSON literals or { $state: "field" } references',
      },
    },
    edge: {
      from: 'START or a node id',
      to: 'a node id or END',
      'when?': 'true | false | { op, args }',
    },
    transforms: TRANSFORMS,
    guards: GUARD_OPS,
    limits: LIMITS,
    example: EXAMPLE,
    guidance: [
      'Coarse-first: aim for 4-8 phase nodes, not one node per tool call.',
      'Open work -> agent (a prose brief plus tools); one judgment -> model; a human decision -> gate; a known atomic action -> tool.',
      'Put "how" in the node brief and "what/when" in the edges.',
      'Use { $state: "field" } references; dotted paths only enter json fields.',
      'A transform must fit the field type: text->string, lines->string[], json->json, bool->boolean, number->number, first->string, count->number.',
      'Edges: one unconditional = sequence; conditional in order = choice (add a when:true fallback); two or more unconditional = static fan-out, and a node with multiple incoming edges waits for all of them.',
      'START has no incoming edges; END has no outgoing edges; do not mix conditional and unconditional out-edges from one node.',
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

  return async function composeGraph(args, exec) {
    const action = typeof args?.action === 'string' ? args.action.trim() : ''
    if (action === 'describe') return describe()
    if (!COMPOSE_ACTIONS.includes(action)) {
      return { error: `unknown action "${action || '(missing)'}"; expected ${COMPOSE_ACTIONS.join(', ')}` }
    }
    if (action === 'list') return await list(exec, args)
    if (action === 'get') return await get(exec, args)
    if (action === 'delete') return await remove(exec, args)

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
      let topology
      try {
        topology = await topologyOf(entry)
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
        input: topology.input,
        topology: { nodes: topology.nodes, edges: topology.edges },
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
