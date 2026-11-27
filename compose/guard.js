/**
 * Structured guard evaluation for graph edges.
 *
 * A guard is `true`, `false`, or `{ op, args }`; there is no expression string
 * and no `eval`. Missing state, a type mismatch, or a non-finite number makes a
 * comparison false instead of throwing, so an edge can never crash the run.
 */

import { deepEqual, isPlainObject, isStateRef, readState } from './template.js'

/** Resolve one guard operand: a state reference or a literal. */
export function evaluateOperand(value, state) {
  if (isStateRef(value)) return readState(state, value.$state)
  return value
}

/** Two operands, when both are finite numbers; otherwise undefined. */
function numbers(left, right) {
  if (typeof left !== 'number' || !Number.isFinite(left)) return undefined
  if (typeof right !== 'number' || !Number.isFinite(right)) return undefined
  return [left, right]
}

/**
 * Evaluate one guard against the current state.
 * @param {true | false | { op: string, args: unknown[] }} guard - the guard.
 * @param {object} state - the current graph state.
 * @returns {boolean} whether the edge is taken.
 */
export function evaluateGuard(guard, state) {
  if (guard === true) return true
  if (guard === false || guard === undefined || guard === null) return false
  if (!isPlainObject(guard)) return false
  const args = Array.isArray(guard.args) ? guard.args : []
  switch (guard.op) {
    case 'and':
      return args.every(item => evaluateGuard(item, state))
    case 'or':
      return args.some(item => evaluateGuard(item, state))
    case 'not':
      return !evaluateGuard(args[0], state)
    case 'exists':
      return evaluateOperand(args[0], state) !== undefined
    case 'eq':
      return deepEqual(evaluateOperand(args[0], state), evaluateOperand(args[1], state))
    case 'ne':
      return !deepEqual(evaluateOperand(args[0], state), evaluateOperand(args[1], state))
    case 'in': {
      const needle = evaluateOperand(args[0], state)
      const haystack = evaluateOperand(args[1], state)
      return Array.isArray(haystack) && haystack.some(item => deepEqual(item, needle))
    }
    case 'gt': {
      const pair = numbers(evaluateOperand(args[0], state), evaluateOperand(args[1], state))
      return pair !== undefined && pair[0] > pair[1]
    }
    case 'gte': {
      const pair = numbers(evaluateOperand(args[0], state), evaluateOperand(args[1], state))
      return pair !== undefined && pair[0] >= pair[1]
    }
    case 'lt': {
      const pair = numbers(evaluateOperand(args[0], state), evaluateOperand(args[1], state))
      return pair !== undefined && pair[0] < pair[1]
    }
    case 'lte': {
      const pair = numbers(evaluateOperand(args[0], state), evaluateOperand(args[1], state))
      return pair !== undefined && pair[0] <= pair[1]
    }
    default:
      return false
  }
}
