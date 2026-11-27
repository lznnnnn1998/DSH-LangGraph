import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { apply } from '../index.js'
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

function branchSpec() {
  return {
    ir: 1,
    name: 'branch',
    state: {
      go: { type: 'boolean', default: false },
      ran: { type: 'string', default: '' },
    },
    nodes: [
      { id: 'route', do: 'set', values: {} },
      { id: 'yes', do: 'set', values: { ran: 'yes' } },
      { id: 'no', do: 'set', values: { ran: 'no' } },
    ],
    edges: [
      { from: 'START', to: 'route' },
      { from: 'route', to: 'yes', when: { op: 'eq', args: [{ $state: 'go' }, true] } },
      { from: 'route', to: 'no', when: true },
      { from: 'yes', to: 'END' },
      { from: 'no', to: 'END' },
    ],
  }
}

function setup(options = {}) {
  const storage = createStorageDomain()
  const ctx = createContext(storage, options)
  apply(ctx, { prompt: false, ui: false })
  ctx.tools.definitions = () => [{ name: 'glob' }, { name: 'read' }]
  ctx.tools.execute = async ({ calls }) => {
    const name = calls[0]?.name
    if (name === 'glob') {
      return { results: [{ result: { content: [{ type: 'text', text: 'a.js\nb.js' }] } }] }
    }
    throw new Error(`unexpected tool ${name}`)
  }
  return {
    storage,
    ctx,
    compose: ctx.tools.get('langgraph_compose'),
    run: ctx.tools.get('langgraph_run'),
    threads: ctx.tools.get('langgraph_threads'),
  }
}

test('composes and runs a graph that interrupts and resumes', async () => {
  const { ctx, compose, run } = setup()
  const composed = await compose.execute({ action: 'compose', spec: fixture('approval-gate') }, exec('session-1'))
  assert.equal(composed.ok, true)

  const first = await run.execute({ graph: composed.graph }, exec('session-1'))
  assert.equal(first.status, 'interrupted')
  assert.ok(Array.isArray(first.interrupts))
  assert.match(first.interrupts[0].value.question, /Scan the workspace/)
  assert.ok(first.thread)

  const resumed = await run.execute({
    graph: composed.graph,
    thread: first.thread,
    resume: true,
  }, exec('session-1'))
  assert.equal(resumed.status, 'completed')
  assert.equal(resumed.state.approved, true)
  assert.equal(resumed.state.listing, 'a.js\nb.js')
  ctx.dispose()
})

test('composes, runs, and time-travels a composed graph', async () => {
  const { ctx, compose, run, threads } = setup()
  const composed = await compose.execute({ action: 'compose', spec: branchSpec() }, exec('session-1'))
  assert.equal(composed.ok, true)

  const first = await run.execute({ graph: composed.graph, input: { go: true } }, exec('session-1'))
  assert.equal(first.status, 'completed')
  assert.equal(first.state.ran, 'yes')
  const thread = first.thread

  const history = await threads.execute({ action: 'history', graph: composed.graph, thread }, exec('session-1'))
  assert.equal(history.graph, composed.graph)
  const before = history.checkpoints.find(entry => entry.next.includes('route'))
  assert.ok(before, 'the checkpoint before the route is in history')

  const atCheckpoint = await threads.execute({
    action: 'state',
    graph: composed.graph,
    thread,
    checkpoint: before.checkpoint,
  }, exec('session-1'))
  assert.equal(atCheckpoint.values.go, true)

  const edited = await threads.execute({
    action: 'edit',
    graph: composed.graph,
    thread,
    checkpoint: before.checkpoint,
    values: { go: false },
  }, exec('session-1'))
  assert.ok(edited.checkpoint)
  assert.deepEqual(edited.next, ['route'])

  const replayed = await run.execute({
    graph: composed.graph,
    thread,
    checkpoint: edited.checkpoint,
  }, exec('session-1'))
  assert.equal(replayed.status, 'completed')
  assert.equal(replayed.mode, 'replay')
  assert.equal(replayed.state.ran, 'no')
  ctx.dispose()
})

test('runs a composed graph as a background job', async () => {
  const { ctx, compose, run } = setup({ jobs: true })
  const composed = await compose.execute({ action: 'compose', spec: minimal('background') }, exec('session-1'))
  const started = await run.execute({ graph: composed.graph, run_in_background: true }, exec('session-1'))
  assert.equal(started.kind, 'background')
  assert.equal(started.status, 'started')
  assert.ok(started.jobId)

  const outcome = await ctx.jobs.runs.get(started.jobId)
  assert.equal(outcome.status, 'completed')
  const parsed = JSON.parse(outcome.result)
  assert.equal(parsed.status, 'completed')
  assert.equal(parsed.state.text, 'hi')
  ctx.dispose()
})

test('rejects a composed graph from another session or an unknown id', async () => {
  const { ctx, compose, run } = setup()
  const composed = await compose.execute({ action: 'compose', spec: minimal('owned') }, exec('session-1'))

  const denied = await run.execute({ graph: composed.graph }, exec('session-2'))
  assert.match(denied.error, /unknown or not owned composed graph/)

  const missing = await run.execute({ graph: 'lg_adhoc_missing' }, exec('session-1'))
  assert.match(missing.error, /unknown or not owned composed graph/)
  ctx.dispose()
})

test('lists composed graphs when langgraph_run is called without an id', async () => {
  const { ctx, compose, run } = setup()
  const composed = await compose.execute({ action: 'compose', spec: minimal('listed') }, exec('session-1'))
  const listed = await run.execute({}, exec('session-1'))
  assert.match(listed.answer, /Composed graphs in this session:/)
  assert.match(listed.answer, new RegExp(composed.graph))
  assert.match(listed.answer, /\(listed\)/)
  ctx.dispose()
})

test('runs composed graphs without a storage domain', async () => {
  const ctx = createContext(undefined)
  apply(ctx, { prompt: false, ui: false })
  ctx.tools.definitions = () => []
  const composed = await ctx.tools.get('langgraph_compose').execute({
    action: 'compose',
    spec: minimal('memory'),
  }, exec())
  assert.equal(composed.ok, true)

  const ran = await ctx.tools.get('langgraph_run').execute({ graph: composed.graph }, exec())
  assert.equal(ran.status, 'completed')
  assert.equal(ran.state.text, 'hi')
  ctx.dispose()
})
