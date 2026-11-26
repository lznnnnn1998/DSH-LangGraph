import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../index.js'
import { openDshStore } from '../dsh-store.js'
import { createContext, createStorageDomain, exec, fixture } from './support/harness.js'

test('apply gives a graph a durable, shared BaseStore', async () => {
  const storage = createStorageDomain()
  const ctx = createContext(storage)
  apply(ctx, { graphs: [{ id: 'store-wired', module: fixture('store-wired.js') }] })

  const run = ctx.tools.get('langgraph_run')
  assert.ok(run, 'langgraph_run is registered')
  const result = await run.execute({ graph: 'store-wired' }, exec())

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

  const result = await ctx.tools.get('langgraph_run').execute({ graph: 'store-wired' }, exec())
  assert.equal(result.status, 'completed')
  assert.equal(result.state.value, -1)
  assert.deepEqual(storage.opened, ['langgraph_checkpoints'])
  ctx.dispose()
})
