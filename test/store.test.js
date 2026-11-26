import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Annotation, END, START, StateGraph, getStore } from '@langchain/langgraph'
import { DshStore, STORE_DOMAIN, openDshStore } from '../dsh-store.js'

/** A minimal in-memory stand-in for one domain table. */
function createTable() {
  const records = new Map()
  return {
    get: key => records.get(key),
    entries: () => records.entries(),
    keys: () => records.keys(),
    get size() { return records.size },
    async put(key, value) {
      records.set(key, structuredClone(value))
    },
    async delete(key) {
      return records.delete(key)
    },
  }
}

/** A minimal stand-in for `ctx.storageDomain`. */
function createStorageDomain() {
  const opened = []
  const tables = new Map()
  return {
    opened,
    async open(spec) {
      assert.equal(spec, STORE_DOMAIN)
      opened.push(spec)
      return {
        table(name) {
          if (!tables.has(name)) tables.set(name, createTable())
          return tables.get(name)
        },
        async close() {},
      }
    },
  }
}

async function createStore() {
  const storage = createStorageDomain()
  const { store } = await openDshStore(storage)
  return { store, storage }
}

test('round-trips an item through the BaseStore API', async () => {
  const { store } = await createStore()
  await store.put(['memories', 'agent-1'], 'preference', { language: 'zh', tone: 'concise' })

  const item = await store.get(['memories', 'agent-1'], 'preference')
  assert.equal(item.key, 'preference')
  assert.deepEqual(item.namespace, ['memories', 'agent-1'])
  assert.deepEqual(item.value, { language: 'zh', tone: 'concise' })
  assert.ok(item.createdAt instanceof Date)
  assert.ok(item.updatedAt instanceof Date)
  assert.equal(await store.get(['memories', 'agent-1'], 'missing'), null)
})

test('keeps createdAt and advances updatedAt on overwrite', async () => {
  const { store } = await createStore()
  await store.put(['m'], 'k', { value: 1 })
  const first = await store.get(['m'], 'k')
  await new Promise(resolve => setTimeout(resolve, 5))
  await store.put(['m'], 'k', { value: 2 })

  const second = await store.get(['m'], 'k')
  assert.deepEqual(second.value, { value: 2 })
  assert.equal(second.createdAt.getTime(), first.createdAt.getTime())
  assert.ok(second.updatedAt.getTime() > first.updatedAt.getTime())
})

test('deletes one item without touching its neighbours', async () => {
  const { store } = await createStore()
  await store.put(['m'], 'a', { keep: true })
  await store.put(['m'], 'b', { remove: true })

  await store.delete(['m'], 'b')
  assert.equal(await store.get(['m'], 'b'), null)
  assert.deepEqual((await store.get(['m'], 'a')).value, { keep: true })
})

test('searches a namespace prefix with filters and pagination', async () => {
  const { store } = await createStore()
  await store.put(['notes', 'alpha'], 'one', { kind: 'task', weight: 1, meta: { pinned: true } })
  await store.put(['notes', 'alpha'], 'two', { kind: 'task', weight: 5, meta: { pinned: false } })
  await store.put(['notes', 'beta'], 'three', { kind: 'memo', weight: 3 })
  await store.put(['other'], 'four', { kind: 'task', weight: 9 })

  const tasks = await store.search(['notes'], { filter: { kind: 'task' } })
  assert.deepEqual(tasks.map(item => item.key).sort(), ['one', 'two'])

  const heavy = await store.search(['notes'], { filter: { weight: { $gte: 5 } } })
  assert.deepEqual(heavy.map(item => item.key), ['two'])

  const nested = await store.search(['notes'], { filter: { 'meta.pinned': true } })
  assert.deepEqual(nested.map(item => item.key), ['one'])

  const excluded = await store.search(['notes'], { filter: { kind: { $ne: 'task' } } })
  assert.deepEqual(excluded.map(item => item.key), ['three'])

  const page = await store.search(['notes'], { limit: 1, offset: 1 })
  assert.equal(page.length, 1)
  assert.equal((await store.search(['notes'])).length, 3)
})

