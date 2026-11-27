import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as langgraph from '@langchain/langgraph'
import { MemorySaver } from '@langchain/langgraph-checkpoint'
import { apply } from '../index.js'
import { buildSpecGraph } from '../compose/build.js'
import { validateSpec } from '../compose/schema.js'
import { createContext, createStorageDomain, exec } from './support/harness.js'

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/specs/${name}.json`, import.meta.url), 'utf8'))
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function compile(spec, helpers, saver = new MemorySaver()) {
  return buildSpecGraph({ ...langgraph, helpers }, spec).compile({ checkpointer: saver })
}

function config(thread) {
  return { configurable: { thread_id: thread } }
}

function findError(error, key) {
  let current = error
  for (let depth = 0; current !== null && current !== undefined && depth < 10; depth += 1) {
    if (current[key] !== undefined) return current
    current = current.cause
  }
  return undefined
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test('runs a map body once per item and joins once in input order', async () => {
  const calls = []
  const prompts = []
  const helpers = {
    async callTool(name, args) {
      assert.equal(name, 'read')
      calls.push(args.path)
      await sleep(args.path === 'a.js' ? 10 : 1)
      return `${args.path}:content`
    },
    async callModel(prompt) {
      prompts.push(prompt)
      return { text: 'joined' }
    },
  }
  const state = await compile(fixture('map-report'), helpers).invoke({}, config('map-order'))
  assert.deepEqual(calls, ['a.js', 'b.js'])
  assert.deepEqual(state.reports, ['a.js:content', 'b.js:content'], 'append follows Send order, not completion order')
  assert.equal(state.summary, 'joined')
  assert.equal(prompts.length, 1, 'the join runs once, not once per item')
  assert.match(prompts[0], /a\.js:content\nb\.js:content/)
})

test('an empty map still reaches the join with aggregate defaults', async () => {
  let toolCalls = 0
  const prompts = []
  const helpers = {
    async callTool() {
      toolCalls += 1
      return 'unexpected'
    },
    async callModel(prompt) {
      prompts.push(prompt)
      return { text: 'joined-empty' }
    },
  }
  const state = await compile(fixture('map-report'), helpers).invoke({ files: [] }, config('map-empty'))
  assert.equal(toolCalls, 0)
  assert.deepEqual(state.reports, [])
  assert.equal(state.summary, 'joined-empty')
  assert.equal(prompts.length, 1)
})

test('maxItems rejects before dispatching any item', async () => {
  const spec = clone(fixture('map-report'))
  spec.nodes[0].maxItems = 2
  let calls = 0
  const helpers = {
    async callTool() {
      calls += 1
      return 'nope'
    },
    async callModel() {
      return { text: 'nope' }
    },
  }
  await assert.rejects(
    compile(spec, helpers).invoke({ files: ['a.js', 'b.js', 'c.js'] }, config('map-max')),
    error => {
      const annotated = findError(error, 'nodeId')
      assert.equal(annotated.nodeId, 'read')
      assert.match(annotated.message, /maxItems is 2/)
      return true
    },
  )
  assert.equal(calls, 0, 'no body ran')
})

test('a non-array over fails the map clearly', async () => {
  const helpers = {
    async callTool() {
      return 'nope'
    },
    async callModel() {
      return { text: 'nope' }
    },
  }
  await assert.rejects(
    compile(fixture('map-report'), helpers).invoke({ files: 'not-an-array' }, config('map-not-array')),
    error => {
      const annotated = findError(error, 'nodeId')
      assert.equal(annotated.nodeId, 'read')
      assert.match(annotated.message, /needs "files" to be an array/)
      return true
    },
  )
})

test('an item failure carries the map node id and the item index', async () => {
  const helpers = {
    async callTool(name, args) {
      if (args.path === 'b.js') {
        const error = new Error('ENOENT')
        error.name = 'ToolError'
        throw error
      }
      return `${args.path}:content`
    },
    async callModel() {
      return { text: 'nope' }
    },
  }
  await assert.rejects(
    compile(fixture('map-report'), helpers).invoke({}, config('map-item-failure')),
    error => {
      const annotated = findError(error, 'itemIndex')
      assert.equal(annotated.nodeId, 'read')
      assert.equal(annotated.itemIndex, 1)
      assert.equal(annotated.name, 'ToolError')
      return true
    },
  )
})

test('a map body reads item and index', async () => {
  const spec = {
    ir: 1,
    name: 'probe-map',
    state: {
      items: { type: 'string[]', default: ['x', 'y'] },
      out: { type: 'string[]', default: [], reducer: 'append' },
    },
    nodes: [{
      id: 'walk',
      do: 'map',
      over: 'items',
      body: {
        do: 'tool',
        tool: 'probe',
        args: { value: { $state: 'item' }, position: { $state: 'index' } },
        out: { out: 'text' },
      },
    }],
    edges: [{ from: 'START', to: 'walk' }, { from: 'walk', to: 'END' }],
  }
  const seen = []
  const helpers = {
    async callTool(name, args) {
      seen.push(args)
      return `${args.value}#${args.position}`
    },
  }
  const state = await compile(spec, helpers).invoke({}, config('map-item-index'))
  assert.deepEqual(seen, [{ value: 'x', position: 0 }, { value: 'y', position: 1 }])
  assert.deepEqual(state.out, ['x#0', 'y#1'])
})

