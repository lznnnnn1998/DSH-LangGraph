import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as langgraph from '@langchain/langgraph'
import { Command } from '@langchain/langgraph'
import { MemorySaver } from '@langchain/langgraph-checkpoint'
import { buildSpecGraph } from '../compose/build.js'
import { validateSpec } from '../compose/schema.js'

const FIXTURES = [
  'scan-report',
  'approval-gate',
  'ask-tools',
  'parallel',
  'map-report',
  'ask-workspace',
  'ask-subagent',
  'ask-user',
]

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/specs/${name}.json`, import.meta.url), 'utf8'))
}

function compile(spec, helpers, saver = new MemorySaver()) {
  return buildSpecGraph({ ...langgraph, helpers }, spec).compile({ checkpointer: saver })
}

function config(thread) {
  return { configurable: { thread_id: thread } }
}

function findNodeId(error) {
  let current = error
  for (let depth = 0; current !== null && current !== undefined && depth < 10; depth += 1) {
    if (current.nodeId !== undefined) return current.nodeId
    current = current.cause
  }
  return undefined
}

test('every v1 fixture validates and builds', () => {
  for (const name of FIXTURES) {
    const result = validateSpec(fixture(name), { tools: ['glob', 'read'] })
    assert.equal(result.ok, true, `${name}: ${JSON.stringify(result.errors)}`)
    assert.doesNotThrow(() => buildSpecGraph({ ...langgraph, helpers: {} }, fixture(name)), name)
  }
})

test('ask-workspace: a tool then a model', async () => {
  let prompt
  let system
  const helpers = {
    async callTool(name, args) {
      assert.equal(name, 'glob')
      assert.equal(args.pattern, '**/*.md')
      return 'README.md'
    },
    async callModel(value, options) {
      prompt = value
      system = options.system
      return { text: 'A documentation repository.' }
    },
  }
  const state = await compile(fixture('ask-workspace'), helpers).invoke({}, config('conformance-workspace'))
  assert.match(prompt, /README\.md/)
  assert.match(system, /repository layout/)
  assert.equal(state.explanation, 'A documentation repository.')
})

test('ask-tools: an agent node over the session tools', async () => {
  let brief
  const helpers = {
    chatModel() {
      return {}
    },
    tools(names) {
      return names.map(name => ({ name }))
    },
    async createReactAgent(options) {
      assert.deepEqual(options.tools.map(tool => tool.name), ['glob', 'read'])
      return {
        async invoke({ messages }) {
          brief = messages[0][1]
          return { messages: [{ content: 'A DSH plugin.' }] }
        },
      }
    },
  }
  const state = await compile(fixture('ask-tools'), helpers).invoke({ question: 'What is this?' }, config('conformance-tools'))
  assert.equal(brief, 'What is this?')
  assert.equal(state.answer, 'A DSH plugin.')
})

test('ask-subagent: delegates to a child session', async () => {
  let subagentPrompt
  const helpers = {
    async subagent(prompt, options) {
      subagentPrompt = prompt
      assert.deepEqual(options, {})
      return { text: 'A Node project.', stopReason: 'completed' }
    },
  }
  const state = await compile(fixture('ask-subagent'), helpers).invoke({ question: 'What is this?' }, config('conformance-subagent'))
  assert.equal(subagentPrompt, 'Research this workspace and answer briefly: What is this?')
  assert.equal(state.answer, 'A Node project.')
})

test('a subagent can return structured output', async () => {
  const spec = fixture('ask-subagent')
  spec.state.data = { type: 'json', default: null }
  spec.nodes[0].schema = {
    type: 'object',
    properties: { value: { type: 'number' } },
    required: ['value'],
    additionalProperties: false,
  }
  spec.nodes[0].out = { data: 'json' }
  const helpers = {
    async subagent(prompt, options) {
      assert.ok(options.schema)
      return { text: '{"value":7}', structured: { value: 7 }, stopReason: 'completed' }
    },
  }
  const state = await compile(spec, helpers).invoke({}, config('conformance-subagent-schema'))
  assert.deepEqual(state.data, { value: 7 })
})

test('a failed subagent fails its node', async () => {
  const helpers = {
    async subagent() {
      return { text: '', stopReason: 'error' }
    },
  }
  await assert.rejects(
    compile(fixture('ask-subagent'), helpers).invoke({}, config('conformance-subagent-error')),
    error => {
      assert.equal(findNodeId(error), 'delegate')
      return true
    },
  )
})

test('ask-user: a gate pauses and resumes with the answer', async () => {
  const compiled = compile(fixture('ask-user'), {})
  const first = await compiled.invoke({}, config('conformance-user'))
  assert.ok(Array.isArray(first.__interrupt__))
  assert.match(first.__interrupt__[0].value.question, /Proceed with this workspace/)
  assert.deepEqual(first.__interrupt__[0].value.options, ['Yes', 'No'])

  const second = await compiled.invoke(new Command({ resume: 'Yes' }), config('conformance-user'))
  assert.equal(second.answer, 'Yes')
})
