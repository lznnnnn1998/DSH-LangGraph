import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../index.js'
import { createContext, createStorageDomain, exec, fixture } from './support/harness.js'

/** Read one registered route as JSON. */
async function read(ctx, path) {
  const route = ctx.routes.get(path.split('?')[0])
  assert.ok(route, `route ${path} is registered`)
  const response = await route.fetch(new Request(`http://127.0.0.1${path}`), { principal: { kind: 'owner' } })
  return { status: response.status, body: await response.json() }
}

async function setup(config = {}) {
  const storage = createStorageDomain()
  const ctx = createContext(storage, { routes: true })
  apply(ctx, {
    ...config,
    graphs: [
      { id: 'time-travel', module: fixture('time-travel.js') },
      { id: 'conditional', module: fixture('conditional.js') },
    ],
  })
  return { ctx, run: ctx.tools.get('langgraph_run') }
}

test('ui route lists graphs and counts durable threads by graph', async () => {
  const { ctx, run } = await setup()
  const before = await read(ctx, '/api/plugins/langgraph/ui')
  assert.equal(before.status, 200)
  assert.ok(before.body.graphs.some(graph => graph.id === 'time-travel'))
  assert.ok(before.body.graphs.some(graph => graph.id === 'ask-user'), 'ships the example graphs')
  assert.deepEqual(before.body.threads, { total: 0, byGraph: {}, durable: true })

  await run.execute({ graph: 'time-travel', input: { value: 1 } }, exec())
  const after = await read(ctx, '/api/plugins/langgraph/ui')
  assert.deepEqual(after.body.threads, { total: 1, byGraph: { 'time-travel': 1 }, durable: true })
  ctx.dispose()
})

test('topology route returns one graph and rejects bad requests', async () => {
  const { ctx } = await setup()
  const found = await read(ctx, '/api/plugins/langgraph/topology?graph=time-travel')
  assert.equal(found.status, 200)
  assert.deepEqual(found.body.nodes.map(node => node.id), ['__start__', 'step', '__end__'])

  const missing = await read(ctx, '/api/plugins/langgraph/topology')
  assert.equal(missing.status, 400)
  assert.match(missing.body.error, /required/)

  const unknown = await read(ctx, '/api/plugins/langgraph/topology?graph=nope')
  assert.equal(unknown.status, 404)
  assert.match(unknown.body.error, /unknown graph/)
  ctx.dispose()
})

test('config.ui: false registers no routes', async () => {
  const { ctx } = await setup({ ui: false })
  assert.equal(ctx.routes.size, 0)
  ctx.dispose()
})
