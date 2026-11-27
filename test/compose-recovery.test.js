import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../index.js'
import { createContext, createStorageDomain, exec } from './support/harness.js'

function setup() {
  const storage = createStorageDomain()
  const ctx = createContext(storage)
  apply(ctx, { prompt: false, ui: false })
  return {
    ctx,
    compose: ctx.tools.get('langgraph_compose'),
    run: ctx.tools.get('langgraph_run'),
    threads: ctx.tools.get('langgraph_threads'),
  }
}

function textResult(text) {
  return { results: [{ result: { content: [{ type: 'text', text }] } }] }
}

function toolError(message) {
  const error = new Error(message)
  error.name = 'ToolError'
  return error
}

function mapSpec() {
  return {
    ir: 1,
    name: 'resumable-map',
    state: {
      files: { type: 'string[]', default: ['a.js', 'b.js'] },
      reports: { type: 'string[]', default: [], reducer: 'append' },
    },
    nodes: [{
      id: 'read',
      do: 'map',
      over: 'files',
      body: {
        do: 'tool',
        tool: 'read',
        args: { path: { $state: 'item' } },
        out: { reports: 'text' },
      },
    }],
    edges: [{ from: 'START', to: 'read' }, { from: 'read', to: 'END' }],
    output: ['reports'],
  }
}

test('resume retries a transient map item on the same thread', async () => {
  const { ctx, compose, run } = setup()
  ctx.tools.definitions = () => [{ name: 'read' }]
  let failedOnce = false
  ctx.tools.execute = async ({ calls }) => {
    const args = JSON.parse(calls[0].arguments)
    if (args.path === 'b.js' && !failedOnce) {
      failedOnce = true
      throw toolError('read: ENOENT')
    }
    return textResult(`${args.path}:content`)
  }
  try {
    const composed = await compose.execute({ action: 'compose', spec: mapSpec() }, exec('session-1'))
    const failed = await run.execute({ graph: composed.graph }, exec('session-1'))
    assert.equal(failed.status, 'failed')
    assert.equal(failed.failedNode, 'read')
    assert.equal(failed.error.itemIndex, 1)
    assert.ok(failed.thread)

    const resumed = await run.execute({ graph: composed.graph, thread: failed.thread }, exec('session-1'))
    assert.equal(resumed.status, 'completed')
    assert.equal(resumed.mode, 'continue')
    assert.deepEqual(resumed.state.reports, ['a.js:content', 'b.js:content'])
    assert.equal(typeof resumed.report.durationMs, 'number')
    assert.equal(typeof resumed.report.steps, 'number')
  } finally {
    ctx.dispose()
  }
})

test('edit the failure checkpoint and replay with the corrected state', async () => {
  const { ctx, compose, run, threads } = setup()
  ctx.tools.definitions = () => [{ name: 'check' }]
  ctx.tools.execute = async ({ calls }) => {
    const args = JSON.parse(calls[0].arguments)
    if (args.go !== true) throw toolError('go is false')
    return textResult('passed')
  }
  try {
    const spec = {
      ir: 1,
      name: 'state-error',
      state: {
        go: { type: 'boolean', default: false },
        ran: { type: 'string', default: '' },
      },
      nodes: [{
        id: 'check',
        do: 'tool',
        tool: 'check',
        args: { go: { $state: 'go' } },
        out: { ran: 'text' },
      }],
      edges: [{ from: 'START', to: 'check' }, { from: 'check', to: 'END' }],
      output: ['go', 'ran'],
    }
    const composed = await compose.execute({ action: 'compose', spec }, exec('session-1'))
    const failed = await run.execute({ graph: composed.graph, input: { go: false } }, exec('session-1'))
    assert.equal(failed.status, 'failed')
    assert.equal(failed.failedNode, 'check')
    assert.ok(failed.checkpoint)

    const edited = await threads.execute({
      action: 'edit',
      graph: composed.graph,
      thread: failed.thread,
      checkpoint: failed.checkpoint,
      values: { go: true },
    }, exec('session-1'))
    assert.ok(edited.checkpoint)
    assert.deepEqual(edited.next, ['check'])

    const replayed = await run.execute({
      graph: composed.graph,
      thread: failed.thread,
      checkpoint: edited.checkpoint,
    }, exec('session-1'))
    assert.equal(replayed.status, 'completed')
    assert.equal(replayed.mode, 'replay')
    assert.equal(replayed.state.go, true)
    assert.equal(replayed.state.ran, 'passed')
  } finally {
    ctx.dispose()
  }
})

function forkableSpec() {
  return {
    ir: 1,
    name: 'forkable',
    state: {
      output: { type: 'string', default: '' },
    },
    nodes: [
      { id: 'prepare', do: 'set', values: { output: 'prepared' } },
      { id: 'fail', do: 'tool', tool: 'boom', args: {}, out: { output: 'text' } },
      { id: 'after', do: 'set', values: { output: 'after' } },
    ],
    edges: [
      { from: 'START', to: 'prepare' },
      { from: 'prepare', to: 'fail' },
      { from: 'fail', to: 'after' },
      { from: 'after', to: 'END' },
    ],
    output: ['output'],
  }
}

