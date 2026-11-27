import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../index.js'
import { createContext, createStorageDomain, exec } from './support/harness.js'

function setup(options = {}) {
  const storage = createStorageDomain()
  const ctx = createContext(storage, options)
  apply(ctx, { prompt: false, ui: false })
  return {
    storage,
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

function failingSpec() {
  return {
    ir: 1,
    name: 'failing',
    state: {
      input: { type: 'string', default: 'x' },
      output: { type: 'string', default: '' },
    },
    nodes: [
      { id: 'prepare', do: 'set', values: { output: 'prepared' } },
      { id: 'fail', do: 'tool', tool: 'boom', args: {}, out: { output: 'text' } },
    ],
    edges: [
      { from: 'START', to: 'prepare' },
      { from: 'prepare', to: 'fail' },
      { from: 'fail', to: 'END' },
    ],
    output: ['output'],
  }
}

test('a node failure returns the boundary, dependencies, and bounded state', async () => {
  const { ctx, compose, run } = setup()
  ctx.tools.definitions = () => [{ name: 'boom' }]
  ctx.tools.execute = async ({ calls }) => {
    assert.equal(calls[0].name, 'boom')
    throw toolError('boom failed')
  }
  try {
    const composed = await compose.execute({ action: 'compose', spec: failingSpec() }, exec('session-1'))
    assert.equal(composed.ok, true)
    const failed = await run.execute({ graph: composed.graph }, exec('session-1'))

    assert.equal(failed.status, 'failed')
    assert.equal(failed.durable, true)
    assert.equal(failed.graph, composed.graph)
    assert.ok(failed.thread)
    assert.ok(failed.checkpoint)
    assert.equal(failed.failedNode, 'fail')
    assert.deepEqual(failed.failedScc, ['fail'])
    assert.deepEqual(failed.upstream, ['START', 'prepare'])
    assert.deepEqual(failed.downstream, ['END', 'fail'])
    assert.deepEqual(failed.pending, ['fail'])
    assert.ok(failed.lastSupersteps.length >= 2)
    assert.ok(failed.lastSupersteps[0].next.includes('fail'))
    assert.deepEqual(failed.lastSupersteps[0].values, { output: 'prepared' })
    assert.equal(failed.error.name, 'ToolError')
    assert.equal(failed.error.message, 'boom failed')
    assert.equal(failed.error.node, 'fail')
    assert.deepEqual(failed.state, { output: 'prepared' })
    assert.match(failed.hint, /fork/)
    assert.equal(failed.report, undefined)
  } finally {
    ctx.dispose()
  }
})

test('a map item failure names the map node and item index', async () => {
  const { ctx, compose, run } = setup()
  ctx.tools.definitions = () => [{ name: 'read' }]
  ctx.tools.execute = async ({ calls }) => {
    const args = JSON.parse(calls[0].arguments)
    if (args.path === 'b.js') throw toolError('read: ENOENT')
    return textResult(`${args.path}:content`)
  }
  try {
    const spec = JSON.parse(JSON.stringify({
      ir: 1,
      name: 'map-failure',
      state: {
        files: { type: 'string[]', default: ['a.js', 'b.js'] },
        reports: { type: 'string[]', default: [], reducer: 'append' },
        summary: { type: 'string', default: '' },
      },
      nodes: [
        {
          id: 'read',
          do: 'map',
          over: 'files',
          body: {
            do: 'tool',
            tool: 'read',
            args: { path: { $state: 'item' } },
            out: { reports: 'text' },
          },
        },
        {
          id: 'join',
          do: 'model',
          prompt: ['Combine: ', { $state: 'reports' }],
          out: { summary: 'text' },
        },
      ],
      edges: [
        { from: 'START', to: 'read' },
        { from: 'read', to: 'join' },
        { from: 'join', to: 'END' },
      ],
      output: ['reports', 'summary'],
    }))
    const composed = await compose.execute({ action: 'compose', spec }, exec('session-1'))
    assert.equal(composed.ok, true)
    const failed = await run.execute({ graph: composed.graph }, exec('session-1'))

    assert.equal(failed.status, 'failed')
    assert.equal(failed.failedNode, 'read')
    assert.deepEqual(failed.failedScc, ['read'])
    assert.equal(failed.error.node, 'read')
    assert.equal(failed.error.itemIndex, 1)
    assert.deepEqual(failed.pending, ['read'])
    assert.ok(failed.downstream.includes('END'))
    assert.ok(failed.lastSupersteps[0].next.includes('read'), 'hidden fanout nodes are reported as the map id')
  } finally {
    ctx.dispose()
  }
})

test('a static fan-out branch failure names the branch', async () => {
  const { ctx, compose, run } = setup()
  ctx.tools.definitions = () => [{ name: 'left' }, { name: 'right' }]
  ctx.tools.execute = async ({ calls }) => {
    if (calls[0].name === 'left') throw toolError('left failed')
    return textResult('B')
  }
  try {
    const spec = {
      ir: 1,
      name: 'branch-failure',
      state: {
        a: { type: 'string', default: '' },
        b: { type: 'string', default: '' },
        joined: { type: 'string', default: '' },
      },
      nodes: [
        { id: 'left', do: 'tool', tool: 'left', args: {}, out: { a: 'text' } },
        { id: 'right', do: 'tool', tool: 'right', args: {}, out: { b: 'text' } },
        { id: 'join', do: 'set', values: { joined: 'unused' } },
      ],
      edges: [
        { from: 'START', to: 'left' },
        { from: 'START', to: 'right' },
        { from: 'left', to: 'join' },
        { from: 'right', to: 'join' },
        { from: 'join', to: 'END' },
      ],
    }
    const composed = await compose.execute({ action: 'compose', spec }, exec('session-1'))
    assert.equal(composed.ok, true)
    const failed = await run.execute({ graph: composed.graph }, exec('session-1'))
    assert.equal(failed.status, 'failed')
    assert.equal(failed.failedNode, 'left')
    assert.deepEqual(failed.failedScc, ['left'])
    assert.deepEqual(failed.upstream, ['START'])
    assert.ok(failed.downstream.includes('join'))
    assert.ok(failed.downstream.includes('END'))
    assert.ok(failed.pending.includes('left'))
  } finally {
    ctx.dispose()
  }
})

test('a run past maxSteps fails with the recursion error', async () => {
  const { ctx, compose, run } = setup()
  ctx.tools.definitions = () => []
  try {
    const spec = {
      ir: 1,
      name: 'looping',
      state: { text: { type: 'string', default: '' } },
      nodes: [{ id: 'one', do: 'set', values: { text: 'again' } }],
      edges: [
        { from: 'START', to: 'one' },
        { from: 'one', to: 'one', when: true },
      ],
      maxSteps: 3,
    }
    const composed = await compose.execute({ action: 'compose', spec }, exec('session-1'))
    const failed = await run.execute({ graph: composed.graph }, exec('session-1'))
    assert.equal(failed.status, 'failed')
    assert.match(failed.error.message, /Recursion limit of 3/)
    assert.ok(failed.thread)
    assert.match(failed.hint, /resume/)
  } finally {
    ctx.dispose()
  }
})

test('a choice with no matching guard reports the source node', async () => {
  const { ctx, compose, run } = setup()
  ctx.tools.definitions = () => []
  try {
    const spec = {
      ir: 1,
      name: 'no-match',
      state: { n: { type: 'number', default: 0 } },
      nodes: [{ id: 'one', do: 'set', values: { n: 1 } }],
      edges: [
        { from: 'START', to: 'one' },
        { from: 'one', to: 'END', when: { op: 'gt', args: [{ $state: 'n' }, 5] } },
      ],
    }
    const composed = await compose.execute({ action: 'compose', spec }, exec('session-1'))
    const failed = await run.execute({ graph: composed.graph }, exec('session-1'))
    assert.equal(failed.status, 'failed')
    assert.equal(failed.failedNode, 'one')
    assert.deepEqual(failed.failedScc, ['one'])
    assert.match(failed.error.message, /no outgoing edge matched/)
  } finally {
    ctx.dispose()
  }
})

test('a background failure returns the structured result', async () => {
  const { ctx, compose, run } = setup({ jobs: true })
  ctx.tools.definitions = () => [{ name: 'boom' }]
  ctx.tools.execute = async () => {
    throw toolError('background boom')
  }
  try {
    const composed = await compose.execute({ action: 'compose', spec: failingSpec() }, exec('session-1'))
    const started = await run.execute({ graph: composed.graph, run_in_background: true }, exec('session-1'))
    assert.equal(started.kind, 'background')
    const outcome = await ctx.jobs.runs.get(started.jobId)
    assert.equal(outcome.status, 'failed')
    const parsed = JSON.parse(outcome.result)
    assert.equal(parsed.status, 'failed')
    assert.equal(parsed.failedNode, 'fail')
    assert.equal(parsed.error.message, 'background boom')
  } finally {
    ctx.dispose()
  }
})

test('bounds a large failure state and keeps at most three supersteps', async () => {
  const { ctx, compose, run } = setup()
  ctx.tools.definitions = () => [{ name: 'boom' }]
  ctx.tools.execute = async () => {
    throw toolError('boom')
  }
  try {
    const spec = {
      ir: 1,
      name: 'bounded',
      state: { big: { type: 'string', default: 'x'.repeat(5000) } },
      nodes: [
        { id: 'p1', do: 'set', values: { big: 'x'.repeat(5000) } },
        { id: 'p2', do: 'set', values: { big: 'x'.repeat(5000) } },
        { id: 'p3', do: 'set', values: { big: 'x'.repeat(5000) } },
        { id: 'fail', do: 'tool', tool: 'boom', args: {}, out: { big: 'text' } },
      ],
      edges: [
        { from: 'START', to: 'p1' },
        { from: 'p1', to: 'p2' },
        { from: 'p2', to: 'p3' },
        { from: 'p3', to: 'fail' },
        { from: 'fail', to: 'END' },
      ],
      output: ['big'],
    }
    const composed = await compose.execute({ action: 'compose', spec }, exec('session-1'))
    const failed = await run.execute({ graph: composed.graph }, exec('session-1'))
    assert.equal(failed.status, 'failed')
    assert.equal(failed.lastSupersteps.length, 3)
    assert.equal(failed.lastSupersteps[0].values.truncated, true)
    assert.equal(typeof failed.lastSupersteps[0].values.preview, 'string')
    assert.equal(failed.state.truncated, true)
  } finally {
    ctx.dispose()
  }
})
