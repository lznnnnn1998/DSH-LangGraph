/**
 * Deterministic GraphSpec -> LangGraph StateGraph compiler.
 *
 * The compiler validates the spec, turns every declared state field into an
 * Annotation channel with its reducer, wraps each node executor so errors carry
 * the IR node id, and then emits sequence, choice, or static fan-out edges. It
 * calls no model and performs no I/O; the same spec always produces the same
 * graph.
 */

import { END as SPEC_END, START as SPEC_START } from './constants.js'
import { evaluateGuard } from './guard.js'
import { createRunner } from './nodes.js'
import { assertSpec } from './schema.js'
import { isPlainObject } from './template.js'

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
 * Attach the IR node id to an error without swallowing LangGraph control flow.
 * `is_bubble_up` marks interrupts and recursion errors, which must pass through
 * unchanged for resume and for the run's recursion budget to work.
 */
function annotateError(error, nodeId) {
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
  return wrapped
}

/** Wrap one node executor with error annotation. */
function wrapNode(runner, node) {
  return async state => {
    try {
      return await runner.run(node, state)
    } catch (error) {
      throw annotateError(error, node.id)
    }
  }
}

/** Map an IR target to LangGraph's sentinel. */
function targetOf(id, langGraphEnd) {
  return id === SPEC_END ? langGraphEnd : id
}

/** Emit the spec's edges, one source at a time. */
function connectEdges(graph, spec, langGraphStart, langGraphEnd) {
  const bySource = new Map()
  for (const edge of spec.edges) {
    if (!bySource.has(edge.from)) bySource.set(edge.from, [])
    bySource.get(edge.from).push(edge)
  }
  for (const edge of bySource.get(SPEC_START) ?? []) {
    graph.addEdge(langGraphStart, targetOf(edge.to, langGraphEnd))
  }
  for (const node of spec.nodes) {
    const edges = bySource.get(node.id) ?? []
    if (edges.length === 0) continue
    if (edges.some(edge => edge.when !== undefined)) {
      // Choice: guards are evaluated in the spec's edge order; the first match
      // wins. A spec with no match is a graph bug and fails the run.
      graph.addConditionalEdges(node.id, state => {
        for (const edge of edges) {
          if (edge.when === undefined) continue
          if (evaluateGuard(edge.when, state)) return targetOf(edge.to, langGraphEnd)
        }
        throw new Error(`no outgoing edge matched at node "${node.id}"`)
      })
    } else {
      // Sequence (one edge) or static fan-out (two or more): every successor
      // runs in the same superstep, and LangGraph joins them at a shared target.
      for (const edge of edges) graph.addEdge(node.id, targetOf(edge.to, langGraphEnd))
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
  const { StateGraph, Annotation, START, END } = api
  const State = Annotation.Root(annotationShape(spec, Annotation))
  const graph = new StateGraph(State)
  const runner = createRunner({ helpers: api.helpers, interrupt: api.interrupt })
  for (const node of spec.nodes) graph.addNode(node.id, wrapNode(runner, node))
  connectEdges(graph, spec, START, END)
  return graph
}
