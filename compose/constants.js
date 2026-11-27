/**
 * Constants shared by the GraphSpec IR compiler.
 *
 * The IR is deliberately small and closed: a model can learn it from one
 * `langgraph_compose({ action: 'describe' })` reply, and the compiler translates
 * it without a model, randomness, or I/O.
 */

/** IR version this compiler reads. */
export const IR_VERSION = 1

/** Pseudo-node that starts a graph. */
export const START = 'START'

/** Pseudo-node that ends a graph. */
export const END = 'END'

/** Node kinds this compiler version can build. */
export const NODE_KINDS = Object.freeze(['tool', 'model', 'agent', 'gate', 'map', 'set', 'subagent'])

/** Node kinds allowed inside a `map` body. A gate and a nested map are not. */
export const MAP_BODY_KINDS = Object.freeze(['tool', 'model', 'agent', 'subagent'])

/** State field types. There is no `any`: every value has a declared shape. */
export const STATE_TYPES = Object.freeze(['string', 'number', 'boolean', 'json', 'string[]', 'number[]'])

/** Reducers a state field may use. `replace` is the default. */
export const REDUCERS = Object.freeze(['replace', 'append', 'add', 'max', 'min', 'merge'])

/** Result transforms a node applies before writing a state field. */
export const TRANSFORMS = Object.freeze(['text', 'lines', 'json', 'bool', 'number', 'first', 'count'])

/** Guard operators. There is no expression string and no `eval`. */
export const GUARD_OPS = Object.freeze(['eq', 'ne', 'in', 'gt', 'gte', 'lt', 'lte', 'exists', 'and', 'or', 'not'])

/** Hard budgets. A spec past these is rejected, never truncated. */
export const LIMITS = Object.freeze({
  nodes: 64,
  edges: 128,
  stateFields: 64,
  specBytes: 256 * 1024,
  defaultMaxSteps: 25,
  maxSteps: 200,
  defaultMapItems: 50,
  maxMapItems: 100,
  defaultMaxConcurrency: 8,
  maxMapConcurrency: 16,
})

/** The fields each node kind may carry; anything else is a typo and rejected. */
export const NODE_FIELDS = Object.freeze({
  tool: Object.freeze(['id', 'do', 'tool', 'args', 'out']),
  model: Object.freeze(['id', 'do', 'prompt', 'system', 'schema', 'out']),
  agent: Object.freeze(['id', 'do', 'prompt', 'tools', 'out']),
  gate: Object.freeze(['id', 'do', 'question', 'options', 'out']),
  map: Object.freeze(['id', 'do', 'over', 'body', 'maxItems', 'maxConcurrency']),
  set: Object.freeze(['id', 'do', 'values']),
  subagent: Object.freeze(['id', 'do', 'prompt', 'schema', 'out']),
})

/** Fields a map body may carry; its `id` is optional and ignored. */
export const MAP_BODY_FIELDS = Object.freeze({
  tool: Object.freeze(['id', 'do', 'tool', 'args', 'out']),
  model: Object.freeze(['id', 'do', 'prompt', 'system', 'schema', 'out']),
  agent: Object.freeze(['id', 'do', 'prompt', 'tools', 'out']),
  subagent: Object.freeze(['id', 'do', 'prompt', 'schema', 'out']),
})

/** The JSON type a transform produces. */
export const TRANSFORM_TYPES = Object.freeze({
  text: 'string',
  lines: 'string[]',
  json: 'json',
  bool: 'boolean',
  number: 'number',
  first: 'string',
  count: 'number',
})

/** Whether a reducer can combine concurrent writes. */
export function isMergeableReducer(reducer) {
  return reducer !== undefined && reducer !== 'replace'
}
