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
  assert.match(text, /LangGraph graphs are available/)
  assert.match(text, /This is not the `workflow` tool/)
  assert.match(text, /do not reimplement a matching graph/)
  assert.match(text, /Registered graphs:/)
  assert.match(text, /- ask-user:/)
  ctx.dispose()
})

test('config.prompt: false registers no section', () => {
  const ctx = createContext(createStorageDomain(), { systemPrompt: true })
  apply(ctx, { prompt: false })
  assert.equal(ctx.sections.length, 0)
  ctx.dispose()
})
