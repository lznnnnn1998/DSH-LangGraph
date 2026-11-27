import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as langgraph from '@langchain/langgraph'
import { MemorySaver } from '@langchain/langgraph-checkpoint'
import { apply } from '../index.js'
import { createResolver, inputSchemaOf } from '../compose/resolve.js'
import { createMemorySpecStore, openSpecStore } from '../compose/specs.js'
import { createContext, createStorageDomain, exec } from './support/harness.js'

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/specs/${name}.json`, import.meta.url), 'utf8'))
}

function minimal(name) {
  return {
    ir: 1,
    ...(name === undefined ? {} : { name }),
    state: { text: { type: 'string', default: '' } },
    nodes: [{ id: 'one', do: 'set', values: { text: 'hi' } }],
    edges: [{ from: 'START', to: 'one' }, { from: 'one', to: 'END' }],
  }
}

test('derives an input schema from the state declarations', () => {
  const schema = inputSchemaOf(fixture('scan-report'))
  assert.equal(schema.type, 'object')
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.properties.files, { type: 'array', items: { type: 'string' }, default: [] })
  assert.deepEqual(schema.properties.pattern, { type: 'string', default: '**/*.js' })
  assert.deepEqual(schema.properties.verdict, { type: 'string', default: '' })
})

test('registered graphs win, specs resolve for their owner, and entries cache', async () => {
  const registered = { id: 'registered', description: 'a registered graph', build: () => ({}) }
  const registry = new Map([['registered', registered]])
  const store = createMemorySpecStore()
  const saved = await store.save(minimal('composed'), { sessionId: 'session-1' })
  let reads = 0
  const resolveEntry = createResolver({
    registry,
    getStore: async () => {
      reads += 1
      return store
    },
  })

  assert.equal(await resolveEntry('registered', 'session-1'), registered)
  assert.equal(reads, 0, 'a registered id never opens the spec store')

  const entry = await resolveEntry(saved.id, 'session-1')
  assert.equal(entry.composed, true)
  assert.equal(entry.name, 'composed')
  assert.equal(entry.maxSteps, 25)
  assert.equal(entry.input.additionalProperties, false)
  assert.deepEqual(entry.input.properties.text, { type: 'string', default: '' })
  assert.equal(reads, 1)

  assert.equal(await resolveEntry(saved.id, 'session-1'), entry)
  assert.equal(reads, 1, 'the immutable entry is cached per owner')

  assert.equal(await resolveEntry(saved.id, 'session-2'), undefined)
  assert.equal(reads, 2)
  assert.equal(await resolveEntry('lg_adhoc_missing', 'session-1'), undefined)
  assert.equal(await resolveEntry('not-a-spec-id', 'session-1'), undefined)
})

test('a resolved entry builds and runs the stored spec', async () => {
  const store = createMemorySpecStore()
  const saved = await store.save(minimal('runnable'), { sessionId: 'session-1' })
  const resolveEntry = createResolver({ registry: new Map(), getStore: async () => store })
  const entry = await resolveEntry(saved.id, 'session-1')
  const graph = entry.build({ ...langgraph, helpers: {} })
  const compiled = graph.compile({ checkpointer: new MemorySaver() })
  const state = await compiled.invoke({}, { configurable: { thread_id: 'resolved-entry' } })
  assert.equal(state.text, 'hi')
})

async function seed(storage, spec, sessionId) {
  const opened = await openSpecStore(storage)
  const saved = await opened.store.save(spec, { sessionId })
  await opened.close()
  return saved.id
}

test('langgraph_run and langgraph_threads accept a composed spec id', async () => {
  const storage = createStorageDomain()
  const id = await seed(storage, minimal('applied'), 'session-1')
  const ctx = createContext(storage)
  apply(ctx, { prompt: false, ui: false })
  try {
    const run = ctx.tools.get('langgraph_run')
    assert.ok(run, 'langgraph_run is registered')
    const result = await run.execute({ graph: id }, exec('session-1'))
    assert.equal(result.status, 'completed')
    assert.equal(result.graph, id)
    assert.equal(result.state.text, 'hi')
    assert.match(result.thread, /^lg_lg_adhoc_/)

    const threads = ctx.tools.get('langgraph_threads')
    const topology = await threads.execute({ action: 'topology', graph: id }, exec('session-1'))
    assert.deepEqual(topology.graph, id)
    assert.deepEqual(topology.nodes.map(node => node.id), ['__start__', 'one', '__end__'])
    assert.deepEqual(topology.edges, [
      { source: '__start__', target: 'one' },
      { source: 'one', target: '__end__' },
    ])

    const state = await threads.execute({ action: 'state', graph: id, thread: result.thread }, exec('session-1'))
    assert.equal(state.values.text, 'hi')

    const denied = await run.execute({ graph: id }, exec('session-2'))
    assert.match(denied.error, /unknown or not owned composed graph/)

    const unknown = await run.execute({ graph: 'nope' }, exec('session-1'))
    assert.match(unknown.error, /unknown graph "nope"\. Registered:/)
  } finally {
    ctx.dispose()
  }
})

test('a composed spec carries its maxSteps into the run budget', async () => {
  const storage = createStorageDomain()
  const id = await seed(storage, {
    ir: 1,
    name: 'looping',
    state: { text: { type: 'string', default: '' } },
    nodes: [{ id: 'one', do: 'set', values: { text: 'again' } }],
    edges: [
      { from: 'START', to: 'one' },
      { from: 'one', to: 'one', when: true },
    ],
    maxSteps: 3,
  }, 'session-1')
  const ctx = createContext(storage)
  apply(ctx, { prompt: false, ui: false })
  try {
    await assert.rejects(
      ctx.tools.get('langgraph_run').execute({ graph: id }, exec('session-1')),
      /Recursion limit of 3/,
    )
  } finally {
    ctx.dispose()
  }
})

test('the owner-only topology route resolves a composed spec', async () => {
  const storage = createStorageDomain()
  const id = await seed(storage, minimal('panel'), 'session-1')
  const ctx = createContext(storage, { routes: true })
  apply(ctx, { prompt: false, ui: true })
  try {
    const route = ctx.routes.get('/api/plugins/langgraph/topology')
    assert.ok(route, 'the topology route is registered')
    const response = await route.fetch(
      new Request(`http://127.0.0.1/api/plugins/langgraph/topology?graph=${id}`),
      { principal: { kind: 'owner' } },
    )
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.graph, id)
    assert.deepEqual(body.nodes.map(node => node.id), ['__start__', 'one', '__end__'])
  } finally {
    ctx.dispose()
  }
})
