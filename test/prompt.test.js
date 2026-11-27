import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderGraphPrompt } from '../index.js'

test('hints at discovery before the first scan', () => {
  const text = renderGraphPrompt(new Map(), false)
  assert.match(text, /langgraph_run/)
  assert.match(text, /langgraph_compose/)
  assert.doesNotMatch(text, /Registered graphs:/)
})

test('states the graph vocabulary, boundaries, and registry', () => {
  const registry = new Map([
    ['b', { id: 'b', description: 'Second graph.' }],
    ['a', { id: 'a', description: 'First\ngraph.' }],
    ['broken', { id: 'broken', error: new Error('bad module') }],
  ])
  const text = renderGraphPrompt(registry, true)

  // Vocabulary and boundary with DSH, not the selection sentences.
  assert.match(text, /langgraph_run/)
  assert.match(text, /langgraph_threads/)
  assert.match(text, /langgraph_compose/)
  assert.match(text, /profile-registered/)
  assert.match(text, /not the `workflow` tool/)
  assert.match(text, /not a DSH Session/)
  assert.doesNotMatch(text, /cannot define a new one/)

  // Registry and discovery.
  assert.match(text, /Registered graphs:/)
  assert.match(text, /- a: First graph/)
  assert.match(text, /- b: Second graph/)
  assert.doesNotMatch(text, /broken/)
  assert.match(text, /Omit `graph` to list/)
})

test('reports an empty registry after a completed scan', () => {
  const text = renderGraphPrompt(new Map(), true)
  assert.match(text, /No graph/)
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
