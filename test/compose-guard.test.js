import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateGuard } from '../compose/guard.js'
import { validateSpec } from '../compose/schema.js'
import { readState } from '../compose/template.js'

const state = {
  verdict: 'large',
  count: 7,
  big: true,
  files: ['a', 'b'],
  nested: { answer: 'yes', count: 2 },
}

function guardSpec(guard) {
  return {
    ir: 1,
    state: {
      verdict: { type: 'string', default: '' },
      count: { type: 'number', default: 0 },
      data: { type: 'json', default: {} },
    },
    nodes: [
      { id: 'a', do: 'set', values: { verdict: 'large' } },
      { id: 'b', do: 'set', values: { count: 1 } },
    ],
    edges: [
      { from: 'START', to: 'a' },
      { from: 'a', to: 'b', when: guard },
      { from: 'a', to: 'END', when: true },
      { from: 'b', to: 'END' },
    ],
  }
}

function guardErrors(guard) {
  return validateSpec(guardSpec(guard)).errors
    .filter(error => error.path.startsWith('edges[1].when'))
}

test('reads dotted state paths and array indexes', () => {
  assert.equal(readState(state, 'verdict'), 'large')
  assert.equal(readState(state, 'nested.answer'), 'yes')
  assert.equal(readState(state, 'files.0'), 'a')
  assert.equal(readState(state, 'files.9'), undefined)
  assert.equal(readState(state, 'missing.path'), undefined)
  assert.equal(readState(state, 'verdict.value'), undefined)
})

test('evaluates comparisons and membership', () => {
  assert.equal(evaluateGuard({ op: 'eq', args: [{ $state: 'verdict' }, 'large'] }, state), true)
  assert.equal(evaluateGuard({ op: 'eq', args: [{ $state: 'verdict' }, 'small'] }, state), false)
  assert.equal(evaluateGuard({ op: 'ne', args: [{ $state: 'verdict' }, 'small'] }, state), true)
  assert.equal(evaluateGuard({ op: 'in', args: [{ $state: 'verdict' }, ['small', 'large']] }, state), true)
  assert.equal(evaluateGuard({ op: 'in', args: [{ $state: 'count' }, [1, 2]] }, state), false)
  assert.equal(evaluateGuard({ op: 'gt', args: [{ $state: 'count' }, 5] }, state), true)
  assert.equal(evaluateGuard({ op: 'gte', args: [{ $state: 'count' }, 7] }, state), true)
  assert.equal(evaluateGuard({ op: 'lt', args: [{ $state: 'count' }, 8] }, state), true)
  assert.equal(evaluateGuard({ op: 'lte', args: [{ $state: 'count' }, 7] }, state), true)
  assert.equal(evaluateGuard({ op: 'eq', args: [{ $state: 'files' }, ['a', 'b']] }, state), true)
})

test('returns false for missing values and type mismatches instead of throwing', () => {
  assert.equal(evaluateGuard({ op: 'eq', args: [{ $state: 'missing' }, 'x'] }, state), false)
  assert.equal(evaluateGuard({ op: 'exists', args: [{ $state: 'missing' }] }, state), false)
  assert.equal(evaluateGuard({ op: 'exists', args: [{ $state: 'nested.answer' }] }, state), true)
  assert.equal(evaluateGuard({ op: 'exists', args: [{ $state: 'nested.missing' }] }, state), false)
  assert.equal(evaluateGuard({ op: 'gt', args: [{ $state: 'verdict' }, 5] }, state), false)
  assert.equal(evaluateGuard({ op: 'gt', args: [{ $state: 'count' }, '5'] }, state), false)
  assert.equal(evaluateGuard({ op: 'in', args: [{ $state: 'verdict' }, 'large'] }, state), false)
  assert.equal(evaluateGuard({ op: 'unknown', args: [] }, state), false)
  assert.equal(evaluateGuard('large', state), false)
})

test('evaluates boolean composition and literal guards', () => {
  assert.equal(evaluateGuard(true, state), true)
  assert.equal(evaluateGuard(false, state), false)
  assert.equal(evaluateGuard({
    op: 'and',
    args: [
      { op: 'eq', args: [{ $state: 'verdict' }, 'large'] },
      { op: 'gt', args: [{ $state: 'count' }, 5] },
    ],
  }, state), true)
  assert.equal(evaluateGuard({
    op: 'or',
    args: [
      { op: 'eq', args: [{ $state: 'verdict' }, 'small'] },
      { op: 'gt', args: [{ $state: 'count' }, 5] },
    ],
  }, state), true)
  assert.equal(evaluateGuard({
    op: 'not',
    args: [{ op: 'eq', args: [{ $state: 'verdict' }, 'small'] }],
  }, state), true)
})

test('accepts well-formed guards', () => {
  assert.deepEqual(guardErrors({
    op: 'and',
    args: [
      { op: 'eq', args: [{ $state: 'verdict' }, 'large'] },
      { op: 'gt', args: [{ $state: 'count' }, 5] },
    ],
  }), [])
  assert.deepEqual(guardErrors({ op: 'exists', args: [{ $state: 'data.label' }] }), [])
})

test('rejects malformed guard operators and arity', () => {
  assert.ok(guardErrors({ op: 'contains', args: [] }).some(error => error.path === 'edges[1].when.op'))
  assert.ok(guardErrors({ op: 'eq', args: [true] }).some(error => error.path === 'edges[1].when.args'))
  assert.ok(guardErrors({ op: 'exists', args: [] }).some(error => error.path === 'edges[1].when.args'))
  assert.ok(guardErrors({ op: 'not', args: [] }).some(error => error.path === 'edges[1].when.args'))
  assert.ok(guardErrors('large').some(error => error.path === 'edges[1].when'))
})

test('rejects guards whose operands cannot be compared', () => {
  const gt = guardErrors({ op: 'gt', args: [{ $state: 'verdict' }, 3] })
  assert.ok(gt.some(error => error.path === 'edges[1].when.args[0]' && /compares numbers/.test(error.message)))

  const membership = guardErrors({ op: 'in', args: [{ $state: 'verdict' }, 'large'] })
  assert.ok(membership.some(error => error.path === 'edges[1].when.args[1]' && /array on the right/.test(error.message)))

  const never = guardErrors({ op: 'eq', args: [{ $state: 'count' }, 'one'] })
  assert.ok(never.some(error => /can never be equal/.test(error.message)))

  const unknown = guardErrors({ op: 'eq', args: [{ $state: 'missing' }, 'x'] })
  assert.ok(unknown.some(error => /does not name a declared field/.test(error.message)))
})

test('rejects a nested guard where only an operand is allowed', () => {
  const errors = guardErrors({ op: 'eq', args: [{ op: 'gt', args: [1, 0] }, true] })
  assert.ok(errors.some(error => error.path === 'edges[1].when.args[0]' && /nested guard/.test(error.message)))
})
