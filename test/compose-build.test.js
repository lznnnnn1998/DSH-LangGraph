import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as langgraph from '@langchain/langgraph'
import { Command } from '@langchain/langgraph'
import { MemorySaver } from '@langchain/langgraph-checkpoint'
import { buildSpecGraph } from '../compose/build.js'

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/specs/${name}.json`, import.meta.url), 'utf8'))
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function compileSpec(spec, helpers, saver = new MemorySaver()) {
  const graph = buildSpecGraph({ ...langgraph, helpers }, spec)
  return graph.compile({ checkpointer: saver })
}

function findNodeId(error) {
  let current = error
  for (let depth = 0; current !== null && current !== undefined && depth < 10; depth += 1) {
    if (current.nodeId !== undefined) return current.nodeId
    current = current.cause
  }
  return undefined
}

function errorText(error) {
  const parts = []
  let current = error
  for (let depth = 0; current !== null && current !== undefined && depth < 10; depth += 1) {
    if (typeof current.message === 'string') parts.push(current.message)
    current = current.cause
  }
  return parts.join('\n')
}

test('builds and runs the scan-report fixture', async () => {
  const prompts = []
  const helpers = {
    async callTool(name, args) {
      assert.equal(name, 'glob')
      assert.deepEqual(args, { pattern: '**/*.js' })
      return 'a.js\nb.js\nc.js'
    },
    async callModel(prompt) {
      prompts.push(prompt)
      return { text: 'large' }
    },
  }
  const compiled = compileSpec(fixture('scan-report'), helpers)
  const state = await compiled.invoke({}, { configurable: { thread_id: 'scan-report-test' } })
  assert.deepEqual(state.files, ['a.js', 'b.js', 'c.js'])
  assert.equal(state.verdict, 'large')
  assert.equal(state.report, 'large project')
  assert.match(prompts[0], /a\.js/)
  assert.match(prompts[0], /b\.js/)
})

test('runs a gate to an interrupt and resumes it', async () => {
  const helpers = {
    async callTool(name) {
      assert.equal(name, 'glob')
      return 'x.js\ny.js'
    },
  }
  const compiled = compileSpec(fixture('approval-gate'), helpers)
  const config = { configurable: { thread_id: 'approval-gate-test' } }
  const first = await compiled.invoke({}, config)
  assert.ok(Array.isArray(first.__interrupt__), 'the gate interrupted the run')
  assert.equal(first.__interrupt__.length, 1)
  assert.match(first.__interrupt__[0].value.question, /Scan the workspace/)
  assert.deepEqual(first.__interrupt__[0].value.options, ['Approve', 'Reject'])

  const second = await compiled.invoke(new Command({ resume: true }), config)
  assert.equal(second.approved, true)
  assert.equal(second.listing, 'x.js\ny.js')
})

test('runs an agent node through the prebuilt ReAct agent', async () => {
  let options
  let brief
  const helpers = {
    chatModel() {
      return { kind: 'stub-model' }
    },
    tools(names) {
      return names.map(name => ({ name }))
    },
    async createReactAgent(agentOptions) {
      options = agentOptions
      return {
        async invoke({ messages }) {
          brief = messages[0][1]
          return { messages: [{ content: 'It is a Node project.' }] }
        },
      }
    },
  }
  const compiled = compileSpec(fixture('ask-tools'), helpers)
  const state = await compiled.invoke({ question: 'What is this?' }, { configurable: { thread_id: 'ask-tools-test' } })
  assert.equal(state.answer, 'It is a Node project.')
  assert.equal(brief, 'What is this?')
  assert.deepEqual(options.tools.map(tool => tool.name), ['glob', 'read'])
  assert.equal(options.llm.kind, 'stub-model')
})

test('runs static fan-out branches in one superstep and joins them', async () => {
  let active = 0
  let peak = 0
  const helpers = {
    async callTool(name, args) {
      assert.equal(name, 'read')
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 10))
      active -= 1
      return args.path === 'a.txt' ? 'A' : 'B'
    },
    async callModel(prompt) {
      assert.match(prompt, /A\nB|B\nA/)
      return { text: 'joined' }
    },
  }
  const compiled = compileSpec(fixture('parallel'), helpers)
  const state = await compiled.invoke({}, { configurable: { thread_id: 'parallel-test' } })
  assert.deepEqual([...state.all].sort(), ['A', 'B'])
  assert.equal(state.summary, 'joined')
  assert.equal(peak, 2)
})

test('applies every v1 transform', async () => {
  const spec = {
    ir: 1,
    state: {
      text: { type: 'string', default: '' },
      lines: { type: 'string[]', default: [] },
      first: { type: 'string', default: '' },
      count: { type: 'number', default: 0 },
      data: { type: 'json', default: null },
      flag: { type: 'boolean', default: false },
      num: { type: 'number', default: 0 },
    },
    nodes: [
      { id: 'a', do: 'tool', tool: 'texts', args: {}, out: { text: 'text', lines: 'lines', first: 'first', count: 'count' } },
      { id: 'b', do: 'tool', tool: 'json', args: {}, out: { data: 'json' } },
      { id: 'c', do: 'tool', tool: 'flag', args: {}, out: { flag: 'bool' } },
      { id: 'd', do: 'tool', tool: 'num', args: {}, out: { num: 'number' } },
    ],
    edges: [
      { from: 'START', to: 'a' },
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'd' },
      { from: 'd', to: 'END' },
    ],
  }
  const helpers = {
    async callTool(name) {
      if (name === 'texts') return 'a\nb\nc\n\n'
      if (name === 'json') return '{"x":1}'
      if (name === 'flag') return 'TRUE'
      if (name === 'num') return ' 42 '
      throw new Error(`unexpected tool ${name}`)
    },
  }
  const compiled = compileSpec(spec, helpers)
  const state = await compiled.invoke({}, { configurable: { thread_id: 'transforms-test' } })
  assert.equal(state.text, 'a\nb\nc')
  assert.deepEqual(state.lines, ['a', 'b', 'c'])
  assert.equal(state.first, 'a')
  assert.equal(state.count, 3)
  assert.deepEqual(state.data, { x: 1 })
  assert.equal(state.flag, true)
  assert.equal(state.num, 42)
})

test('takes the first matching choice edge', async () => {
  const spec = {
    ir: 1,
    state: {
      n: { type: 'number', default: 0 },
      ran: { type: 'string', default: '' },
    },
    nodes: [
      { id: 'set-n', do: 'set', values: { n: 2 } },
      { id: 'a', do: 'set', values: { ran: 'a' } },
      { id: 'b', do: 'set', values: { ran: 'b' } },
      { id: 'c', do: 'set', values: { ran: 'c' } },
    ],
    edges: [
      { from: 'START', to: 'set-n' },
      { from: 'set-n', to: 'a', when: { op: 'eq', args: [{ $state: 'n' }, 1] } },
      { from: 'set-n', to: 'b', when: { op: 'eq', args: [{ $state: 'n' }, 2] } },
      { from: 'set-n', to: 'c', when: true },
      { from: 'a', to: 'END' },
      { from: 'b', to: 'END' },
      { from: 'c', to: 'END' },
    ],
  }
  const compiled = compileSpec(spec, {})
  const state = await compiled.invoke({}, { configurable: { thread_id: 'choice-test' } })
  assert.equal(state.ran, 'b')
})

test('runs a bounded cycle', async () => {
  const spec = {
    ir: 1,
    state: {
      count: { type: 'number', default: 0 },
      done: { type: 'boolean', default: false },
    },
    nodes: [
      { id: 'tick', do: 'tool', tool: 'tick', args: { value: { $state: 'count' } }, out: { count: 'number' } },
      { id: 'finish', do: 'set', values: { done: true } },
    ],
    edges: [
      { from: 'START', to: 'tick' },
      { from: 'tick', to: 'tick', when: { op: 'lt', args: [{ $state: 'count' }, 3] } },
      { from: 'tick', to: 'finish', when: true },
      { from: 'finish', to: 'END' },
    ],
    maxSteps: 20,
  }
  const helpers = {
    async callTool(name, args) {
      assert.equal(name, 'tick')
      return String(args.value + 1)
    },
  }
  const compiled = compileSpec(spec, helpers)
  const state = await compiled.invoke({}, { configurable: { thread_id: 'cycle-test' } })
  assert.equal(state.count, 3)
  assert.equal(state.done, true)
})

test('annotates a node failure with its node id', async () => {
  const spec = {
    ir: 1,
    state: { text: { type: 'string', default: '' } },
    nodes: [{ id: 'fail', do: 'tool', tool: 'boom', args: {}, out: { text: 'text' } }],
    edges: [{ from: 'START', to: 'fail' }, { from: 'fail', to: 'END' }],
  }
  const helpers = {
    async callTool() {
      const error = new Error('boom')
      error.name = 'ToolError'
      throw error
    },
  }
  const compiled = compileSpec(spec, helpers)
  await assert.rejects(
    compiled.invoke({}, { configurable: { thread_id: 'error-test' } }),
    error => {
      assert.equal(findNodeId(error), 'fail')
      return true
    },
  )
})

test('fails the run when no choice guard matches', async () => {
  const spec = {
    ir: 1,
    state: { n: { type: 'number', default: 0 } },
    nodes: [{ id: 'one', do: 'set', values: { n: 1 } }],
    edges: [
      { from: 'START', to: 'one' },
      { from: 'one', to: 'END', when: { op: 'gt', args: [{ $state: 'n' }, 5] } },
    ],
  }
  const compiled = compileSpec(spec, {})
  await assert.rejects(
    compiled.invoke({}, { configurable: { thread_id: 'no-match-test' } }),
    error => {
      assert.match(errorText(error), /no outgoing edge matched/)
      return true
    },
  )
})

test('rejects an invalid spec before building a graph', () => {
  const helpers = {}
  assert.throws(
    () => buildSpecGraph({ ...langgraph, helpers }, { ir: 1 }),
    error => error.name === 'SpecError' && /invalid graph spec/.test(error.message),
  )
})

test('merge shallow-merges json objects', async () => {
  const spec = {
    ir: 1,
    state: { doc: { type: 'json', default: {}, reducer: 'merge' } },
    nodes: [
      { id: 'a', do: 'set', values: { doc: { x: 1 } } },
      { id: 'b', do: 'set', values: { doc: { y: 2 } } },
    ],
    edges: [
      { from: 'START', to: 'a' },
      { from: 'a', to: 'b' },
      { from: 'b', to: 'END' },
    ],
  }
  const compiled = compileSpec(spec, {})
  const state = await compiled.invoke({}, { configurable: { thread_id: 'merge-json' } })
  assert.deepEqual(state.doc, { x: 1, y: 2 })
})

test('keeps a fan-out field mergeable when the reducer is append', () => {
  const spec = clone(fixture('parallel'))
  const graph = buildSpecGraph({ ...langgraph, helpers: {} }, spec)
  assert.equal(typeof graph.compile, 'function')
})
