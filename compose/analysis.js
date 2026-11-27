/**
 * Graph analysis for the GraphSpec IR: adjacency, Tarjan SCCs, reachability,
 * writer/reducer checks for static fan-out, and advisory lint.
 *
 * Analysis never mutates a spec and never builds a graph. The compiler uses it
 * for validation; the failure report and the future `fork` action use it to name
 * a failed node's cycle and downstream.
 */

import { END, START } from './constants.js'
import { hasStateKey, isPlainObject } from './template.js'

/** Group edges by source, keeping the spec's edge order. */
function groupBySource(spec) {
  const outgoing = new Map()
  for (const edge of spec.edges ?? []) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, [])
    outgoing.get(edge.from).push(edge)
  }
  return outgoing
}

/** Group edges by target. */
function groupByTarget(spec) {
  const incoming = new Map()
  for (const edge of spec.edges ?? []) {
    if (!incoming.has(edge.to)) incoming.set(edge.to, [])
    incoming.get(edge.to).push(edge)
  }
  return incoming
}

/** Breadth-first reachability over `outgoing` edges. */
function reachable(outgoing, starts) {
  const seen = new Set(starts)
  const queue = [...starts]
  while (queue.length > 0) {
    const id = queue.shift()
    for (const edge of outgoing.get(id) ?? []) {
      if (!seen.has(edge.to)) {
        seen.add(edge.to)
        queue.push(edge.to)
      }
    }
  }
  return seen
}

/** Breadth-first reachability over `incoming` edges. */
function reverseReachable(incoming, starts) {
  const seen = new Set(starts)
  const queue = [...starts]
  while (queue.length > 0) {
    const id = queue.shift()
    for (const edge of incoming.get(id) ?? []) {
      if (!seen.has(edge.from)) {
        seen.add(edge.from)
        queue.push(edge.from)
      }
    }
  }
  return seen
}

/**
 * Tarjan's strongly connected components over the spec's real nodes. START and
 * END are excluded; a self-loop counts as a cycle.
 * @param {Set<string>} nodeIds - real node ids.
 * @param {(id: string) => string[]} successors - sorted successor node ids.
 * @returns {string[][]} SCCs, each sorted, and the list sorted by first member.
 */
function tarjan(nodeIds, successors) {
  let nextIndex = 0
  const index = new Map()
  const low = new Map()
  const stack = []
  const onStack = new Set()
  const components = []

  function connect(id) {
    index.set(id, nextIndex)
    low.set(id, nextIndex)
    nextIndex += 1
    stack.push(id)
    onStack.add(id)
    for (const next of successors(id)) {
      if (!index.has(next)) {
        connect(next)
        low.set(id, Math.min(low.get(id), low.get(next)))
      } else if (onStack.has(next)) {
        low.set(id, Math.min(low.get(id), index.get(next)))
      }
    }
    if (low.get(id) === index.get(id)) {
      const component = []
      let member
      do {
        member = stack.pop()
        onStack.delete(member)
        component.push(member)
      } while (member !== id)
      components.push(component.sort())
    }
  }

  for (const id of [...nodeIds].sort()) {
    if (!index.has(id)) connect(id)
  }
  components.sort((left, right) => left[0].localeCompare(right[0]))
  return components
}

/**
 * Analyze one spec.
 * @param {object} spec - a structurally valid GraphSpec.
 * @returns {object} nodes, adjacency, SCCs, reachability, and the SCC of each node.
 */
export function analyze(spec) {
  const nodes = new Map((spec.nodes ?? []).map(node => [node.id, node]))
  const outgoing = new Map()
  const incoming = new Map()
  for (const id of [START, ...nodes.keys(), END]) {
    outgoing.set(id, [])
    incoming.set(id, [])
  }
  for (const edge of spec.edges ?? []) {
    const sourceExists = outgoing.has(edge.from)
    const targetExists = incoming.has(edge.to)
    if (!sourceExists || !targetExists) continue
    outgoing.get(edge.from).push(edge)
    incoming.get(edge.to).push(edge)
  }

  const nodeSuccessors = id => [...new Set(
    (outgoing.get(id) ?? [])
      .map(edge => edge.to)
      .filter(target => nodes.has(target)),
  )].sort()
  const sccs = tarjan(new Set(nodes.keys()), nodeSuccessors)
  const sccOf = new Map()
  sccs.forEach((component, componentIndex) => {
    for (const id of component) sccOf.set(id, componentIndex)
  })

  return {
    nodes,
    outgoing,
    incoming,
    sccs,
    sccOf,
    reachableFromStart: reachable(outgoing, [START]),
    canReachEnd: reverseReachable(incoming, [END]),
  }
}

