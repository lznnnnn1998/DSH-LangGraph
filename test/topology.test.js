import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../index.js'
import { createContext, createStorageDomain, exec, fixture } from './support/harness.js'

async function setup() {
  const storage = createStorageDomain()
  const ctx = createContext(storage)
  apply(ctx, {
    graphs: [
      { id: 'time-travel', module: fixture('time-travel.js') },
      { id: 'conditional', module: fixture('conditional.js') },
    ],
  })
  return { ctx, threads: ctx.tools.get('langgraph_threads') }
}

test('topology returns JSON-safe nodes and edges without a thread', async () => {
  const { ctx, threads } = await setup()
  const topology = await threads.execute({ action: 'topology', graph: 'time-travel' }, exec())

  assert.equal(topology.graph, 'time-travel')
  assert.equal(topology.description, 'Increments a value once.')
  assert.deepEqual(topology.input, undefined)
  assert.deepEqual(topology.nodes.map(node => node.id), ['__start__', 'step', '__end__'])
  assert.deepEqual(topology.edges, [
    { source: '__start__', target: 'step' },
    { source: 'step', target: '__end__' },
  ])
  // The response is safe to serialize for a client panel.
  assert.doesNotThrow(() => JSON.stringify(topology))
  ctx.dispose()
})

test('topology names conditional edges and rejects unknown graphs', async () => {
  const { ctx, threads } = await setup()
  const missing = await threads.execute({ action: 'topology', graph: 'nope' }, exec())
  assert.match(missing.error, /unknown graph/)

  const noGraph = await threads.execute({ action: 'topology' }, exec())
  assert.match(noGraph.error, /`graph` is required/)

  const branching = await threads.execute({ action: 'topology', graph: 'conditional' }, exec())
  const conditionalEdges = branching.edges.filter(edge => edge.conditional === true)
  assert.deepEqual(conditionalEdges, [
    { source: 'left', target: 'right', conditional: true },
    { source: 'left', target: '__end__', conditional: true },
  ])
  ctx.dispose()
})
