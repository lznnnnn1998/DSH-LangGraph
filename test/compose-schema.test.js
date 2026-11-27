import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { validateSpec } from '../compose/schema.js'

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/specs/${name}.json`, import.meta.url), 'utf8'))
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function minimal() {
  return {
    ir: 1,
    state: { text: { type: 'string', default: '' } },
    nodes: [{ id: 'one', do: 'set', values: { text: 'hi' } }],
    edges: [{ from: 'START', to: 'one' }, { from: 'one', to: 'END' }],
  }
}

function errorsOf(spec, options) {
  return validateSpec(spec, options).errors
}

function hasPath(errors, path) {
  return errors.some(error => error.path === path)
}

function cycleSpec() {
  return {
    ir: 1,
    state: {
      note: { type: 'string', default: '' },
      attempts: { type: 'number', default: 0 },
      verdict: { type: 'string', default: '' },
    },
    nodes: [
      { id: 'scan', do: 'set', values: { note: 'scan' } },
      { id: 'read', do: 'set', values: { note: 'read' } },
      { id: 'judge', do: 'model', prompt: ['judge'], out: { verdict: 'text' } },
      { id: 'retry', do: 'set', values: { attempts: 1 } },
      { id: 'gate', do: 'gate', question: 'Continue?', out: {} },
    ],
    edges: [
      { from: 'START', to: 'scan' },
      { from: 'scan', to: 'read' },
      { from: 'read', to: 'judge' },
      { from: 'judge', to: 'gate', when: { op: 'eq', args: [{ $state: 'verdict' }, 'large'] } },
      { from: 'judge', to: 'END', when: true },
      { from: 'judge', to: 'retry', when: { op: 'eq', args: [{ $state: 'verdict' }, 'retry'] } },
      { from: 'retry', to: 'read' },
      { from: 'gate', to: 'END' },
    ],
  }
}

test('the v1 fixtures are valid', () => {
  for (const name of ['scan-report', 'approval-gate', 'ask-tools', 'parallel']) {
    const result = validateSpec(fixture(name), { tools: ['glob', 'read'] })
    assert.deepEqual(result.errors, [], name)
    assert.equal(result.ok, true, name)
  }
})

test('rejects a wrong IR version and unknown fields', () => {
  const wrongVersion = clone(minimal())
  wrongVersion.ir = 2
  assert.ok(hasPath(errorsOf(wrongVersion), 'ir'))

  const extraTop = clone(minimal())
  extraTop.loop = true
  assert.ok(hasPath(errorsOf(extraTop), 'loop'))

  const extraNode = clone(minimal())
  extraNode.nodes[0].tool = 'read'
  assert.ok(hasPath(errorsOf(extraNode), 'nodes[0].tool'))
})

test('rejects duplicate and reserved node ids', () => {
  const duplicate = clone(minimal())
  duplicate.nodes.push({ id: 'one', do: 'set', values: { text: 'again' } })
  assert.ok(hasPath(errorsOf(duplicate), 'nodes[1].id'))

  const reserved = clone(minimal())
  reserved.nodes[0].id = 'START'
  assert.ok(hasPath(errorsOf(reserved), 'nodes[0].id'))

  const unknown = clone(minimal())
  unknown.nodes[0].do = 'loop'
  assert.ok(hasPath(errorsOf(unknown), 'nodes[0].do'))
})

test('rejects invalid state definitions', () => {
  const missingDefault = clone(minimal())
  delete missingDefault.state.text.default
  assert.ok(hasPath(errorsOf(missingDefault), 'state.text.default'))

  const badDefault = clone(minimal())
  badDefault.state.text.default = 3
  assert.ok(hasPath(errorsOf(badDefault), 'state.text.default'))

  const badReducer = clone(minimal())
  badReducer.state.text.reducer = 'append'
  const badReducerErrors = errorsOf(badReducer)
  assert.ok(hasPath(badReducerErrors, 'state.text.reducer'))

  const dottedName = clone(minimal())
  dottedName.state['a.b'] = { type: 'string', default: '' }
  assert.ok(hasPath(errorsOf(dottedName), 'state.a.b'))

  const empty = clone(minimal())
  empty.state = {}
  assert.ok(hasPath(errorsOf(empty), 'state'))
})

test('rejects unknown state references and dotted paths into non-json fields', () => {
  const spec = fixture('scan-report')
  spec.nodes[0].args.pattern = { $state: 'missing' }
  const unknown = errorsOf(spec)
  assert.ok(hasPath(unknown, 'nodes[0].args.pattern'))

  const dotted = clone(minimal())
  dotted.nodes[0].values.text = { $state: 'text.value' }
  const dottedErrors = errorsOf(dotted)
  assert.ok(dottedErrors.some(error => error.path === 'nodes[0].values.text' && /json field/.test(error.message)))

  const malformed = clone(minimal())
  malformed.nodes[0].values.text = { $state: 'text', extra: true }
  assert.ok(hasPath(errorsOf(malformed), 'nodes[0].values.text'))
})

test('rejects transforms and set values that do not fit the field type', () => {
  const transform = fixture('scan-report')
  transform.nodes[0].out.files = 'text'
  assert.ok(hasPath(errorsOf(transform), 'nodes[0].out.files'))

  const unknownTransform = fixture('scan-report')
  unknownTransform.nodes[0].out.files = 'words'
  assert.ok(hasPath(errorsOf(unknownTransform), 'nodes[0].out.files'))

  const unknownField = fixture('scan-report')
  unknownField.nodes[0].out.missing = 'text'
  assert.ok(hasPath(errorsOf(unknownField), 'nodes[0].out.missing'))

  const setValue = fixture('scan-report')
  setValue.nodes[2].values.report = 3
  assert.ok(hasPath(errorsOf(setValue), 'nodes[2].values.report'))

  const refType = fixture('scan-report')
  refType.nodes[2].values.report = { $state: 'files' }
  const refErrors = errorsOf(refType)
  assert.ok(refErrors.some(error => error.path === 'nodes[2].values.report' && /cannot assign/.test(error.message)))
})

test('checks tool visibility when the caller knows it', () => {
  const scan = fixture('scan-report')
  const invisible = errorsOf(scan, { tools: ['read'] })
  assert.ok(hasPath(invisible, 'nodes[0].tool'))

  const agent = fixture('ask-tools')
  const invisibleAgent = errorsOf(agent, { tools: ['glob'] })
  assert.ok(hasPath(invisibleAgent, 'nodes[0].tools[1]'))

  assert.deepEqual(errorsOf(agent, { tools: ['glob', 'read'] }), [])
})

test('rejects invalid edges', () => {
  const noStart = fixture('scan-report')
  noStart.edges = noStart.edges.filter(edge => edge.from !== 'START')
  assert.ok(errorsOf(noStart).some(error => error.path === 'edges' && /from START/.test(error.message)))

  const conditionalStart = fixture('scan-report')
  conditionalStart.edges[0].when = true
  assert.ok(hasPath(errorsOf(conditionalStart), 'edges[0].when'))

  const endOut = fixture('scan-report')
  endOut.edges.push({ from: 'END', to: 'scan' })
  assert.ok(hasPath(errorsOf(endOut), 'edges[6].from'))

  const unknownTarget = fixture('scan-report')
  unknownTarget.edges[1].to = 'missing'
  assert.ok(hasPath(errorsOf(unknownTarget), 'edges[1].to'))

  const mixed = fixture('scan-report')
  mixed.edges.push({ from: 'judge', to: 'large' })
  const mixedErrors = errorsOf(mixed)
  assert.ok(mixedErrors.some(error => error.path === 'nodes.judge' && /mix/.test(error.message)))

  const duplicate = fixture('scan-report')
  duplicate.edges.push({ from: 'scan', to: 'judge' })
  assert.ok(hasPath(errorsOf(duplicate), 'edges[6]'))

  const extraField = fixture('scan-report')
  extraField.edges[0].label = 'start'
  assert.ok(hasPath(errorsOf(extraField), 'edges[0].label'))
})

test('rejects malformed guards', () => {
  const spec = fixture('scan-report')
  spec.edges[2].when = { op: 'contains', args: [] }
  assert.ok(hasPath(errorsOf(spec), 'edges[2].when.op'))

  const arity = fixture('scan-report')
  arity.edges[2].when = { op: 'eq', args: [true] }
  assert.ok(hasPath(errorsOf(arity), 'edges[2].when.args'))

  const type = fixture('scan-report')
  type.edges[2].when = { op: 'gt', args: [{ $state: 'verdict' }, 3] }
  const typeErrors = errorsOf(type)
  assert.ok(typeErrors.some(error => error.path === 'edges[2].when.args[0]' && /compares numbers/.test(error.message)))

  const inType = fixture('scan-report')
  inType.edges[2].when = { op: 'in', args: [{ $state: 'verdict' }, 'large'] }
  assert.ok(hasPath(errorsOf(inType), 'edges[2].when.args[1]'))

  const never = fixture('scan-report')
  never.edges[2].when = { op: 'eq', args: [{ $state: 'verdict' }, true] }
  const neverErrors = errorsOf(never)
  assert.ok(neverErrors.some(error => /can never be equal/.test(error.message)))
})

test('rejects invalid output and budgets', () => {
  const output = fixture('scan-report')
  output.output = ['missing']
  assert.ok(hasPath(errorsOf(output), 'output[0]'))

  const duplicateOutput = fixture('scan-report')
  duplicateOutput.output = ['verdict', 'verdict']
  assert.ok(hasPath(errorsOf(duplicateOutput), 'output[1]'))

  const maxSteps = fixture('scan-report')
  maxSteps.maxSteps = 0
  assert.ok(hasPath(errorsOf(maxSteps), 'maxSteps'))

  const tooMany = clone(minimal())
  tooMany.nodes = Array.from({ length: 65 }, (_value, index) => ({
    id: `n${index}`,
    do: 'set',
    values: { text: 'x' },
  }))
  tooMany.edges = [{ from: 'START', to: 'n0' }, { from: 'n0', to: 'END' }]
  assert.ok(errorsOf(tooMany).some(error => /too many nodes/.test(error.message)))
})

test('warns about terminal, unreachable, and cyclic shapes without rejecting them', () => {
  const terminal = clone(minimal())
  terminal.edges = [{ from: 'START', to: 'one' }]
  const terminalResult = validateSpec(terminal)
  assert.equal(terminalResult.ok, true)
  assert.ok(terminalResult.warnings.some(warning => warning.code === 'terminal'))

  const unreachable = clone(minimal())
  unreachable.nodes.push({ id: 'two', do: 'set', values: { text: 'two' } })
  const unreachableResult = validateSpec(unreachable)
  assert.equal(unreachableResult.ok, true)
  assert.ok(unreachableResult.warnings.some(warning => warning.code === 'unreachable'))

  const cycle = cycleSpec()
  const cycleResult = validateSpec(cycle)
  assert.equal(cycleResult.ok, true)
  assert.ok(cycleResult.warnings.some(warning => warning.code === 'cycle'))
  assert.ok(cycleResult.warnings.some(warning => warning.code === 'cycle-budget'))
  assert.ok(!cycleResult.warnings.some(warning => warning.code === 'cycle-exit'))
  assert.ok(!cycleResult.warnings.some(warning => warning.code === 'cycle-counter'))
})

test('rejects parallel branches that write one field without a mergeable reducer', () => {
  const spec = fixture('parallel')
  spec.state.all.reducer = 'replace'
  const result = validateSpec(spec)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(error => error.path === 'state.all' && /parallel branches/.test(error.message)))
})

test('hints how to build a string[] for a map and warns about a bool gate with labels', () => {
  const mapSpec = {
    ir: 1,
    state: {
      items: { type: 'string', default: '' },
      out: { type: 'string[]', default: [], reducer: 'append' },
    },
    nodes: [{
      id: 'walk',
      do: 'map',
      over: 'items',
      body: { do: 'tool', tool: 'glob', args: {}, out: { out: 'lines' } },
    }],
    edges: [{ from: 'START', to: 'walk' }, { from: 'walk', to: 'END' }],
  }
  const mapResult = validateSpec(mapSpec, { tools: ['glob'] })
  assert.equal(mapResult.ok, false)
  const overError = mapResult.errors.find(error => error.path === 'nodes[0].over')
  assert.ok(overError)
  assert.match(overError.hint, /lines/)

  const gateSpec = {
    ir: 1,
    state: { approved: { type: 'boolean', default: false } },
    nodes: [{ id: 'ask', do: 'gate', question: 'OK?', options: ['Approve', 'Reject'], out: { approved: 'bool' } }],
    edges: [{ from: 'START', to: 'ask' }, { from: 'ask', to: 'END' }],
  }
  const gateResult = validateSpec(gateSpec)
  assert.equal(gateResult.ok, true)
  assert.ok(gateResult.warnings.some(warning => warning.code === 'gate-bool-options'))
})
