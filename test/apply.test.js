import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../index.js'
import { DOMAIN } from '../dsh-checkpointer.js'
import { STORE_DOMAIN, openDshStore } from '../dsh-store.js'

/** A minimal in-memory stand-in for one domain table. */
function createTable() {
  const records = new Map()
  return {
    get: key => records.get(key),
    entries: () => records.entries(),
    keys: () => records.keys(),
    async put(key, value) {
      records.set(key, structuredClone(value))
    },
    async delete(key) {
      return records.delete(key)
    },
    async deleteMany(keys) {
      let removed = 0
      for (const key of keys) if (records.delete(key)) removed += 1
      return removed
    },
    async update(key, update) {
      if (!records.has(key)) throw new Error(`missing-key: ${key}`)
      const next = update(structuredClone(records.get(key)))
      records.set(key, structuredClone(next))
      return next
    },
  }
}

/** A storage domain that serves both the checkpoint and the long-term store domains. */
function createStorageDomain() {
  const tables = new Map()
  const opened = []
  return {
    opened,
    async open(spec) {
      assert.ok(spec === DOMAIN || spec === STORE_DOMAIN, `unexpected domain: ${spec?.name}`)
      opened.push(spec.name)
      return {
        table(name) {
          const key = `${spec.name}/${name}`
          if (!tables.has(key)) tables.set(key, createTable())
          return tables.get(key)
        },
        async close() {},
      }
    },
  }
}

/** A context with just the services `apply` touches. */
function createContext(storageDomain) {
  const tools = new Map()
  const disposers = []
  const ctx = {
    effect(factory) {
      const disposer = factory()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    get(service) {
      return service === 'storageDomain' ? storageDomain : undefined
    },
    logger: { warn() {} },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      definitions: () => [],
      execute: async () => {
        throw new Error('this test graph does not call DSH tools')
      },
    },
    dispose() {
      for (const disposer of disposers.reverse()) disposer()
    },
  }
  ctx.tools = Object.assign(ctx.tools, { get: name => tools.get(name) })
  return ctx
}

/** Absolute file URL path for a fixture module. */
function fixture(name) {
  return new URL(`./fixtures/${name}`, import.meta.url).pathname
}

test('apply gives a graph a durable, shared BaseStore', async () => {
  const storage = createStorageDomain()
  const ctx = createContext(storage)
  apply(ctx, { graphs: [{ id: 'store-wired', module: fixture('store-wired.js') }] })

  const run = ctx.tools.get('langgraph_run')
  assert.ok(run, 'langgraph_run is registered')
  const result = await run.execute({ graph: 'store-wired' }, { agent: { id: 'session-1' } })

  assert.equal(result.status, 'completed')
  assert.equal(result.state.value, 42)
  assert.equal(result.state.same, true)
  assert.deepEqual(storage.opened.sort(), ['langgraph_checkpoints', 'langgraph_store'])

  // The write outlived the run: a fresh handle over the same domain sees it.
  const handle = await openDshStore(storage)
  assert.deepEqual((await handle.store.get(['wired'], 'answer')).value, { value: 42 })
  await handle.close()
  ctx.dispose()
})

test('config.store: false passes no store and opens no store domain', async () => {
  const storage = createStorageDomain()
  const ctx = createContext(storage)
  apply(ctx, { store: false, graphs: [{ id: 'store-wired', module: fixture('store-wired.js') }] })

  const result = await ctx.tools.get('langgraph_run').execute({ graph: 'store-wired' }, { agent: { id: 'session-1' } })
  assert.equal(result.status, 'completed')
  assert.equal(result.state.value, -1)
  assert.deepEqual(storage.opened, ['langgraph_checkpoints'])
  ctx.dispose()
})
