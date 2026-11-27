import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../index.js'
import { createContext, createStorageDomain, exec } from './support/harness.js'

test('registers the graph guidance before subagents, not in the workflow band', async () => {
  const ctx = createContext(createStorageDomain(), { systemPrompt: true })
  apply(ctx)

  assert.equal(ctx.sections.length, 1)
  const section = ctx.sections[0]
  assert.equal(section.name, 'tool:langgraph')
  assert.equal(section.order, 2790, 'TOOL_SUBAGENT (2800) minus 10')

  // Force the eager scan to finish, then read the section as the model would.
  await ctx.tools.get('langgraph_run').execute({}, exec())
  await new Promise(resolve => setImmediate(resolve))
  const text = section.text()
  assert.match(text, /profile-registered/)
  assert.match(text, /not the `workflow` tool/)
  assert.match(text, /matches the requested output/)
  assert.match(text, /not a DSH Session/)
  assert.match(text, /langgraph_compose/)
  assert.match(text, /4-8 phase nodes/)
  assert.match(text, /Registered graphs:/)
  assert.match(text, /- ask-user:/)

  const run = ctx.tools.get('langgraph_run')
  assert.match(run.description, /`workflow` tool/)
  assert.match(run.description, /composed with `langgraph_compose`/)
  assert.match(run.description, /DSH Sessions/)
  assert.match(run.parameters.properties.thread.description, /DSH Session id/)
  const threads = ctx.tools.get('langgraph_threads')
  assert.match(threads.description, /DSH Session/)
  assert.match(threads.description, /registered and composed/)
  assert.match(threads.parameters.properties.thread.description, /DSH Session id/)
  const compose = ctx.tools.get('langgraph_compose')
  assert.ok(compose, 'the compose tool is registered')
  assert.match(compose.description, /4-8 phase nodes/)
  assert.match(compose.description, /immutable session spec/)
  assert.deepEqual(compose.parameters.properties.action.enum, ['describe', 'validate', 'compose', 'list', 'get', 'delete'])
  ctx.dispose()
})

test('config.prompt: false registers no section', () => {
  const ctx = createContext(createStorageDomain(), { systemPrompt: true })
  apply(ctx, { prompt: false })
  assert.equal(ctx.sections.length, 0)
  ctx.dispose()
})
