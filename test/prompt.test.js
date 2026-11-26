import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderGraphPrompt } from '../index.js'

test('renders a discovery hint before the first scan', () => {
  const text = renderGraphPrompt(new Map(), false)
  assert.match(text, /langgraph_run/)
  assert.match(text, /Call it with no `graph` to list/)
  assert.doesNotMatch(text, /Registered workflows/)
})

test('lists available graphs and skips broken modules', () => {
  const registry = new Map([
    ['b', { id: 'b', description: 'Second workflow.' }],
    ['a', { id: 'a', description: 'First\nworkflow.' }],
    ['broken', { id: 'broken', error: new Error('bad module') }],
  ])
  const text = renderGraphPrompt(registry, true)
  assert.match(text, /Registered workflows:/)
  assert.match(text, /- a: First workflow\./)
  assert.match(text, /- b: Second workflow\./)
  assert.doesNotMatch(text, /broken/)
  assert.match(text, /langgraph_threads/)
  assert.match(text, /Omit `graph` to see each workflow's input schema\./)
})

test('reports an empty registry after a completed scan', () => {
  const text = renderGraphPrompt(new Map(), true)
  assert.match(text, /No workflow is registered yet/)
  assert.doesNotMatch(text, /Registered workflows:/)
})

test('caps the prompt list and points at the full listing', () => {
  const registry = new Map()
  for (let index = 0; index < 26; index += 1) {
    registry.set(`graph-${index}`, { id: `graph-${index}`, description: `Workflow ${index}.` })
  }
  const text = renderGraphPrompt(registry, true)
  const listed = text.split('\n').filter(line => line.startsWith('- graph-'))
  assert.equal(listed.length, 24)
  assert.match(text, /and 2 more/)
})
