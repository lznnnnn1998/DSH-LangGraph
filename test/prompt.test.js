import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderGraphPrompt } from '../index.js'

test('renders a discovery hint before the first scan', () => {
  const text = renderGraphPrompt(new Map(), false)
  assert.match(text, /langgraph_run/)
  assert.match(text, /Call it with no `graph` to list/)
  assert.doesNotMatch(text, /Registered graphs:/)
})

test('lists available graphs, distinguishes the workflow tool, and skips broken modules', () => {
  const registry = new Map([
    ['b', { id: 'b', description: 'Second graph.' }],
    ['a', { id: 'a', description: 'First\ngraph.' }],
    ['broken', { id: 'broken', error: new Error('bad module') }],
  ])
  const text = renderGraphPrompt(registry, true)
  assert.match(text, /Registered graphs:/)
  assert.match(text, /- a: First graph\./)
  assert.match(text, /- b: Second graph\./)
  assert.doesNotMatch(text, /broken/)
  assert.match(text, /This is not the `workflow` tool/)
  assert.match(text, /clearly matches one of the registered graph descriptions/)
  assert.match(text, /do not reimplement a matching graph with bash, subagent, or ad-hoc steps/)
  assert.match(text, /langgraph_threads/)
  assert.match(text, /Omit `graph` to see each graph's input schema\./)
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