test('a numeric map aggregates with add', async () => {
  const spec = {
    ir: 1,
    name: 'sum',
    state: {
      nums: { type: 'number[]', default: [1, 2, 3] },
      sum: { type: 'number', default: 0, reducer: 'add' },
    },
    nodes: [{
      id: 'total',
      do: 'map',
      over: 'nums',
      body: { do: 'tool', tool: 'add', args: { value: { $state: 'item' } }, out: { sum: 'number' } },
    }],
    edges: [{ from: 'START', to: 'total' }, { from: 'total', to: 'END' }],
  }
  const helpers = {
    async callTool(name, args) {
      return String(args.value)
    },
  }
  const state = await compile(spec, helpers).invoke({}, config('map-sum'))
  assert.equal(state.sum, 6)
})

test('rejects map bodies that cannot aggregate safely', () => {
  const replace = clone(fixture('map-report'))
  replace.state.reports.reducer = 'replace'
  const replaceResult = validateSpec(replace, { tools: ['read'] })
  assert.equal(replaceResult.ok, false)
  assert.ok(replaceResult.errors.some(error => error.path === 'nodes[0].body.out.reports' && /mergeable reducer/.test(error.message)))

  const nested = clone(fixture('map-report'))
  nested.nodes[0].body = { do: 'map', over: 'files' }
  assert.ok(validateSpec(nested, { tools: ['read'] }).errors.some(error => error.path === 'nodes[0].body.do'))

  const gate = clone(fixture('map-report'))
  gate.nodes[0].body = { id: 'inner', do: 'gate', question: 'x', out: { reports: 'text' } }
  assert.ok(validateSpec(gate, { tools: ['read'] }).errors.some(error => error.path === 'nodes[0].body.do'))

  const wrongOver = clone(fixture('map-report'))
  wrongOver.nodes[0].over = 'summary'
  assert.ok(validateSpec(wrongOver, { tools: ['read'] }).errors.some(error => error.path === 'nodes[0].over'))
})

test('carries maxConcurrency into the run as a global cap', async () => {
  const storage = createStorageDomain()
  const ctx = createContext(storage)
  apply(ctx, { prompt: false, ui: false })
  ctx.tools.definitions = () => [{ name: 'probe' }]
  let active = 0
  let peak = 0
  ctx.tools.execute = async ({ calls }) => {
    active += 1
    peak = Math.max(peak, active)
    await sleep(5)
    active -= 1
    const args = JSON.parse(calls[0].arguments)
    return { results: [{ result: { content: [{ type: 'text', text: args.value }] } }] }
  }
  try {
    const spec = {
      ir: 1,
      name: 'limited-map',
      state: {
        items: { type: 'string[]', default: ['a', 'b', 'c', 'd', 'e'] },
        out: { type: 'string[]', default: [], reducer: 'append' },
      },
      nodes: [{
        id: 'walk',
        do: 'map',
        over: 'items',
        maxConcurrency: 2,
        body: { do: 'tool', tool: 'probe', args: { value: { $state: 'item' } }, out: { out: 'text' } },
      }],
      edges: [{ from: 'START', to: 'walk' }, { from: 'walk', to: 'END' }],
    }
    const composed = await ctx.tools.get('langgraph_compose').execute({ action: 'compose', spec }, exec('session-1'))
    assert.equal(composed.ok, true)
    const ran = await ctx.tools.get('langgraph_run').execute({ graph: composed.graph }, exec('session-1'))
    assert.equal(ran.status, 'completed')
    assert.deepEqual(ran.state.out, ['a', 'b', 'c', 'd', 'e'])
    assert.equal(peak, 2)
  } finally {
    ctx.dispose()
  }
})
