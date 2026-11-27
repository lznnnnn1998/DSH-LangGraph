/**
 * Deterministic GraphSpec -> LangGraph StateGraph compiler.
 *
 * The compiler validates the spec, turns every declared state field into an
 * Annotation channel with its reducer, wraps each node executor so errors carry
 * the IR node id, and then emits sequence, choice, static fan-out, or map edges.
 * It calls no model and performs no I/O; the same spec always produces the same
 * graph.
 *
 * A `map` is compiled into three nodes: a fanout dispatcher, the item body (the
 * spec's node id), and a join. LangGraph `Send` runs the body once per item; the
 * join runs once after every item and then follows the spec's out-edges, so a
 * guard after a map sees the aggregated state, not one item's state.
 */

import { END as SPEC_END, LIMITS, START as SPEC_START } from './constants.js'
import { evaluateGuard } from './guard.js'
import { createRunner } from './nodes.js'
import { assertSpec } from './schema.js'
import { isPlainObject, renderParts, resolveValue } from './template.js'

/** Clone a JSON default so each channel starts with its own array/object. */
function cloneJson(value) {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value))
}

/** The reducer function for one state field. */
function reducerFor(definition) {
  switch (definition.reducer ?? 'replace') {
    case 'replace':
      return (_current, next) => next
    case 'append':
      return (current, next) => {
        const base = Array.isArray(current) ? current : []
        if (Array.isArray(next)) return base.concat(next)
        return next === undefined ? base : base.concat([next])
      }
    case 'add':
      return (current, next) => (typeof current === 'number' ? current : 0) + (typeof next === 'number' ? next : 0)
    case 'max':
      return (current, next) => Math.max(
        typeof current === 'number' ? current : Number.NEGATIVE_INFINITY,
        typeof next === 'number' ? next : Number.NEGATIVE_INFINITY,
      )
    case 'min':
      return (current, next) => Math.min(
        typeof current === 'number' ? current : Number.POSITIVE_INFINITY,
        typeof next === 'number' ? next : Number.POSITIVE_INFINITY,
      )
    case 'merge':
      return (current, next) => ({
        ...(isPlainObject(current) ? current : {}),
        ...(isPlainObject(next) ? next : {}),
      })
    default:
      throw new Error(`unsupported reducer "${definition.reducer}"`)
  }
}

/** Build Annotation.Root channels from the spec's state. */
function annotationShape(spec, Annotation) {
  const shape = {}
  for (const [field, definition] of Object.entries(spec.state)) {
    shape[field] = Annotation({
      reducer: reducerFor(definition),
      default: () => cloneJson(definition.default),
    })
  }
  return shape
}

/**
 * Attach the IR node id (and, for a map item, its index) to an error without
 * swallowing LangGraph control flow. `is_bubble_up` marks interrupts and
 * recursion errors, which must pass through unchanged for resume and for the
 * run's recursion budget to work.
 */
function annotateError(error, nodeId, itemIndex) {
  if (error !== null && typeof error === 'object') {
    if (error.is_bubble_up === true || error.nodeId !== undefined) return error
  }
  const message = error !== null && typeof error === 'object' && typeof error.message === 'string'
    ? error.message
    : String(error)
  const wrapped = new Error(message)
  if (error !== null && typeof error === 'object') {
    if (typeof error.name === 'string') wrapped.name = error.name
    if (typeof error.code === 'string') wrapped.code = error.code
    wrapped.cause = error
  }
  wrapped.nodeId = nodeId
  wrapped.node = nodeId
  if (itemIndex !== undefined) wrapped.itemIndex = itemIndex
  return wrapped
}

/** Wrap one function with error annotation. */
function wrapFunction(fn, nodeId, itemIndexOf) {
  return async state => {
    try {
      return await fn(state)
    } catch (error) {
      throw annotateError(error, nodeId, itemIndexOf === undefined ? undefined : itemIndexOf(state))
    }
  }
}

/** Wrap one node executor with error annotation. */
function wrapNode(runner, node) {
  return wrapFunction(state => runner.run(node, state), node.id)
}

/** A node id that does not collide with the spec's own ids. */
function uniqueNodeId(base, used) {
  if (!used.has(base)) return base
  let index = 2
  while (used.has(`${base}_${index}`)) index += 1
  return `${base}_${index}`
}

/** Resolve one item's body inputs at dispatch time. */
function mapPayload(body, state) {
  if (body.do === 'tool') return { args: resolveValue(body.args, state) }
  return { prompt: renderParts(body.prompt, state) }
}

/** Plan the hidden nodes for one map. */
function mapPlanOf(spec, node, used) {
  const fanoutId = uniqueNodeId(`${node.id}__fanout`, used)
  used.add(fanoutId)
  const hasOut = spec.edges.some(edge => edge.from === node.id)
  let joinId
  if (hasOut) {
    joinId = uniqueNodeId(`${node.id}__join`, used)
    used.add(joinId)
  }
  return {
    node,
    fanoutId,
    joinId,
    itemType: spec.state[node.over]?.type === 'number[]' ? 'number' : 'string',
  }
}