/** Whether a node writes a state field through `out`, `set`, or a map body. */
export function writesField(node, field) {
  if (node === undefined || node === null) return false
  if (node.out !== undefined && Object.prototype.hasOwnProperty.call(node.out, field)) return true
  if (node.do === 'set' && isPlainObject(node.values) && Object.prototype.hasOwnProperty.call(node.values, field)) return true
  if (node.do === 'map' && writesField(node.body, field)) return true
  return false
}

/** All node ids reachable from the given node ids, including them and END. */
export function downstreamOf(analysis, ids) {
  const starts = Array.isArray(ids) ? ids : [ids]
  return [...reachable(analysis.outgoing, starts)].sort()
}

/** All node ids that can reach the given node ids, including them and START. */
export function upstreamOf(analysis, ids) {
  const starts = Array.isArray(ids) ? ids : [ids]
  return [...reverseReachable(analysis.incoming, starts)].sort()
}

/**
 * Validate the writer/reducer contract for static fan-out: when one node has
 * two or more unconditional out-edges, every state field written by more than
 * one of those branches must use a mergeable reducer.
 * @param {object} spec - a structurally valid GraphSpec.
 * @param {object} analysis - the result of `analyze(spec)`.
 * @returns {Array<{ path: string, message: string, expected?: string }>} problems.
 */
export function fanOutProblems(spec, analysis) {
  const problems = []
  const state = isPlainObject(spec.state) ? spec.state : {}
  for (const source of [START, ...analysis.nodes.keys()]) {
    const unconditional = (analysis.outgoing.get(source) ?? [])
      .filter(edge => edge.when === undefined)
      .map(edge => edge.to)
    const branches = [...new Set(unconditional)]
      .filter(target => analysis.nodes.has(target))
      .sort()
    if (branches.length < 2) continue
    for (const field of Object.keys(state).sort()) {
      const writers = branches.filter(branch => writesField(analysis.nodes.get(branch), field))
      if (writers.length < 2) continue
      const reducer = state[field]?.reducer ?? 'replace'
      if (reducer !== 'replace') continue
      problems.push({
        path: `state.${field}`,
        message: `field "${field}" is written by parallel branches ${writers.join(', ')} from "${source}" but has no mergeable reducer`,
        expected: 'append | add | max | min | merge',
      })
    }
  }
  return problems
}

/**
 * Advisory lint. None of these block a spec; they name shapes that usually mean
 * the graph is too fine, cannot finish, or has unreachable work.
 * @param {object} spec - a structurally valid GraphSpec.
 * @param {object} analysis - the result of `analyze(spec)`.
 * @returns {Array<{ path: string, message: string, code: string }>} warnings.
 */
