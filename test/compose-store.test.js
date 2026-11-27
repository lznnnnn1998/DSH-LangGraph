import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  MAX_SPECS_PER_SESSION,
  SPEC_PREFIX,
  createMemorySpecStore,
  isSpecId,
  openSpecStore,
  specId,
} from '../compose/specs.js'
import { createStorageDomain } from './support/harness.js'

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

test('hashes a spec into a stable, content-addressed id', () => {
  const spec = fixture('scan-report')
  const id = specId(spec)
  assert.ok(id.startsWith(SPEC_PREFIX))
  assert.equal(id.length, SPEC_PREFIX.length + 24)
  assert.equal(isSpecId(id), true)
  assert.equal(isSpecId('scan-report'), false)
  assert.equal(specId(spec), id)

  // Key order is normalized; a content change is a new id.
  const reordered = JSON.parse(JSON.stringify(spec))
  const firstNode = reordered.nodes[0]
  reordered.nodes[0] = { out: firstNode.out, args: firstNode.args, tool: firstNode.tool, do: firstNode.do, id: firstNode.id }
  assert.equal(specId(reordered), id)

  const renamed = JSON.parse(JSON.stringify(spec))
  renamed.name = 'scan-report-2'
  assert.notEqual(specId(renamed), id)
})

test('saves, reads, lists and deletes a durable spec', async () => {
  const storage = createStorageDomain()
  const { store, close } = await openSpecStore(storage)
  const spec = fixture('scan-report')
  const saved = await store.save(spec, { sessionId: 'session-1', source: '{"ir":1}' })
  assert.equal(saved.created, true)
  assert.equal(saved.id, specId(spec))
  assert.equal(store.count('session-1'), 1)
  assert.equal(store.count('session-2'), 0)

  const record = store.getRecord(saved.id, 'session-1')
  assert.deepEqual(record.spec, spec)
  assert.equal(record.source, '{"ir":1}')
  assert.equal(record.sessionId, 'session-1')
  assert.equal(typeof record.createdAt, 'number')
  assert.equal(record.compilerVersion, 1)

  assert.deepEqual(store.getSpec(saved.id, 'session-1'), spec)
  assert.equal(store.getSpec(saved.id, 'session-2'), undefined)
  assert.equal(store.getSpec(saved.id, undefined), undefined)
  assert.deepEqual(store.listSpecs('session-1').map(row => row.id), [saved.id])
  assert.equal(store.listSpecs('session-1')[0].name, 'scan-report')
  assert.deepEqual(store.listSpecs('session-2'), [])

  // The returned spec is a copy: a caller cannot mutate the stored graph.
  const copy = store.getSpec(saved.id, 'session-1')
  copy.state.files.default.push('mutated')
  assert.deepEqual(store.getSpec(saved.id, 'session-1').state.files.default, [])

  assert.deepEqual(await store.deleteSpec(saved.id, 'session-2'), { deleted: false, reason: 'owner' })
  assert.deepEqual(await store.deleteSpec('lg_adhoc_missing', 'session-1'), { deleted: false, reason: 'missing' })
  assert.deepEqual(await store.deleteSpec(saved.id, 'session-1'), { deleted: true })
  assert.equal(store.getSpec(saved.id, 'session-1'), undefined)
  await close()
})

test('the same spec is idempotent, and another session cannot take its id', async () => {
  const store = createMemorySpecStore()
  const spec = minimal('same')
  const first = await store.save(spec, { sessionId: 'session-1' })
  const second = await store.save(spec, { sessionId: 'session-1' })
  assert.deepEqual(second, { id: first.id, created: false })
  assert.equal(store.count('session-1'), 1)

  await assert.rejects(
    store.save(spec, { sessionId: 'session-2' }),
    /belongs to another session/,
  )
  assert.equal(store.count('session-2'), 0)
  assert.equal(store.getSpec(first.id, 'session-2'), undefined)
})

test('lists newest first and honours the limit', async () => {
  const store = createMemorySpecStore()
  const first = await store.save(minimal('one'), { sessionId: 'session-1' })
  await new Promise(resolve => setTimeout(resolve, 2))
  const second = await store.save(minimal('two'), { sessionId: 'session-1' })
  assert.deepEqual(store.listSpecs('session-1').map(row => row.id), [second.id, first.id])
  assert.deepEqual(store.listSpecs('session-1', { limit: 1 }).map(row => row.id), [second.id])
})

test('rejects invalid specs and caps each session', async () => {
  const store = createMemorySpecStore()
  await assert.rejects(store.save({ ir: 2 }, { sessionId: 'session-1' }), /invalid graph spec/)

  for (let index = 0; index < MAX_SPECS_PER_SESSION; index += 1) {
    await store.save(minimal(`spec-${index}`), { sessionId: 'session-1' })
  }
  assert.equal(store.count('session-1'), MAX_SPECS_PER_SESSION)
  await assert.rejects(
    store.save(minimal('one-too-many'), { sessionId: 'session-1' }),
    /already has 64 composed graphs/,
  )
})

test('survives reopening the durable domain', async () => {
  const storage = createStorageDomain()
  const spec = minimal('durable')
  const first = await openSpecStore(storage)
  const saved = await first.store.save(spec, { sessionId: 'session-1' })
  await first.close()

  const second = await openSpecStore(storage)
  assert.deepEqual(second.store.getSpec(saved.id, 'session-1'), spec)
  assert.deepEqual(second.store.listSpecs('session-1').map(row => row.id), [saved.id])
  await second.close()
})

test('a null owner is readable by any session but still immutable', async () => {
  const store = createMemorySpecStore()
  const saved = await store.save(minimal('shared'), {})
  assert.equal(store.getSpec(saved.id, 'session-1')?.name, 'shared')
  assert.equal(store.getSpec(saved.id, 'session-2')?.name, 'shared')
  assert.equal(store.getSpec(saved.id, 'session-1', { allSessions: true })?.name, 'shared')
})