/** Add the fanout, item body, and join for one map. */
function addMapNodes(graph, plan, runner, Send) {
  if (typeof Send !== 'function') throw new Error('map nodes need LangGraph Send, which this runtime did not provide')
  const { node, fanoutId, joinId, itemType } = plan
  const maxItems = node.maxItems ?? LIMITS.defaultMapItems

  graph.addNode(fanoutId, wrapFunction(async state => {
    const over = state[node.over]
    if (!Array.isArray(over)) {
      throw new Error(`map "${node.id}" needs "${node.over}" to be an array`)
    }
    if (over.length > maxItems) {
      throw new Error(`map "${node.id}" has ${over.length} items; maxItems is ${maxItems}`)
    }
    const itemOk = itemType === 'number'
      ? value => typeof value === 'number' && Number.isFinite(value)
      : value => typeof value === 'string'
    if (!over.every(itemOk)) {
      throw new Error(`map "${node.id}" needs every "${node.over}" item to be a ${itemType}`)
    }
    return {}
  }, node.id))

  // The body receives a small Send payload, not the whole parent state, so a
  // large fan-out does not copy the state once per item.
  graph.addNode(node.id, wrapFunction(
    state => runner.runMapBody(node.body, state, node.id),
    node.id,
    state => state?.__mapIndex,
  ))

  if (joinId !== undefined) graph.addNode(joinId, async () => ({}))

  graph.addConditionalEdges(fanoutId, state => {
    const over = state[node.over]
    const items = Array.isArray(over) ? over : []
    if (items.length === 0) {
      // A sentinel item lets the join run and the graph continue with the
      // aggregate defaults instead of silently ending at an empty fan-out.
      return [new Send(node.id, { __mapEmpty: true })]
    }
    return items.map((item, index) => {
      const synthetic = { ...state, item, index }
      return new Send(node.id, {
        ...mapPayload(node.body, synthetic),
        __mapItem: item,
        __mapIndex: index,
      })
    })
  })

  // Every item schedules the same join; LangGraph runs it once with the
  // aggregated state, and only then evaluates the spec's out-edges.
  if (joinId !== undefined) graph.addEdge(node.id, joinId)
}

/** Emit the spec's edges, one source at a time. */
function connectEdges(graph, spec, langGraphStart, langGraphEnd, plans) {
  const bySource = new Map()
  for (const edge of spec.edges) {
    if (!bySource.has(edge.from)) bySource.set(edge.from, [])
    bySource.get(edge.from).push(edge)
  }
  const sourceOf = id => plans.get(id)?.joinId ?? id
  const targetOf = id => id === SPEC_END
    ? langGraphEnd
    : plans.get(id)?.fanoutId ?? id

  for (const edge of bySource.get(SPEC_START) ?? []) {
    graph.addEdge(langGraphStart, targetOf(edge.to))
  }
  for (const node of spec.nodes) {
    const edges = bySource.get(node.id) ?? []
    if (edges.length === 0) continue
    const source = sourceOf(node.id)
    if (source === node.id && plans.has(node.id)) continue
    if (edges.some(edge => edge.when !== undefined)) {
      // Choice: guards are evaluated in the spec's edge order; the first match
      // wins. A spec with no match is a graph bug and fails the run.
      graph.addConditionalEdges(source, state => {
        for (const edge of edges) {
          if (edge.when === undefined) continue
          if (evaluateGuard(edge.when, state)) return targetOf(edge.to)
        }
        throw new Error(`no outgoing edge matched at node "${node.id}"`)
      })
    } else {
      // Sequence (one edge) or static fan-out (two or more): every successor
      // runs in the same superstep, and LangGraph joins them at a shared target.
      for (const edge of edges) graph.addEdge(source, targetOf(edge.to))
    }
  }
}

/**
 * Compile one spec into an uncompiled StateGraph. The caller compiles it with
 * the run's checkpointer and store, exactly like a registered graph module.
 * @param {object} api - the LangGraph API plus `helpers` and `interrupt`.
 * @param {object} spec - the GraphSpec.
 * @param {{ tools?: string[] | Set<string> }} [options] - visible tool names to check.
 * @returns {object} a StateGraph.
 */
export function buildSpecGraph(api, spec, options = {}) {
  if (api?.helpers === undefined) throw new Error('buildSpecGraph needs api.helpers')
  assertSpec(spec, options)
  const { StateGraph, Annotation, START, END, Send } = api
  const State = Annotation.Root(annotationShape(spec, Annotation))
  const graph = new StateGraph(State)
  const runner = createRunner({ helpers: api.helpers, interrupt: api.interrupt })
  const plans = new Map()
  // Hidden fanout/join ids must not collide with a node id or a state channel:
  // LangGraph refuses a node name that is also a state attribute.
  const usedIds = new Set([
    SPEC_START,
    SPEC_END,
    ...Object.keys(spec.state),
    ...spec.nodes.map(node => node.id),
  ])
  for (const node of spec.nodes) {
    if (node.do === 'map') plans.set(node.id, mapPlanOf(spec, node, usedIds))
  }
  for (const node of spec.nodes) {
    const plan = plans.get(node.id)
    if (plan !== undefined) addMapNodes(graph, plan, runner, Send)
    else graph.addNode(node.id, wrapNode(runner, node))
  }
  connectEdges(graph, spec, START, END, plans)
  return graph
}
