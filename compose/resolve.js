/**
 * Resolve a graph id to a registry entry or a stored composed spec.
 *
 * Registered graphs win, so a profile graph can never be shadowed by a spec.
 * Composed specs carry the same `{ id, description, input, build }` shape the
 * runtime already compiles and runs; the only extra job is an owner check and a
 * per-owner entry cache (specs are immutable).
 */

import { LIMITS } from './constants.js'
import { analyze } from './analysis.js'
import { buildSpecGraph } from './build.js'
import { isSpecId } from './specs.js'

/** JSON Schema of one state field, for the model-facing input hint. */
function fieldSchema(definition) {
  switch (definition.type) {
    case 'string':
      return { type: 'string' }
    case 'number':
      return { type: 'number' }
    case 'boolean':
      return { type: 'boolean' }
    case 'json':
      return {}
    case 'string[]':
      return { type: 'array', items: { type: 'string' } }
    case 'number[]':
      return { type: 'array', items: { type: 'number' } }
    default:
      return {}
  }
}

/**
 * Graph input schema: every state field is optional because its default fills
 * it; the defaults are shown as JSON Schema `default` annotations.
 * @param {object} spec - a GraphSpec.
 * @returns {object} a JSON Schema object.
 */
export function inputSchemaOf(spec) {
  const properties = {}
  for (const [field, definition] of Object.entries(spec.state)) {
    properties[field] = {
      ...fieldSchema(definition),
      ...(definition.default === undefined ? {} : { default: definition.default }),
    }
  }
  return { type: 'object', properties, additionalProperties: false }
}

/**
 * Create the resolver used by `langgraph_run`, `langgraph_threads`, and the
 * topology route.
 * @param {object} options - resolver dependencies.
 * @param {Map<string, object>} options.registry - registered graph entries.
 * @param {() => Promise<object | undefined> | object | undefined} options.getStore - the spec store.
 * @param {Map<string, object>} [options.cache] - owner-qualified entry cache.
 * @returns {(id: string, sessionId: string | undefined, options?: { allSessions?: boolean }) => Promise<object | undefined>} the resolver.
 */
export function createResolver({ registry, getStore, cache = new Map() }) {
  return async function resolveEntry(id, sessionId, options = {}) {
    const registered = registry.get(id)
    if (registered !== undefined) return registered
    if (!isSpecId(id)) return undefined

    const cacheKey = `${options.allSessions === true ? '*' : sessionId ?? ''}\u0000${id}`
    const cached = cache.get(cacheKey)
    if (cached !== undefined) return cached

    const store = await getStore()
    if (store === undefined) return undefined
    const record = store.getRecord(id, sessionId, { allSessions: options.allSessions === true })
    if (record === undefined) return undefined

    const spec = record.spec
    const mapLimits = spec.nodes
      .filter(node => node.do === 'map')
      .map(node => node.maxConcurrency ?? LIMITS.defaultMaxConcurrency)
    const entry = {
      id,
      composed: true,
      spec,
      analysis: analyze(spec),
      ...(typeof spec.name === 'string' ? { name: spec.name } : {}),
      ...(typeof spec.description === 'string' ? { description: spec.description } : {}),
      input: inputSchemaOf(spec),
      build: api => buildSpecGraph(api, spec),
      maxSteps: Number.isInteger(spec.maxSteps) ? spec.maxSteps : LIMITS.defaultMaxSteps,
      // v1 applies the strictest map cap as the run's global LangGraph cap.
      ...(mapLimits.length === 0 ? {} : { maxConcurrency: Math.min(...mapLimits) }),
      ...(Array.isArray(spec.output) ? { output: spec.output } : {}),
    }
    cache.set(cacheKey, entry)
    return entry
  }
}
