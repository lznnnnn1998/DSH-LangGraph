import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTracer } from '../dsh-trace.js'

/** A fake execution whose session records every appended event. */
function execution() {
  const events = []
  return {
    events,
    exec: {
      callId: 'call-1',
      rootCallId: 'call-1',
      agent: {
        session: {
          append(type, data) {
            events.push({ type, data })
          },
        },
      },
    },
  }
}

test('nests nodes, tools, and model calls under the run', () => {
  const { events, exec } = execution()
  const tracer = createTracer(exec, 'scan-report')
  assert.equal(tracer.enabled, true)
  const handler = tracer.callbacks[0]

  handler.handleChainStart({}, {}, 'node-run', undefined, ['graph:step:1'], {
    langgraph_node: 'scan',
    langgraph_step: 1,
    checkpoint_ns: 'scan:1',
  })
  handler.handleToolStart({ name: 'glob' }, { pattern: '**/*.js' }, 'tool-run', 'node-run')
  handler.handleToolEnd('a.js\nb.js', 'tool-run')
  handler.handleChatModelStart({ model: 'deepseek' }, [[{
    getType: () => 'human',
    content: 'summarize',
  }]], 'model-run', 'node-run')
  handler.handleLLMEnd({
    generations: [[{ text: 'two files' }]],
    llmOutput: { tokenUsage: { inputTokens: 5, outputTokens: 3 } },
  }, 'model-run')
  handler.handleChainEnd({ count: 2 }, 'node-run')

  assert.deepEqual(events.map(event => event.type), [
    'tool/ptc-dispatch-start',
    'tool/ptc-dispatch-start',
    'tool/ptc-dispatch',
    'tool/ptc-dispatch-start',
    'tool/ptc-dispatch',
    'tool/ptc-dispatch',
  ])
  const nodeStart = events[0].data
  assert.equal(nodeStart.rootCallId, 'call-1')
  assert.equal(nodeStart.parentCallId, 'call-1')
  assert.equal(nodeStart.name, 'langgraph:node scan')
  assert.deepEqual(nodeStart.arguments, { graph: 'scan-report', node: 'scan', step: 1 })

  const toolStart = events[1].data
  assert.equal(toolStart.parentCallId, nodeStart.subCallId)
  assert.equal(toolStart.name, 'langgraph:tool glob')
  assert.deepEqual(toolStart.arguments, { pattern: '**/*.js' })
  assert.equal(events[2].data.content[0].text, 'a.js\nb.js')

  const modelStart = events[3].data
  assert.equal(modelStart.parentCallId, nodeStart.subCallId)
  assert.equal(modelStart.name, 'langgraph:model')
  assert.deepEqual(modelStart.arguments.messages, [{ role: 'human', text: 'summarize' }])
  assert.deepEqual(events[4].data.meta, { usage: { inputTokens: 5, outputTokens: 3 } })
  assert.equal(events[4].data.content[0].text, 'two files')

  const nodeEnd = events[5].data
  assert.equal(nodeEnd.subCallId, nodeStart.subCallId)
  assert.equal(nodeEnd.isError, false)
  assert.match(nodeEnd.content[0].text, /"count":2/)
})

test('fan-out nodes stay siblings under the run', () => {
  const { events, exec } = execution()
  const tracer = createTracer(exec, 'g')
  const handler = tracer.callbacks[0]
  handler.handleChainStart({}, {}, 'root-run', undefined, [], {})
  handler.handleChainStart({}, {}, 'a-run', 'root-run', ['graph:step:1'], { langgraph_node: 'a' })
  handler.handleChainStart({}, {}, 'b-run', 'root-run', ['graph:step:1'], { langgraph_node: 'b' })
  const starts = events.filter(event => event.type === 'tool/ptc-dispatch-start')
  assert.equal(starts[0].data.parentCallId, 'call-1')
  assert.equal(starts[1].data.parentCallId, 'call-1')
})

test('inner runnable chains do not become extra node rows', () => {
  const { events, exec } = execution()
  const tracer = createTracer(exec, 'g')
  const handler = tracer.callbacks[0]
  handler.handleChainStart({}, {}, 'node-run', undefined, ['graph:step:1'], { langgraph_node: 'scan' })
  handler.handleChainStart({}, {}, 'lambda-run', 'node-run', [], { langgraph_node: 'scan' })
  handler.handleToolStart({ name: 'read' }, { path: 'a' }, 'tool-run', 'lambda-run')
  handler.handleToolEnd('text', 'tool-run')
  handler.handleChainEnd({}, 'lambda-run')
  handler.handleChainEnd({}, 'node-run')

  assert.deepEqual(events.map(event => event.type), [
    'tool/ptc-dispatch-start',
    'tool/ptc-dispatch-start',
    'tool/ptc-dispatch',
    'tool/ptc-dispatch',
  ])
  assert.equal(events[1].data.parentCallId, events[0].data.subCallId)
})

