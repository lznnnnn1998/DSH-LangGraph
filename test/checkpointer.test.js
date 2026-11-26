import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DshCheckpointSaver, DOMAIN, openCheckpointStore } from '../dsh-checkpointer.js'

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

/** A minimal stand-in for `ctx.storageDomain`. */
function createStorageDomain() {
  const tables = new Map()
  return {
    async open(spec) {
      assert.equal(spec, DOMAIN)
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

/** One realistic checkpoint shape. */
function checkpoint(id = '1f000000-0000-6000-8000-000000000001') {
  return {
    v: 4,
    id,
    ts: new Date().toISOString(),
    channel_values: { messages: ['hello'] },
    channel_versions: { messages: 1 },
    versions_seen: {},
  }
}

test('round-trips a checkpoint and its writes', async () => {
  const { saver } = await openCheckpointStore(createStorageDomain())
  const config = { configurable: { thread_id: 'thread-a' } }
  const written = await saver.put(config, checkpoint(), { source: 'input', step: 0 })
  await saver.putWrites(written, [['messages', ['hello', 'world']]], 'task-1', '')
  const tuple = await saver.getTuple(written)
  assert.deepEqual(tuple.checkpoint.channel_values, { messages: ['hello'] })
  assert.equal(tuple.metadata.step, 0)
  assert.deepEqual(tuple.pendingWrites, [['task-1', 'messages', ['hello', 'world']]])
})

test('keeps thread ownership and counters', async () => {
  const { saver } = await openCheckpointStore(createStorageDomain())
  await saver.claimThread('thread-a', { graph: 'scan-report', sessionId: 'session-1' })
  assert.deepEqual(saver.threadMeta('thread-a'), {
    graph: 'scan-report',
    sessionId: 'session-1',
    createdAt: saver.threadMeta('thread-a').createdAt,
    updatedAt: saver.threadMeta('thread-a').updatedAt,
    checkpoints: 0,
    writes: 0,
  })
  assert.equal(saver.listThreads({ sessionId: 'session-1' }).length, 1)
  assert.equal(saver.listThreads({ sessionId: 'session-2' }).length, 0)

  await assert.rejects(
    saver.claimThread('thread-a', { graph: 'scan-report', sessionId: 'session-2' }),
    /another session/,
  )
  await assert.rejects(
    saver.claimThread('thread-a', { graph: 'ask-tools', sessionId: 'session-1' }),
    /belongs to graph/,
  )
})

test('deletes every record of one thread', async () => {
  const { saver } = await openCheckpointStore(createStorageDomain())
  const config = { configurable: { thread_id: 'thread-a' } }
  const written = await saver.put(config, checkpoint(), { step: 0 })
  await saver.putWrites(written, [['messages', 'x']], 'task-1', '')
  await saver.claimThread('thread-a', { graph: 'scan-report', sessionId: 'session-1' })
  assert.equal(saver.hasThread('thread-a'), true)

  await saver.forgetThreadRecords('thread-a')
  assert.equal(saver.hasThread('thread-a'), false)
  assert.equal(await saver.getTuple(config), undefined)
  assert.deepEqual(saver.listThreads(), [])
})

test('prunes checkpoints beyond the retention window and their writes', async () => {
  const { saver } = await openCheckpointStore(createStorageDomain(), { retention: 2 })
  const config = { configurable: { thread_id: 'thread-a' } }
  const ids = []
  for (let index = 1; index <= 5; index += 1) {
    const id = `1f000000-0000-6000-8000-00000000000${index}`
    ids.push(id)
    const written = await saver.put(config, checkpoint(id), { step: index })
    await saver.putWrites(written, [['messages', [`m${index}`]]], `task-${index}`, '')
  }

  const listed = []
  for await (const tuple of saver.list(config)) listed.push(tuple.checkpoint.id)
  assert.deepEqual(listed, [ids[4], ids[3]], 'only the newest two checkpoints remain')

  assert.deepEqual(await saver.pendingWrites('thread-a', '', ids[0]), [], 'pruned writes are gone')
  assert.equal((await saver.pendingWrites('thread-a', '', ids[4]))[0][2][0], 'm5', 'kept writes remain')

  const meta = saver.threadMeta('thread-a')
  assert.equal(meta.checkpoints, 2)
  assert.equal(meta.writes, 2)
})

test('retention 0 keeps every checkpoint', async () => {
  const { saver } = await openCheckpointStore(createStorageDomain(), { retention: 0 })
  const config = { configurable: { thread_id: 'thread-a' } }
  for (let index = 1; index <= 5; index += 1) {
    await saver.put(config, checkpoint(`1f000000-0000-6000-8000-00000000000${index}`), { step: index })
  }
  let count = 0
  for await (const _tuple of saver.list(config)) count += 1
  assert.equal(count, 5)
  assert.equal(saver.threadMeta('thread-a').checkpoints, 5)
})

test('retention is applied per thread', async () => {
  const { saver } = await openCheckpointStore(createStorageDomain(), { retention: 1 })
  for (const thread of ['thread-a', 'thread-b']) {
    for (let index = 1; index <= 3; index += 1) {
      await saver.put({ configurable: { thread_id: thread } }, checkpoint(`1f000000-0000-6000-8000-00000000000${index}`), { step: index })
    }
  }
  for (const thread of ['thread-a', 'thread-b']) {
    const listed = []
    for await (const tuple of saver.list({ configurable: { thread_id: thread } })) listed.push(tuple.checkpoint.id)
    assert.deepEqual(listed, ['1f000000-0000-6000-8000-000000000003'])
    assert.equal(saver.threadMeta(thread).checkpoints, 1)
  }
})

test('rejects unsafe thread ids', async () => {
  const saver = new DshCheckpointSaver({
    table() {
      return createTable()
    },
  })
  await assert.rejects(saver.getTuple({ configurable: { thread_id: '__proto__' } }), /reserved/)
  assert.throws(() => saver.threadMeta('__proto__'), /reserved/)
})
