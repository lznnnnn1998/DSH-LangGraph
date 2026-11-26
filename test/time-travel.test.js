import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../index.js'
import { createContext, createStorageDomain, exec, fixture } from './support/harness.js'

async function setup() {
  const storage = createStorageDomain()
  const ctx = createContext(storage)
  apply(ctx, { graphs: [{ id: 'time-travel', module: fixture('time-travel.js') }] })
  return { storage, ctx, run: ctx.tools.get('langgraph_run'), threads: ctx.tools.get('langgraph_threads') }
}

test('lists checkpoint history, edits a checkpoint, and replays from it', async () => {
  const { ctx, run, threads } = await setup()

  const first = await run.execute({ graph: 'time-travel', input: { value: 10 } }, exec())
  assert.equal(first.status, 'completed')
  assert.equal(first.state.value, 11)
  const thread = first.thread
  assert.ok(thread, 'the run starts a durable thread')

  const history = await threads.execute({ action: 'history', graph: 'time-travel', thread }, exec())
  assert.equal(history.graph, 'time-travel')
  assert.ok(history.checkpoints.length >= 2)
  const beforeStep = history.checkpoints.find(entry => entry.next.includes('step'))
  assert.ok(beforeStep, 'a checkpoint before the step is in history')
  assert.equal(beforeStep.step, 0)

  const atCheckpoint = await threads.execute(
    { action: 'state', graph: 'time-travel', thread, checkpoint: beforeStep.checkpoint },
    exec(),
  )
  assert.equal(atCheckpoint.checkpoint, beforeStep.checkpoint)
  assert.equal(atCheckpoint.values.value, 10)
  assert.deepEqual(atCheckpoint.next, ['step'])

  const edited = await threads.execute({
    action: 'edit',
    graph: 'time-travel',
    thread,
    checkpoint: beforeStep.checkpoint,
    values: { value: 100 },
  }, exec())
  assert.ok(edited.checkpoint)
  assert.notEqual(edited.checkpoint, beforeStep.checkpoint)
  assert.equal(edited.editedFrom, beforeStep.checkpoint)
  assert.equal(edited.values.value, 100)
  assert.deepEqual(edited.next, ['step'])

  const replayed = await run.execute({ graph: 'time-travel', thread, checkpoint: edited.checkpoint }, exec())
  assert.equal(replayed.status, 'completed')
  assert.equal(replayed.mode, 'replay')
  assert.equal(replayed.checkpoint, edited.checkpoint)
  assert.equal(replayed.state.value, 101)
  assert.equal(replayed.state.runs, 1)

  ctx.dispose()
})

test('history honours the limit and reports checkpoint metadata', async () => {
  const { ctx, run, threads } = await setup()
  const first = await run.execute({ graph: 'time-travel', input: { value: 1 } }, exec())

  const limited = await threads.execute(
    { action: 'history', graph: 'time-travel', thread: first.thread, limit: 1 },
    exec(),
  )
  assert.equal(limited.checkpoints.length, 1)
  assert.equal(limited.checkpoints[0].paused, false)
  assert.equal(typeof limited.checkpoints[0].source, 'string')

  // A non-positive limit falls back to the default instead of returning nothing.
  const negative = await threads.execute(
    { action: 'history', graph: 'time-travel', thread: first.thread, limit: -1 },
    exec(),
  )
  assert.ok(negative.checkpoints.length >= 2)
  ctx.dispose()
})

test('rejects a missing checkpoint, a checkpoint without a thread, and bad edit values', async () => {
  const { ctx, run, threads } = await setup()
  const first = await run.execute({ graph: 'time-travel', input: { value: 1 } }, exec())

  const orphan = await run.execute({ graph: 'time-travel', checkpoint: 'nope' }, exec())
  assert.match(orphan.error, /requires `thread`/)

  const missing = await run.execute({ graph: 'time-travel', thread: first.thread, checkpoint: 'nope' }, exec())
  assert.match(missing.error, /not found/)

  const state = await threads.execute(
    { action: 'state', graph: 'time-travel', thread: first.thread, checkpoint: 'nope' },
    exec(),
  )
  assert.match(state.error, /not found/)

  const bad = await threads.execute({
    action: 'edit',
    graph: 'time-travel',
    thread: first.thread,
    values: ['not', 'an', 'object'],
  }, exec())
  assert.match(bad.error, /JSON object/)

  ctx.dispose()
})