test('skips graph boundaries and hidden nodes', () => {
  const { events, exec } = execution()
  const tracer = createTracer(exec, 'g')
  const handler = tracer.callbacks[0]
  handler.handleChainStart({}, {}, 'root-run', undefined, [], {})
  handler.handleChainStart({}, {}, 'start-run', 'root-run', ['graph:step:0', 'langsmith:hidden'], {
    langgraph_node: '__start__',
  })
  handler.handleChainEnd({}, 'start-run')
  handler.handleChainEnd({}, 'root-run')
  assert.deepEqual(events, [])
})

test('manual helper traces attach to the active node', () => {
  const { events, exec } = execution()
  const tracer = createTracer(exec, 'g')
  const handler = tracer.callbacks[0]
  handler.handleChainStart({}, {}, 'node-run', undefined, ['graph:step:1'], { langgraph_node: 'scan' })
  const nodeStart = events[0].data
  tracer.finish(
    tracer.begin('langgraph:tool glob', { pattern: '*' }),
    { content: [{ type: 'text', text: 'a.js' }] },
  )
  assert.equal(events[1].data.parentCallId, nodeStart.subCallId)
  assert.equal(events[2].data.isError, false)
})

test('marks a GraphInterrupt node as paused, not failed', () => {
  const { events, exec } = execution()
  const tracer = createTracer(exec, 'g')
  const handler = tracer.callbacks[0]
  handler.handleChainStart({}, {}, 'node-run', undefined, ['graph:step:1'], { langgraph_node: 'confirm' })
  const error = new Error('{"question":"Ship it?"}')
  error.name = 'GraphInterrupt'
  handler.handleChainError(error, 'node-run')

  assert.equal(events[1].data.isError, false)
  assert.equal(events[1].data.error, undefined)
  assert.match(events[1].data.content[0].text, /interrupted.*Ship it/)
})

test('skips unnamed ToolNode wrappers and records model tool calls', () => {
  const { events, exec } = execution()
  const tracer = createTracer(exec, 'g')
  const handler = tracer.callbacks[0]
  handler.handleChainStart({}, {}, 'node-run', undefined, ['graph:step:1'], { langgraph_node: 'tools' })
  handler.handleToolStart({
    lc: 1,
    type: 'not_implemented',
    id: ['langchain', 'tools', 'DynamicStructuredTool'],
  }, '{"pattern":"*"}', 'tool-run', 'node-run')
  handler.handleToolEnd('unused', 'tool-run')
  handler.handleChatModelStart({ model: 'fake' }, [[{ getType: () => 'human', content: 'go' }]], 'model-run', 'node-run')
  handler.handleLLMEnd({
    generations: [[{
      text: '',
      message: { tool_calls: [{ name: 'glob', args: { pattern: '*' } }] },
    }]],
  }, 'model-run')
  handler.handleChainEnd({}, 'node-run')

  assert.deepEqual(events.map(event => event.data.name), [
    'langgraph:node tools',
    'langgraph:model',
    'langgraph:model',
    'langgraph:node tools',
  ])
  assert.match(events[2].data.content[0].text, /"name":"glob"/)
})

test('reports trace transitions to a progress sink', () => {
  const { exec } = execution()
  const progress = []
  const tracer = createTracer(exec, 'g', true, event => progress.push(event))
  const handler = tracer.callbacks[0]
  handler.handleChainStart({}, {}, 'node-run', undefined, ['graph:step:1'], { langgraph_node: 'scan' })
  tracer.finish(tracer.begin('langgraph:tool glob', { pattern: '*' }), { content: [] })
  handler.handleChainEnd({}, 'node-run')
  assert.deepEqual(progress.map(event => `${event.phase}:${event.name}`), [
    'start:langgraph:node scan',
    'start:langgraph:tool glob',
    'end:langgraph:tool glob',
    'end:langgraph:node scan',
  ])
})

test('tracing is off without a session and disables on a rejected append', () => {
  const off = createTracer({ callId: 'call-1' }, 'g')
  assert.equal(off.enabled, false)
  assert.deepEqual(off.callbacks, [])
  assert.equal(off.begin('x', {}), undefined)

  const disabled = createTracer(execution().exec, 'g', false)
  assert.equal(disabled.enabled, false)
  assert.deepEqual(disabled.callbacks, [])

  let calls = 0
  const broken = createTracer({
    callId: 'call-1',
    rootCallId: 'call-1',
    agent: { session: { append() { calls += 1; throw new Error('rejected') } } },
  }, 'g')
  assert.equal(broken.enabled, true)
  assert.equal(broken.begin('x', {}), undefined)
  assert.equal(calls, 1)
  broken.begin('y', {})
  assert.equal(calls, 1)
})
