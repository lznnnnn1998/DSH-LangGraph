import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, renderGraphPrompt } from '../index.js'
import { createContext, createStorageDomain, exec } from './support/harness.js'

function registry() {
  return new Map([
    ['scan-report', { id: 'scan-report', description: 'Scan and report.' }],
  ])
}

function linearSpec(count) {
  return {
    ir: 1,
    state: { text: { type: 'string', default: '' } },
    nodes: Array.from({ length: count }, (_value, index) => ({
      id: `n${index}`,
      do: 'set',
      values: { text: `v${index}` },
    })),
    edges: [
      { from: 'START', to: 'n0' },
      ...Array.from({ length: count - 1 }, (_value, index) => ({ from: `n${index}`, to: `n${index + 1}` })),
      { from: `n${count - 1}`, to: 'END' },
    ],
  }
}

function setup() {
  const ctx = createContext(createStorageDomain())
  apply(ctx, { prompt: false, ui: false })
  ctx.tools.definitions = () => [{ name: 'glob' }, { name: 'read' }]
  return { ctx, compose: ctx.tools.get('langgraph_compose') }
}

test('the prompt names the graph tools and the hard boundaries', () => {
  const text = renderGraphPrompt(registry(), true)
  assert.match(text, /langgraph_run/)
  assert.match(text, /langgraph_threads/)
  assert.match(text, /langgraph_compose/)
  assert.match(text, /not the `workflow` tool/)
  assert.match(text, /not a DSH Session/)
  assert.doesNotMatch(text, /cannot define a new one/)
  assert.match(text, /Registered graphs:/)
  assert.match(text, /- scan-report: Scan and report\./)
})

test('the prompt names the tools before a scan and with no registry', () => {
  const before = renderGraphPrompt(new Map(), false)
  assert.match(before, /langgraph_run/)
  assert.match(before, /langgraph_compose/)
  assert.doesNotMatch(before, /Registered graphs:/)

  const empty = renderGraphPrompt(new Map(), true)
  assert.match(empty, /No graph/)
  assert.match(empty, /langgraph_compose/)
  assert.doesNotMatch(empty, /Registered graphs:/)
})

test('apply registers the compose tool and the prompt section', async () => {
  const ctx = createContext(createStorageDomain(), { systemPrompt: true })
  apply(ctx)
  try {
    const compose = ctx.tools.get('langgraph_compose')
    assert.ok(compose, 'the compose tool is registered')
    assert.match(compose.description, /langgraph_run/)
    assert.deepEqual(compose.parameters.required, ['action'])
    assert.ok(compose.parameters.properties.from)
    assert.ok(compose.parameters.properties.thread)
    assert.deepEqual(compose.parameters.properties.action.enum, [
      'describe',
      'validate',
      'compose',
      'list',
      'get',
      'delete',
      'fork',
    ])

    await ctx.tools.get('langgraph_run').execute({}, exec())
    await new Promise(resolve => setImmediate(resolve))
    const text = ctx.sections[0].text()
    assert.match(text, /langgraph_compose/)
    assert.doesNotMatch(text, /cannot define a new one/)
  } finally {
    ctx.dispose()
  }
})

test('warns about too many nodes and a long linear chain', async () => {
  const { ctx, compose } = setup()
  const result = await compose.execute({ action: 'validate', spec: linearSpec(13) }, exec())
  assert.equal(result.ok, true)
  assert.ok(result.warnings.some(warning => warning.code === 'too-many-nodes'))
  assert.ok(result.warnings.some(warning => warning.code === 'long-chain'))
  ctx.dispose()
})

test('warns about a tiny linear graph', async () => {
  const { ctx, compose } = setup()
  const result = await compose.execute({
    action: 'validate',
    spec: {
      ir: 1,
      state: { text: { type: 'string', default: '' } },
      nodes: [{ id: 'one', do: 'set', values: { text: 'hi' } }],
      edges: [{ from: 'START', to: 'one' }, { from: 'one', to: 'END' }],
    },
  }, exec())
  assert.equal(result.ok, true)
  assert.ok(result.warnings.some(warning => warning.code === 'tiny-graph'))
  ctx.dispose()
})

test('warns about a literal-only tool node', async () => {
  const { ctx, compose } = setup()
  const result = await compose.execute({
    action: 'validate',
    spec: {
      ir: 1,
      state: { files: { type: 'string[]', default: [] } },
      nodes: [{ id: 'scan', do: 'tool', tool: 'glob', args: { pattern: '**/*.js' }, out: { files: 'lines' } }],
      edges: [{ from: 'START', to: 'scan' }, { from: 'scan', to: 'END' }],
    },
  }, exec())
  assert.equal(result.ok, true)
  assert.ok(result.warnings.some(warning => warning.code === 'literal-tool'))
  ctx.dispose()
})

test('warns when a model feeds a single tool node', async () => {
  const { ctx, compose } = setup()
  const result = await compose.execute({
    action: 'validate',
    spec: {
      ir: 1,
      state: {
        text: { type: 'string', default: '' },
        files: { type: 'string[]', default: [] },
      },
      nodes: [
        { id: 'judge', do: 'model', prompt: ['judge'], out: { text: 'text' } },
        { id: 'scan', do: 'tool', tool: 'glob', args: { pattern: { $state: 'text' } }, out: { files: 'lines' } },
      ],
      edges: [
        { from: 'START', to: 'judge' },
        { from: 'judge', to: 'scan' },
        { from: 'scan', to: 'END' },
      ],
    },
  }, exec())
  assert.equal(result.ok, true)
  assert.ok(result.warnings.some(warning => warning.code === 'model-then-tool'))
  ctx.dispose()
})
