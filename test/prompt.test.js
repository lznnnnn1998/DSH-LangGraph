import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderGraphPrompt } from '../index.js'

test('renders a discovery hint before the first scan', () => {
  const text = renderGraphPrompt(new Map(), false)
  assert.match(text, /langgraph_run/)
  assert.match(text, /Call it with no `graph` to list/)
  assert.doesNotMatch(text, /Registered graphs:/)
})

test('states the vocabulary, trigger policy, and graph list', () => {
  const registry = new Map([
    ['b', { id: 'b', description: 'Second graph.' }],
    ['a', { id: 'a', description: 'First\ngraph.' }],
    ['broken', { id: 'broken', error: new Error('bad module') }],
  ])
  const text = renderGraphPrompt(registry, true)
  assert.match(text, /LangGraph graphs are profile-registered, named graphs/)
  assert.match(text, /They are not the `workflow` tool/)
  assert.match(text, /Use `langgraph_run` when:/)
  assert.match(text, /the user names one of the graph ids below/)
  assert.match(text, /a registered graph's description matches the requested output/)
  assert.match(text, /use that graph instead of hand-rolling its steps with bash, subagent, or ad-hoc calls/)
  assert.match(text, /durable LangGraph thread, a background run \(a DSH job\)/)
  assert.match(text, /or the graph description says it interrupts/)
  assert.match(text, /When no graph's output matches, use ordinary DSH tools/)
  assert.match(text, /do not use the `workflow` tool as a substitute for a named graph/)
  assert.match(text, /not a DSH Session/)
  assert.match(text, /Registered graphs:/)
  assert.match(text, /- a: First graph\./)
  assert.match(text, /- b: Second graph\./)
  assert.doesNotMatch(text, /broken/)
  assert.match(text, /Omit `graph` to list input schemas\./)
})

test('reports an empty registry after a completed scan', () => {
  const text = renderGraphPrompt(new Map(), true)
  assert.match(text, /No graph is registered yet/)
  assert.doesNotMatch(text, /Registered graphs:/)
})

test('caps the prompt list and points at the full listing', () => {
  const registry = new Map()
  for (let index = 0; index < 26; index += 1) {
    registry.set(`graph-${index}`, { id: `graph-${index}`, description: `Graph ${index}.` })
  }
  const text = renderGraphPrompt(registry, true)
  const listed = text.split('\n').filter(line => line.startsWith('- graph-'))
  assert.equal(listed.length, 24)
  assert.match(text, /and 2 more/)
})
