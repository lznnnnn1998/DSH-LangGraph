import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defineGraph } from '../index.js'
import { langchainTool, zodFromJsonSchema } from '../dsh-tools.js'

test('converts the DSH JSON-schema subset to zod', () => {
  const schema = zodFromJsonSchema({
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      limit: { type: 'integer' },
      mode: { type: 'string', enum: ['fast', 'safe'] },
      files: { type: 'array', items: { type: 'string' } },
    },
    required: ['pattern'],
    additionalProperties: false,
  })
  assert.deepEqual(schema.parse({ pattern: '**/*.js', limit: 2, mode: 'fast', files: ['a.js'] }), {
    pattern: '**/*.js',
    limit: 2,
    mode: 'fast',
    files: ['a.js'],
  })
  assert.equal(schema.safeParse({}).success, false)
  assert.equal(schema.safeParse({ pattern: 1 }).success, false)
})

test('wraps a DSH tool as a LangChain tool', async () => {
  const definition = {
    name: 'glob',
    description: 'Glob a pattern.',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string' } },
      required: ['pattern'],
      additionalProperties: false,
    },
  }
  const calls = []
  const wrapped = langchainTool(definition, async (name, args) => {
    calls.push({ name, args })
    return 'a.js\nb.js'
  })
  assert.equal(wrapped.name, 'glob')
  assert.deepEqual(wrapped.dshParameters, definition.parameters)
  assert.equal(await wrapped.invoke({ pattern: '**/*.js' }), 'a.js\nb.js')
  assert.deepEqual(calls, [{ name: 'glob', args: { pattern: '**/*.js' } }])
})

test('defineGraph is an identity guard', () => {
  const graph = { id: 'x', build() {} }
  assert.equal(defineGraph(graph), graph)
  assert.throws(() => defineGraph(null), /must be an object/)
})
