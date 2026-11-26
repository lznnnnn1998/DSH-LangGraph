import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderGraphPrompt } from '../index.js'

test('hints at discovery before the first scan', () => {
  const text = renderGraphPrompt(new Map(), false)
  assert.match(text, /langgraph_run/)
  assert.match(text, /list the registered graphs/)
  assert.doesNotMatch(text, /Registered graphs:/)
})

test('states the graph vocabulary, selection policy, and registry', () => {
  const registry = new Map([
    ['b', { id: 'b', description: 'Second graph.' }],
    ['a', { id: 'a', description: 'First\ngraph.' }],
    ['broken', { id: 'broken', error: new Error('bad module') }],
  ])
  const text = renderGraphPrompt(registry, true)

  // Vocabulary and boundary with DSH.
  assert.match(text, /profile-registered/)
  assert.match(text, /not the `workflow` tool/)
  assert.match(text, /not a DSH Session/)

  // Selection policy, as concepts rather than exact prose.
  assert.match(text, /Use `langgraph_run` when:/)
  assert.match(text, /names one of the graph ids/)
  assert.match(text, /matches the requested output/)
  assert.match(text, /durable LangGraph thread/)
  assert.match(text, /cannot define a new one/)

  // Registry and discovery.
  assert.match(text, /Registered graphs:/)
  assert.match(text, /- a: First graph/)
  assert.match(text, /- b: Second graph/)
  assert.doesNotMatch(text, /broken/)
  assert.match(text, /Omit `graph` to list input schemas/)
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
