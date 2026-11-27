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

test('the prompt teaches composing, coarse-first, and immutability', () => {
  const text = renderGraphPrompt(registry(), true)
  assert.match(text, /langgraph_compose/)
  assert.match(text, /at least three dependent steps/)
  assert.match(text, /4-8 phase nodes/)
  assert.match(text, /Use `agent` for open work/)
  assert.match(text, /one node per tool call/)
  assert.match(text, /immutable session-owned spec/)
  assert.match(text, /not a DSH Session/)
  assert.match(text, /status: "failed"/)
  assert.match(text, /lastSupersteps/)
  assert.match(text, /action: "fork"/)
  assert.doesNotMatch(text, /cannot define a new one/)
  assert.match(text, /Registered graphs:/)
  assert.match(text, /- scan-report: Scan and report\./)
})

test('the prompt still teaches composing before a scan and with no registry', () => {
  const before = renderGraphPrompt(new Map(), false)
  assert.match(before, /langgraph_compose/)
  assert.match(before, /4-8 phase nodes/)
  assert.match(before, /list the registered graphs/)

  const empty = renderGraphPrompt(new Map(), true)
  assert.match(empty, /No graph is registered yet/)
  assert.match(empty, /langgraph_compose/)
  assert.match(empty, /4-8 phase nodes/)
  assert.doesNotMatch(empty, /Registered graphs:/)
})

test('apply registers the compose tool and the prompt section', async () => {
  const ctx = createContext(createStorageDomain(), { systemPrompt: true })
  apply(ctx)
  try {
    const compose = ctx.tools.get('langgraph_compose')
    assert.ok(compose, 'the compose tool is registered')
    assert.match(compose.description, /4-8 phase nodes/)
    assert.match(compose.description, /immutable session spec/)
    assert.match(compose.description, /fork/)
    assert.deepEqual(compose.parameters.required, ['action'])

    await ctx.tools.get('langgraph_run').execute({}, exec())
    await new Promise(resolve => setImmediate(resolve))
    const text = ctx.sections[0].text()
    assert.match(text, /langgraph_compose/)
    assert.match(text, /4-8 phase nodes/)
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
