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

function loopSpec() {
  return {
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
}

test('composes and runs a bounded repair loop', async () => {
  const { ctx, compose, run } = setup()
  ctx.tools.definitions = () => [{ name: 'tick' }, { name: 'judge' }]
  ctx.tools.execute = async ({ calls }) => {
    const args = JSON.parse(calls[0].arguments)
    return textResult(calls[0].name === 'tick' ? String(args.value + 1) : `note-${args.value}`)
  }
  try {
    const composed = await compose.execute({ action: 'compose', spec: loopSpec() }, exec('session-1'))
    assert.equal(composed.ok, true)
    assert.ok(composed.warnings.some(warning => warning.code === 'cycle'))
    const ran = await run.execute({ graph: composed.graph }, exec('session-1'))
    assert.equal(ran.status, 'completed')
    assert.equal(ran.state.attempts, 3)
    assert.equal(ran.state.note, 'note-3')
    assert.equal(typeof ran.report.steps, 'number')
  } finally {
    ctx.dispose()
  }
})

test('a failure inside a loop reports the whole SCC and the recent iterations', async () => {
  const { ctx, compose, run } = setup()
  ctx.tools.definitions = () => [{ name: 'tick' }, { name: 'judge' }]
  ctx.tools.execute = async ({ calls }) => {
    const args = JSON.parse(calls[0].arguments)
    if (calls[0].name === 'tick') return textResult(String(args.value + 1))
    if (args.value === 2) throw toolError('judge failed')
    return textResult(`note-${args.value}`)
  }
  try {
    const composed = await compose.execute({ action: 'compose', spec: loopSpec() }, exec('session-1'))
    const failed = await run.execute({ graph: composed.graph }, exec('session-1'))
    assert.equal(failed.status, 'failed')
    assert.equal(failed.failedNode, 'judge')
    assert.deepEqual(failed.failedScc, ['judge', 'tick'])
    assert.deepEqual(failed.upstream, ['START', 'scan'])
    assert.ok(failed.downstream.includes('tick'))
    assert.ok(failed.downstream.includes('judge'))
    assert.ok(failed.downstream.includes('END'))
    assert.ok(failed.lastSupersteps.length <= 3)
    assert.ok(failed.lastSupersteps.length >= 1)
    assert.equal(failed.error.message, 'judge failed')
    assert.ok(failed.checkpoint)
    assert.ok(failed.thread)
  } finally {
    ctx.dispose()
  }
})

test('a cycle with no conditional exit is allowed but warned', async () => {
  const { ctx, compose } = setup()
  ctx.tools.definitions = () => []
  try {
    const spec = {
      ir: 1,
      name: 'no-exit',
      state: { text: { type: 'string', default: '' } },
      nodes: [{ id: 'one', do: 'set', values: { text: 'again' } }],
      edges: [
        { from: 'START', to: 'one' },
        { from: 'one', to: 'one', when: true },
      ],
    }
    const composed = await compose.execute({ action: 'validate', spec }, exec('session-1'))
    assert.equal(composed.ok, true)
    assert.ok(composed.warnings.some(warning => warning.code === 'cycle-exit'))
    assert.ok(composed.warnings.some(warning => warning.code === 'cycle-counter'))
    assert.ok(composed.warnings.some(warning => warning.code === 'cycle-budget'))
  } finally {
    ctx.dispose()
  }
})
