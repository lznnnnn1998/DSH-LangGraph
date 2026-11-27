import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as langgraph from '@langchain/langgraph'
import { MemorySaver } from '@langchain/langgraph-checkpoint'
import { buildSpecGraph } from '../compose/build.js'

function findNodeId(error) {
  let current = error
  for (let depth = 0; current !== null && current !== undefined && depth < 10; depth += 1) {
    if (current.nodeId !== undefined) return current.nodeId
    current = current.cause
  }
  return undefined
}

test('a failed static fan-out branch fails the run and skips the join', async () => {
  const spec = {
    ir: 1,
    name: 'parallel-failure',
    state: {
      a: { type: 'string', default: '' },
      b: { type: 'string', default: '' },
      joined: { type: 'string', default: '' },
    },
    nodes: [
      { id: 'left', do: 'tool', tool: 'left', args: {}, out: { a: 'text' } },
      { id: 'right', do: 'tool', tool: 'right', args: {}, out: { b: 'text' } },
      { id: 'join', do: 'model', prompt: ['a=', { $state: 'a' }, ' b=', { $state: 'b' }], out: { joined: 'text' } },
    ],
    edges: [
      { from: 'START', to: 'left' },
      { from: 'START', to: 'right' },
      { from: 'left', to: 'join' },
      { from: 'right', to: 'join' },
      { from: 'join', to: 'END' },
    ],
  }
  let rightRan = false
  let joinRan = false
  const helpers = {
    async callTool(name) {
      if (name === 'left') {
        const error = new Error('left failed')
        error.name = 'ToolError'
        throw error
      }
      rightRan = true
      return 'B'
    },
    async callModel() {
      joinRan = true
      return { text: 'joined' }
    },
  }
  const compiled = buildSpecGraph({ ...langgraph, helpers }, spec).compile({ checkpointer: new MemorySaver() })
  await assert.rejects(
    compiled.invoke({}, { configurable: { thread_id: 'parallel-failure' } }),
    error => {
      assert.equal(findNodeId(error), 'left')
      return true
    },
  )
  assert.equal(rightRan, true, 'the sibling branch still ran in the same superstep')
  assert.equal(joinRan, false, 'the join does not run after a failed branch')
})

test('parallel branches join once with the aggregated state', async () => {
  const spec = {
    ir: 1,
    name: 'parallel-join',
    state: {
      a: { type: 'string', default: '' },
      b: { type: 'string', default: '' },
      joined: { type: 'string', default: '' },
    },
    nodes: [
      { id: 'left', do: 'tool', tool: 'left', args: {}, out: { a: 'text' } },
      { id: 'right', do: 'tool', tool: 'right', args: {}, out: { b: 'text' } },
      { id: 'join', do: 'model', prompt: ['a=', { $state: 'a' }, ' b=', { $state: 'b' }], out: { joined: 'text' } },
    ],
    edges: [
      { from: 'START', to: 'left' },
      { from: 'START', to: 'right' },
      { from: 'left', to: 'join' },
      { from: 'right', to: 'join' },
      { from: 'join', to: 'END' },
    ],
  }
  let joinCalls = 0
  let prompt
  const helpers = {
    async callTool(name) {
      return name === 'left' ? 'A' : 'B'
    },
    async callModel(value) {
      joinCalls += 1
      prompt = value
      return { text: 'joined' }
    },
  }
  const compiled = buildSpecGraph({ ...langgraph, helpers }, spec).compile({ checkpointer: new MemorySaver() })
  const state = await compiled.invoke({}, { configurable: { thread_id: 'parallel-join' } })
  assert.equal(joinCalls, 1)
  assert.match(prompt, /a=A b=B|a=B b=A/)
  assert.equal(state.joined, 'joined')
})