export function lintWarnings(spec, analysis) {
  const warnings = []
  const warn = (path, message, code) => warnings.push({ path, message, code })
  const state = isPlainObject(spec.state) ? spec.state : {}

  for (const node of spec.nodes ?? []) {
    if ((analysis.outgoing.get(node.id) ?? []).length === 0) {
      warn(`nodes.${node.id}`, 'node has no outgoing edge; the run ends here — connect it to END for clarity', 'terminal')
    }
  }

  for (const id of [...analysis.nodes.keys()].sort()) {
    if (!analysis.reachableFromStart.has(id)) {
      warn(`nodes.${id}`, 'node is not reachable from START', 'unreachable')
    } else if (!analysis.canReachEnd.has(id)) {
      warn(`nodes.${id}`, 'node cannot reach END', 'dead-end')
    }
  }

  if ((analysis.outgoing.get(START) ?? []).some(edge => edge.to === END)) {
    warn('edges', 'START goes directly to END', 'empty-graph')
  }

  for (const [source, edges] of analysis.outgoing) {
    if (source === END || edges.length === 0) continue
    if (edges.every(edge => edge.when !== undefined) && !edges.some(edge => edge.when === true)) {
      warn(`nodes.${source}`, 'choice has no `when: true` fallback; the run fails if no guard matches', 'no-fallback')
    }
  }

  const numericWriter = node => {
    const fields = []
    if (node?.out !== undefined) fields.push(...Object.keys(node.out))
    if (node?.do === 'set' && isPlainObject(node.values)) fields.push(...Object.keys(node.values))
    if (node?.do === 'map' && node.body?.out !== undefined) fields.push(...Object.keys(node.body.out))
    return fields.some(field => state[field]?.type === 'number')
  }

  for (const component of analysis.sccs) {
    const members = [...component].sort()
    const cyclic = members.length > 1
      || (analysis.outgoing.get(members[0]) ?? []).some(edge => edge.to === members[0])
    if (!cyclic) continue
    warn(`nodes.${members[0]}`, `cycle: ${members.join(', ')}; bounded by maxSteps`, 'cycle')
    const exits = members
      .flatMap(id => analysis.outgoing.get(id) ?? [])
      .filter(edge => !members.includes(edge.to))
    if (!exits.some(edge => edge.when !== undefined)) {
      warn(`nodes.${members[0]}`, 'cycle has no conditional exit; it runs until maxSteps', 'cycle-exit')
    }
    if (!members.some(id => numericWriter(analysis.nodes.get(id)))) {
      warn(`nodes.${members[0]}`, 'cycle has no numeric counter; it may never terminate', 'cycle-counter')
    }
    if (spec.maxSteps === undefined) {
      warn('maxSteps', 'cycle relies on the default 25-step budget; set maxSteps explicitly', 'cycle-budget')
    }
  }

  // --- over-decomposition lint ------------------------------------------------
  // Advisory only. The main failure mode of a composed graph is turning every
  // tool call into a node; these warnings point at an `agent` node or ordinary
  // tools instead.
  const nodes = spec.nodes ?? []
  if (nodes.length > 12) {
    warn('nodes', `${nodes.length} nodes; coarse-first graphs usually use 4-8 phase nodes`, 'too-many-nodes')
  }

  const containsStateRef = value => {
    if (hasStateKey(value)) return true
    if (Array.isArray(value)) return value.some(containsStateRef)
    if (isPlainObject(value)) return Object.values(value).some(containsStateRef)
    return false
  }

  for (const node of nodes) {
    if (node.do === 'tool') {
      const component = analysis.sccs[analysis.sccOf.get(node.id)]
      const cyclic = (component?.length ?? 1) > 1
        || (analysis.outgoing.get(node.id) ?? []).some(edge => edge.to === node.id)
      if (!cyclic && Object.values(node.args ?? {}).every(value => !containsStateRef(value))) {
        warn(`nodes.${node.id}`, 'tool node has only literal arguments and runs once; consider merging it into an agent node', 'literal-tool')
      }
    }
    if (node.do === 'model') {
      const outgoing = analysis.outgoing.get(node.id) ?? []
      if (outgoing.length === 1 && analysis.nodes.get(outgoing[0].to)?.do === 'tool') {
        warn(`nodes.${node.id}`, 'model feeds a single tool node; an agent node usually covers that step better', 'model-then-tool')
      }
    }
  }

  if (nodes.length > 0 && nodes.length <= 2
    && nodes.every(node => node.do !== 'agent' && node.do !== 'gate')
    && nodes.every(node => (analysis.outgoing.get(node.id) ?? []).length <= 1
      && (analysis.incoming.get(node.id) ?? []).length <= 1
      && analysis.reachableFromStart.has(node.id)
      && analysis.canReachEnd.has(node.id))) {
    warn('nodes', 'a one- or two-step linear graph; use ordinary DSH tools instead', 'tiny-graph')
  }

  // Longest chain in the SCC condensation, so a loop counts as one phase.
  const relevant = new Set([...analysis.reachableFromStart].filter(id => analysis.canReachEnd.has(id)))
  const components = analysis.sccs
  const adjacency = components.map(() => new Set())
  for (const [source, edges] of analysis.outgoing) {
    if (!analysis.sccOf.has(source)) continue
    const from = analysis.sccOf.get(source)
    if (!components[from].some(id => relevant.has(id))) continue
    for (const edge of edges) {
      if (!analysis.sccOf.has(edge.to)) continue
      const to = analysis.sccOf.get(edge.to)
      if (from !== to) adjacency[from].add(to)
    }
  }
  const lengths = new Map()
  const longestFrom = index => {
    if (lengths.has(index)) return lengths.get(index)
    let best = 1
    for (const next of adjacency[index]) best = Math.max(best, 1 + longestFrom(next))
    lengths.set(index, best)
    return best
  }
  let longest = { length: 0, index: -1 }
  components.forEach((component, index) => {
    if (!component.some(id => relevant.has(id))) return
    const length = longestFrom(index)
    if (length > longest.length) longest = { length, index }
  })
  if (longest.length > 8) {
    warn(`nodes.${components[longest.index][0]}`, `linear chain of ${longest.length} phases; coarse-first graphs usually use 4-8 nodes`, 'long-chain')
  }

  return warnings
}