test('fork the downstream, edit the tool, compose and run it', async () => {
  const { ctx, compose, run } = setup()
  ctx.tools.definitions = () => [{ name: 'boom' }, { name: 'ok' }]
  ctx.tools.execute = async ({ calls }) => {
    if (calls[0].name === 'boom') throw toolError('boom failed')
    return textResult('fixed')
  }
  try {
    const composed = await compose.execute({ action: 'compose', spec: forkableSpec() }, exec('session-1'))
    const failed = await run.execute({ graph: composed.graph }, exec('session-1'))
    assert.equal(failed.status, 'failed')
    assert.equal(failed.failedNode, 'fail')

    const fork = await compose.execute({
      action: 'fork',
      graph: composed.graph,
      from: failed.failedNode,
      thread: failed.thread,
    }, exec('session-1'))
    assert.equal(fork.ok, true)
    assert.equal(fork.from, 'fail')
    assert.deepEqual(fork.failedScc, ['fail'])
    assert.deepEqual(fork.downstream, ['END', 'after', 'fail'])
    assert.deepEqual(fork.upstream, ['START', 'prepare'])
    assert.deepEqual(fork.spec.nodes.map(node => node.id).sort(), ['after', 'fail'])
    assert.ok(fork.spec.edges.some(edge => edge.from === 'START' && edge.to === 'fail'))
    assert.deepEqual(fork.state, { output: 'prepared' })

    const forked = JSON.parse(JSON.stringify(fork.spec))
    forked.name = 'forked'
    const failedNode = forked.nodes.find(node => node.id === 'fail')
    failedNode.tool = 'ok'
    const composedFork = await compose.execute({ action: 'compose', spec: forked }, exec('session-1'))
    assert.equal(composedFork.ok, true)
    assert.notEqual(composedFork.graph, composed.graph)

    const ran = await run.execute({
      graph: composedFork.graph,
      input: fork.state,
    }, exec('session-1'))
    assert.equal(ran.status, 'completed')
    assert.equal(ran.state.output, 'after')
  } finally {
    ctx.dispose()
  }
})

test('fork keeps a loop SCC as one recovery unit', async () => {
  const { ctx, compose, run } = setup()
  ctx.tools.definitions = () => [{ name: 'tick' }, { name: 'judge' }]
  ctx.tools.execute = async ({ calls }) => {
    const args = JSON.parse(calls[0].arguments)
    return textResult(calls[0].name === 'tick' ? String(args.value + 1) : `note-${args.value}`)
  }
  try {
    const spec = {
      ir: 1,
      name: 'loop',
      state: {
        note: { type: 'string', default: '' },
        attempts: { type: 'number', default: 0 },
      },
      nodes: [
        { id: 'scan', do: 'set', values: { note: 'scan' } },
        { id: 'tick', do: 'tool', tool: 'tick', args: { value: { $state: 'attempts' } }, out: { attempts: 'number' } },
        { id: 'judge', do: 'tool', tool: 'judge', args: { value: { $state: 'attempts' } }, out: { note: 'text' } },
      ],
      edges: [
        { from: 'START', to: 'scan' },
        { from: 'scan', to: 'tick' },
        { from: 'tick', to: 'judge' },
        { from: 'judge', to: 'tick', when: { op: 'lt', args: [{ $state: 'attempts' }, 3] } },
        { from: 'judge', to: 'END', when: true },
      ],
      output: ['note', 'attempts'],
      maxSteps: 20,
    }
    const composed = await compose.execute({ action: 'compose', spec }, exec('session-1'))
    const ran = await run.execute({ graph: composed.graph }, exec('session-1'))
    assert.equal(ran.status, 'completed')
    assert.equal(ran.state.attempts, 3)

    const fork = await compose.execute({
      action: 'fork',
      graph: composed.graph,
      from: 'tick',
      thread: ran.thread,
    }, exec('session-1'))
    assert.equal(fork.ok, true)
    assert.deepEqual(fork.failedScc, ['judge', 'tick'])
    assert.ok(fork.downstream.includes('tick'))
    assert.ok(fork.downstream.includes('judge'))
    assert.ok(fork.downstream.includes('END'))
    assert.deepEqual(fork.upstream, ['START', 'scan'])
    assert.deepEqual(fork.spec.nodes.map(node => node.id).sort(), ['judge', 'tick'])
    assert.ok(fork.spec.edges.some(edge => edge.from === 'START' && edge.to === 'tick'))
    assert.ok(fork.spec.edges.some(edge => edge.from === 'judge' && edge.to === 'tick'))
    assert.deepEqual(fork.state, { note: 'note-3', attempts: 3 })
  } finally {
    ctx.dispose()
  }
})

test('fork rejects another session, a missing source, and an unknown node', async () => {
  const { ctx, compose } = setup()
  ctx.tools.definitions = () => [{ name: 'boom' }]
  ctx.tools.execute = async () => {
    throw toolError('boom')
  }
  try {
    const composed = await compose.execute({ action: 'compose', spec: forkableSpec() }, exec('session-1'))
    const owned = await compose.execute({ action: 'fork', graph: composed.graph, from: 'fail' }, exec('session-2'))
    assert.match(owned.error, /no composed graph/)
    const missing = await compose.execute({ action: 'fork', graph: composed.graph }, exec('session-1'))
    assert.match(missing.error, /`from` is required/)
    const unknown = await compose.execute({ action: 'fork', graph: composed.graph, from: 'nope' }, exec('session-1'))
    assert.match(unknown.error, /not a node/)
    assert.ok(unknown.nodes.includes('fail'))
  } finally {
    ctx.dispose()
  }
})