test('orders search results newest first', async () => {
  const { store } = await createStore()
  await store.put(['m'], 'old', { n: 1 })
  await new Promise(resolve => setTimeout(resolve, 5))
  await store.put(['m'], 'new', { n: 2 })

  const items = await store.search(['m'])
  assert.deepEqual(items.map(item => item.key), ['new', 'old'])
})

test('rejects vector search instead of returning unranked rows', async () => {
  const { store } = await createStore()
  await store.put(['m'], 'a', { text: 'hello' })
  await assert.rejects(store.search(['m'], { query: 'hello' }), /vector search is not implemented/)
})

test('lists namespaces with prefix, suffix and depth conditions', async () => {
  const { store } = await createStore()
  await store.put(['users', 'alice', 'notes'], 'a', { n: 1 })
  await store.put(['users', 'bob', 'notes'], 'b', { n: 2 })
  await store.put(['users', 'bob', 'tasks'], 'c', { n: 3 })
  await store.put(['teams', 'core'], 'd', { n: 4 })

  assert.deepEqual(await store.listNamespaces({ prefix: ['users'] }), [
    ['users', 'alice', 'notes'],
    ['users', 'bob', 'notes'],
    ['users', 'bob', 'tasks'],
  ])
  assert.deepEqual(await store.listNamespaces({ suffix: ['notes'] }), [
    ['users', 'alice', 'notes'],
    ['users', 'bob', 'notes'],
  ])
  assert.deepEqual(await store.listNamespaces({ maxDepth: 2 }), [
    ['teams', 'core'],
    ['users', 'alice'],
    ['users', 'bob'],
  ])
  assert.deepEqual(await store.listNamespaces({ limit: 1, offset: 1 }), [['users', 'alice', 'notes']])
})

test('batch aligns get, put, search and list results', async () => {
  const { store } = await createStore()
  await store.put(['m'], 'a', { n: 1 })

  const results = await store.batch([
    { namespace: ['m'], key: 'a' },
    { namespace: ['m'], key: 'b', value: { n: 2 } },
    { namespacePrefix: ['m'], limit: 10, offset: 0 },
    { matchConditions: [{ matchType: 'prefix', path: ['m'] }], limit: 10, offset: 0 },
  ])
  assert.equal(results[0].value.n, 1)
  assert.equal(results[1], undefined)
  assert.equal(results[2].length, 2)
  assert.deepEqual(results[3], [['m']])
})

test('rejects values the domain cannot store and unsafe keys', async () => {
  const { store } = await createStore()
  await assert.rejects(store.put([], 'k', { n: 1 }), /namespace.*(not be empty|cannot be empty)/i)
  await assert.rejects(store.put(['m'], 'k', ['array']), /plain JSON object/)
  await assert.rejects(store.put(['m'], '', { n: 1 }), /key must be a non-empty string/)
  await assert.rejects(store.put(['__proto__'], 'k', { n: 1 }), /namespace/)
  const circular = {}
  circular.self = circular
  await assert.rejects(store.put(['m'], 'circular', circular), /JSON-serializable/)
})

test('a compiled graph reaches the store through getStore(config)', async () => {
  const { store } = await createStore()
  const State = Annotation.Root({
    reply: Annotation({ reducer: (_left, right) => right, default: () => '' }),
  })
  const graph = new StateGraph(State)
    .addNode('remember', async (_state, config) => {
      const scoped = getStore(config)
      await scoped.put(['memories'], 'fact', { text: 'langgraph' })
      return { reply: (await scoped.get(['memories'], 'fact')).value.text }
    })
    .addEdge(START, 'remember')
    .addEdge('remember', END)
    .compile({ store })

  assert.deepEqual(await graph.invoke({}), { reply: 'langgraph' })
  assert.deepEqual((await store.get(['memories'], 'fact')).value, { text: 'langgraph' })
})

test('opens the declared domain and exposes a working DshStore', async () => {
  const storage = createStorageDomain()
  const handle = await openDshStore(storage)
  assert.ok(handle.store instanceof DshStore)
  assert.equal(storage.opened.length, 1)
  await handle.store.put(['m'], 'k', { n: 1 })
  assert.equal((await handle.store.get(['m'], 'k')).value.n, 1)
  await handle.close()
})
