import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { analyze, downstreamOf, fanOutProblems, lintWarnings, upstreamOf, writesField } from '../compose/analysis.js'
import { validateSpec } from '../compose/schema.js'

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/specs/${name}.json`, import.meta.url), 'utf8'))
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

test('computes SCCs, reachability and node ownership', () => {
  const spec = cycleSpec()
  const analysis = analyze(spec)
  const cyclic = analysis.sccs.filter(component => component.length > 1)
  assert.deepEqual(cyclic, [['judge', 'read', 'retry']])
  assert.equal(analysis.sccOf.get('read'), analysis.sccOf.get('judge'))
  assert.equal(analysis.sccOf.get('read'), analysis.sccOf.get('retry'))
  assert.notEqual(analysis.sccOf.get('scan'), analysis.sccOf.get('read'))
  assert.ok(analysis.reachableFromStart.has('gate'))
  assert.ok(analysis.reachableFromStart.has('END'))
  assert.ok(analysis.canReachEnd.has('scan'))
  assert.ok(analysis.canReachEnd.has('START'))
  assert.equal(writesField(analysis.nodes.get('retry'), 'attempts'), true)
  assert.equal(writesField(analysis.nodes.get('retry'), 'note'), false)
})

test('computes downstream and upstream sets for recovery', () => {
  const analysis = analyze(cycleSpec())
  assert.deepEqual(downstreamOf(analysis, 'retry'), ['END', 'gate', 'judge', 'read', 'retry'])
  assert.deepEqual(upstreamOf(analysis, 'read'), ['START', 'judge', 'read', 'retry', 'scan'])
})

test('is deterministic', () => {
  const spec = cycleSpec()
  assert.deepEqual(analyze(spec).sccs, analyze(spec).sccs)
  assert.deepEqual(analyze(spec).sccs.map(component => component.join(',')).sort(),
    ['gate', 'judge,read,retry', 'scan'])
})

test('accepts the parallel fixture and rejects a replace writer in a fan-out', () => {
  const spec = fixture('parallel')
  const analysis = analyze(spec)
  assert.deepEqual(fanOutProblems(spec, analysis), [])

  spec.state.all.reducer = 'replace'
  const problems = fanOutProblems(spec, analyze(spec))
  assert.equal(problems.length, 1)
  assert.equal(problems[0].path, 'state.all')
  assert.match(problems[0].message, /parallel branches left, right/)
})

test('warns about cycles, unreachable nodes and dead ends', () => {
  const cycle = cycleSpec()
  const cycleWarnings = lintWarnings(cycle, analyze(cycle))
  assert.ok(cycleWarnings.some(warning => warning.code === 'cycle'))
  assert.ok(cycleWarnings.some(warning => warning.code === 'cycle-budget'))
  assert.ok(!cycleWarnings.some(warning => warning.code === 'cycle-exit'))
  assert.ok(!cycleWarnings.some(warning => warning.code === 'cycle-counter'))

  const orphan = {
    ir: 1,
    state: { text: { type: 'string', default: '' } },
    nodes: [
      { id: 'one', do: 'set', values: { text: 'one' } },
      { id: 'two', do: 'set', values: { text: 'two' } },
    ],
    edges: [{ from: 'START', to: 'one' }, { from: 'one', to: 'END' }],
  }
  assert.equal(validateSpec(orphan).ok, true)
  const orphanWarnings = lintWarnings(orphan, analyze(orphan))
  assert.ok(orphanWarnings.some(warning => warning.code === 'unreachable' && warning.path === 'nodes.two'))
  assert.ok(orphanWarnings.some(warning => warning.code === 'terminal' && warning.path === 'nodes.two'))
})
