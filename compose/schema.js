/**
 * Strict validation for the GraphSpec IR.
 *
 * The validator is deliberately hand-written instead of a permissive schema
 * library: every error carries the exact IR path (`nodes[2].do`, `edges[3].to`)
 * and the expected shape, so a model can repair a spec from the reply alone.
 *
 * `validateSpec` checks structure, references, types, budgets, edge rules, the
 * static fan-out writer/reducer contract, and returns advisory lint warnings.
 * It never throws and never mutates the input.
 */

import {
  END,
  GUARD_OPS,
  IR_VERSION,
  LIMITS,
  MAP_BODY_FIELDS,
  MAP_BODY_KINDS,
  NODE_FIELDS,
  NODE_KINDS,
  REDUCERS,
  START,
  STATE_TYPES,
  TRANSFORMS,
  TRANSFORM_TYPES,
} from './constants.js'
import { analyze, fanOutProblems, lintWarnings } from './analysis.js'
import {
  deepEqual,
  hasStateKey,
  isJsonValue,
  isPlainObject,
  isStateRef,
  jsonKind,
  matchesStateType,
  stableStringify,
} from './template.js'

/** Thrown by `assertSpec` and by `buildSpecGraph` when a spec is invalid. */
export class SpecError extends Error {
  /**
   * @param {Array<{ path: string, message: string, expected?: string }>} errors - validation errors.
   */
  constructor(errors) {
    const detail = errors
      .slice(0, 3)
      .map(error => `${error.path === '' ? '(root)' : error.path}: ${error.message}`)
      .join('; ')
    super(`invalid graph spec: ${detail}${errors.length > 3 ? ` (+${errors.length - 3} more)` : ''}`)
    this.name = 'SpecError'
    this.errors = errors
  }
}

/** Whether a reducer can be used with a state type. */
function reducerFits(reducer, type) {
  switch (reducer) {
    case 'replace':
      return true
    case 'append':
      return type === 'string[]' || type === 'number[]'
    case 'add':
    case 'max':
    case 'min':
      return type === 'number'
    case 'merge':
      return type === 'json'
    default:
      return false
  }
}

/** A tools option as a Set, when the caller supplied one. */
function normalizeTools(tools) {
  if (tools instanceof Set) return tools
  if (Array.isArray(tools)) return new Set(tools)
  return undefined
}

/** Short single-line preview of a value for an error message. */
function preview(value) {
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    text = String(value)
  }
  if (text === undefined) text = String(value)
  return text.length > 80 ? `${text.slice(0, 77)}...` : text
}

/** Reject fields the IR does not define, so a typo is visible. */
function checkKeys(object, allowed, path, fail) {
  for (const key of Object.keys(object)) {
    if (allowed.includes(key)) continue
    fail(path === '' ? key : `${path}.${key}`, `unknown field "${key}"`, allowed.join(' | '))
  }
}

/** Find a `$state` key nested below a literal value, for a clearer error. */
function findStateKey(value, path = '') {
  if (hasStateKey(value)) return path
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findStateKey(value[index], `${path}[${index}]`)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      const found = findStateKey(item, path === '' ? key : `${path}.${key}`)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** JSON Schema `type` check used for model output. */
function matchesSchemaType(value, type) {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'object':
      return isPlainObject(value)
    case 'array':
      return Array.isArray(value)
    case 'null':
      return value === null
    default:
      return false
  }
}

/**
 * Validate a model result against the subset of JSON Schema the IR uses.
 * @param {unknown} value - parsed model output.
 * @param {object | boolean} schema - the node's schema.
 * @param {string} [path] - where the value sits, for messages.
 * @returns {string[]} problems; empty means valid.
 */
export function validateSchemaValue(value, schema, path = '$') {
  const problems = []
  validateAgainst(value, schema, path, problems)
  return problems
}

function validateAgainst(value, schema, path, problems) {
  if (schema === true) return
  if (schema === false) {
    problems.push(`${path}: no value is allowed`)
    return
  }
  if (!isPlainObject(schema)) {
    problems.push(`${path}: schema must be an object or boolean`)
    return
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !deepEqual(value, schema.const)) {
    problems.push(`${path}: expected ${JSON.stringify(schema.const)}`)
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(item => deepEqual(value, item))) {
    problems.push(`${path}: expected one of ${JSON.stringify(schema.enum)}`)
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some(type => matchesSchemaType(value, type))) {
      problems.push(`${path}: expected ${types.join(' | ')}`)
      return
    }
  }
  if (isPlainObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !Object.prototype.hasOwnProperty.call(value, key)) {
          problems.push(`${path}.${key}: required`)
        }
      }
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {}
    for (const [key, subSchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validateAgainst(value[key], subSchema, `${path}.${key}`, problems)
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          problems.push(`${path}.${key}: unexpected property`)
        }
      }
    } else if (isPlainObject(schema.additionalProperties)) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          validateAgainst(value[key], schema.additionalProperties, `${path}.${key}`, problems)
        }
      }
    }
  }
  if (Array.isArray(value)) {
    if (isPlainObject(schema.items)) {
      value.forEach((item, index) => validateAgainst(item, schema.items, `${path}[${index}]`, problems))
    }
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      problems.push(`${path}: expected at least ${schema.minItems} items`)
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      problems.push(`${path}: expected at most ${schema.maxItems} items`)
    }
  }
  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      problems.push(`${path}: expected at least ${schema.minLength} characters`)
    }
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      problems.push(`${path}: expected at most ${schema.maxLength} characters`)
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      problems.push(`${path}: expected at least ${schema.minimum}`)
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      problems.push(`${path}: expected at most ${schema.maximum}`)
    }
  }
}

/**
 * Validate one GraphSpec.
 * @param {unknown} input - the parsed spec.
 * @param {{ tools?: string[] | Set<string> }} [options] - visible tool names to check.
 * @returns {{ ok: boolean, errors: object[], warnings: object[] }} the result.
 */
export function validateSpec(input, options = {}) {
  const errors = []
  const warnings = []
  const fail = (path, message, expected) => {
    errors.push({ path, message, ...(expected === undefined ? {} : { expected }) })
  }
  const warn = (path, message, code) => {
    warnings.push({ path, message, code })
  }
  const stateFields = new Map()
  const nodes = new Map()
  const visibleTools = normalizeTools(options.tools)

  function resolveRefType(ref, path) {
    const target = ref.$state
    const dot = target.indexOf('.')
    const base = dot === -1 ? target : target.slice(0, dot)
    const field = stateFields.get(base)
    if (field === undefined) {
      fail(path, `state reference "${target}" does not name a declared field`, [...stateFields.keys()].sort().join(' | ') || undefined)
      return undefined
    }
    if (dot !== -1 && field.type !== 'json') {
      fail(path, `dotted state reference "${target}" requires "${base}" to be a json field`)
      return undefined
    }
    return field.type
  }

  function checkStateValue(value, path) {
    if (hasStateKey(value)) {
      if (!isStateRef(value)) {
        fail(path, 'a state reference must be exactly { "$state": "<field>" }')
        return
      }
      resolveRefType(value, path)
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => checkStateValue(item, `${path}[${index}]`))
      return
    }
    if (isPlainObject(value)) {
      for (const [key, item] of Object.entries(value)) checkStateValue(item, `${path}.${key}`)
      return
    }
    if (!isJsonValue(value)) {
      fail(path, 'value must be JSON (string, number, boolean, null, array, or object)')
    }
  }

  function checkAssignment(value, targetType, path) {
    if (hasStateKey(value)) {
      if (!isStateRef(value)) {
        fail(path, 'a state reference must be exactly { "$state": "<field>" }')
        return
      }
      const refType = resolveRefType(value, path)
      if (refType !== undefined && refType !== targetType && targetType !== 'json') {
        fail(path, `cannot assign a ${refType} state value to a ${targetType} field`, targetType)
      }
      return
    }
    if (Array.isArray(value) || isPlainObject(value)) {
      const nested = findStateKey(value)
      if (nested !== undefined) {
        fail(path, `a state reference is only allowed as the whole value; found one at ${nested}`)
        return
      }
    }
    if (!matchesStateType(value, targetType)) {
      fail(path, `value ${preview(value)} does not match state type "${targetType}"`, targetType)
    }
  }

  function checkPrompt(parts, path) {
    if (!Array.isArray(parts)) {
      fail(path, '`prompt` must be an array of strings and state references', 'array')
      return
    }
    if (parts.length === 0) {
      fail(path, '`prompt` must have at least one part')
      return
    }
    let hasRef = false
    let text = ''
    parts.forEach((part, index) => {
      const partPath = `${path}[${index}]`
      if (typeof part === 'string') {
        text += part
        return
      }
      if (isStateRef(part)) {
        hasRef = true
        resolveRefType(part, partPath)
        return
      }
      fail(partPath, 'a prompt part must be a string or { "$state": "<field>" }')
    })
    if (!hasRef && text.trim() === '') {
      fail(path, '`prompt` must contain text or a state reference')
    }
  }

  function transformFitsMap(kind, fieldType) {
    const produced = TRANSFORM_TYPES[kind]
    if (produced === fieldType) return true
    if (fieldType === 'json') return kind === 'json'
    if (fieldType === 'string[]') return kind === 'text' || kind === 'first'
    if (fieldType === 'number[]') return kind === 'number' || kind === 'count'
    return false
  }

  function checkOut(node, path, options = {}) {
    if (!isPlainObject(node.out)) {
      fail(`${path}.out`, '`out` must be an object mapping state fields to transforms', 'object')
      return
    }
    const map = options.map === true
    const schemaType = isPlainObject(node.schema) && typeof node.schema.type === 'string'
      ? node.schema.type
      : undefined
    for (const [field, kind] of Object.entries(node.out)) {
      const outPath = `${path}.out.${field}`
      if (map && (field === 'item' || field === 'index')) {
        fail(outPath, `"${field}" is reserved by a map body; write a parent state field instead`)
        continue
      }
      const definition = stateFields.get(field)
      if (definition === undefined) {
        fail(outPath, `"${field}" is not a declared state field`, [...stateFields.keys()].sort().join(' | ') || undefined)
        continue
      }
      if (!TRANSFORMS.includes(kind)) {
        fail(outPath, `unknown transform ${JSON.stringify(kind)}`, TRANSFORMS.join(' | '))
        continue
      }
      if (map) {
        const reducer = definition.reducer ?? 'replace'
        if (reducer === 'replace') {
          fail(outPath, `a map body writes "${field}" concurrently; give the field a mergeable reducer`, 'append | add | max | min | merge')
          continue
        }
        if (!transformFitsMap(kind, definition.type)) {
          fail(outPath, `transform "${kind}" cannot aggregate into a ${definition.type} field`, `a transform that writes ${definition.type}`)
        }
        continue
      }
      const produced = TRANSFORM_TYPES[kind]
      const compatible = produced === definition.type
        || definition.type === 'json'
        || (kind === 'json' && schemaType === definition.type)
      if (!compatible) {
        fail(outPath, `transform "${kind}" produces ${produced}, but "${field}" is ${definition.type}`, `a transform producing ${definition.type}`)
      }
    }
  }

  function checkSchemaField(node, path) {
    if (node.schema !== undefined && !isPlainObject(node.schema)) {
      fail(`${path}.schema`, '`schema` must be a JSON Schema object', 'object')
    } else if (node.schema !== undefined && !isJsonValue(node.schema)) {
      fail(`${path}.schema`, '`schema` must be JSON-serializable')
    }
  }

  function checkToolFields(node, path, options = {}) {
    if (typeof node.tool !== 'string' || node.tool.trim() === '') {
      fail(`${path}.tool`, '`tool` must be a non-empty tool name')
    } else {
      checkVisibleTool(node.tool, `${path}.tool`)
    }
    if (!isPlainObject(node.args)) {
      fail(`${path}.args`, '`args` must be an object (use {} for no arguments)', 'object')
    } else {
      for (const [key, value] of Object.entries(node.args)) {
        checkStateValue(value, `${path}.args.${key}`)
      }
    }
    checkOut(node, path, options)
  }

  function checkModelFields(node, path, options = {}) {
    checkPrompt(node.prompt, `${path}.prompt`)
    if (node.system !== undefined && (typeof node.system !== 'string' || node.system.trim() === '')) {
      fail(`${path}.system`, '`system` must be a non-empty string')
    }
    checkSchemaField(node, path)
    checkOut(node, path, options)
  }

  function checkAgentFields(node, path, options = {}) {
    checkPrompt(node.prompt, `${path}.prompt`)
    if (!Array.isArray(node.tools)) {
      fail(`${path}.tools`, '`tools` must be an array of tool names', 'array')
    } else {
      const seen = new Set()
      node.tools.forEach((tool, toolIndex) => {
        const toolPath = `${path}.tools[${toolIndex}]`
        if (typeof tool !== 'string' || tool.trim() === '') {
          fail(toolPath, 'a tool name must be a non-empty string')
        } else if (seen.has(tool)) {
          fail(toolPath, `duplicate tool "${tool}"`)
        } else {
          seen.add(tool)
          checkVisibleTool(tool, toolPath)
        }
      })
    }
    checkOut(node, path, options)
  }

  function checkSubagentFields(node, path, options = {}) {
    checkPrompt(node.prompt, `${path}.prompt`)
    checkSchemaField(node, path)
    checkOut(node, path, options)
  }

  function checkMapBody(node, path, itemType) {
    if (!isPlainObject(node.body)) {
      fail(`${path}.body`, '`body` must be one node object', 'object')
      return
    }
    const body = node.body
    const bodyPath = `${path}.body`
    if (!MAP_BODY_KINDS.includes(body.do)) {
      fail(`${bodyPath}.do`, `a map body must be one of ${MAP_BODY_KINDS.join(' | ')}`, MAP_BODY_KINDS.join(' | '))
      return
    }
    if (body.id !== undefined && (typeof body.id !== 'string' || body.id.trim() === '' || /\s/.test(body.id))) {
      fail(`${bodyPath}.id`, '`id` must be a non-empty string without whitespace when present')
    }
    checkKeys(body, MAP_BODY_FIELDS[body.do], bodyPath, fail)
    const previousItem = stateFields.get('item')
    const previousIndex = stateFields.get('index')
    stateFields.set('item', { type: itemType, reducer: 'replace', default: undefined })
    stateFields.set('index', { type: 'number', reducer: 'replace', default: 0 })
    try {
      switch (body.do) {
        case 'tool':
          checkToolFields(body, bodyPath, { map: true })
          break
        case 'model':
          checkModelFields(body, bodyPath, { map: true })
          break
        case 'agent':
          checkAgentFields(body, bodyPath, { map: true })
          break
        case 'subagent':
          checkSubagentFields(body, bodyPath, { map: true })
          break
        default:
          break
      }
    } finally {
      if (previousItem === undefined) stateFields.delete('item')
      else stateFields.set('item', previousItem)
      if (previousIndex === undefined) stateFields.delete('index')
      else stateFields.set('index', previousIndex)
    }
  }

  function checkVisibleTool(name, path) {
    if (visibleTools === undefined) return
    if (visibleTools.has(name)) return
    fail(path, `tool "${name}" is not visible to this agent`, [...visibleTools].sort().join(' | ') || 'no tools')
  }

  function operandType(value, path) {
    if (hasStateKey(value)) {
      if (!isStateRef(value)) {
        fail(path, 'a state reference must be exactly { "$state": "<field>" }')
        return undefined
      }
      return resolveRefType(value, path)
    }
    if (isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, 'op')) {
      fail(path, 'a nested guard is only allowed inside "and", "or", or "not"')
      return undefined
    }
    if (!isJsonValue(value)) {
      fail(path, 'a guard operand must be a JSON value or a state reference')
      return undefined
    }
    return jsonKind(value)
  }

  function checkGuard(guard, path) {
    if (guard === true || guard === false) return
    if (!isPlainObject(guard)) {
      fail(path, 'a guard must be true, false, or { "op": "...", "args": [...] }')
      return
    }
    if (hasStateKey(guard)) {
      fail(path, 'a guard must be true, false, or { "op": "...", "args": [...] }, not a state reference')
      return
    }
    checkKeys(guard, ['op', 'args'], path, fail)
    if (!GUARD_OPS.includes(guard.op)) {
      fail(`${path}.op`, `unknown guard op ${JSON.stringify(guard.op)}`, GUARD_OPS.join(' | '))
      return
    }
    if (!Array.isArray(guard.args)) {
      fail(`${path}.args`, 'guard `args` must be an array', 'array')
      return
    }
    const op = guard.op
    if (op === 'and' || op === 'or') {
      if (guard.args.length === 0) fail(`${path}.args`, `"${op}" needs at least one guard`)
      guard.args.forEach((item, index) => checkGuard(item, `${path}.args[${index}]`))
      return
    }
    if (op === 'not') {
      if (guard.args.length !== 1) fail(`${path}.args`, '"not" takes exactly one guard')
      if (guard.args.length >= 1) checkGuard(guard.args[0], `${path}.args[0]`)
      return
    }
    const arity = op === 'exists' ? 1 : 2
    if (guard.args.length !== arity) {
      fail(`${path}.args`, `"${op}" takes exactly ${arity} operand${arity === 1 ? '' : 's'}`)
    }
    const types = guard.args.map((arg, index) => operandType(arg, `${path}.args[${index}]`))
    if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
      types.forEach((type, index) => {
        if (type !== undefined && type !== 'number' && type !== 'json') {
          fail(`${path}.args[${index}]`, `"${op}" compares numbers; this operand is ${type}`, 'number')
        }
      })
    }
    if (op === 'in') {
      const haystack = types[1]
      if (haystack !== undefined && !['array', 'string[]', 'number[]', 'json'].includes(haystack)) {
        fail(`${path}.args[1]`, `"in" needs an array on the right; this operand is ${haystack}`, 'array')
      }
    }
    if (op === 'eq' || op === 'ne') {
      const primitive = type => type === 'string' || type === 'number' || type === 'boolean' || type === 'null'
      if (primitive(types[0]) && primitive(types[1]) && types[0] !== types[1]) {
        fail(path, `"${op}" compares ${types[0]} with ${types[1]}; they can never be equal`, 'matching types')
      }
    }
  }

  if (!isPlainObject(input)) {
    fail('', 'the spec must be a JSON object', 'object')
    return { ok: false, errors, warnings }
  }
  checkKeys(input, ['ir', 'name', 'description', 'state', 'nodes', 'edges', 'output', 'maxSteps'], '', fail)

  if (input.ir !== IR_VERSION) {
    fail('ir', `unsupported IR version ${JSON.stringify(input.ir)}; this compiler reads ir: ${IR_VERSION}`, String(IR_VERSION))
  }
  if (input.name !== undefined && (typeof input.name !== 'string' || input.name.trim() === '')) {
    fail('name', '`name` must be a non-empty string')
  }
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.trim() === '')) {
    fail('description', '`description` must be a non-empty string')
  }

  // --- state ------------------------------------------------------------------
  if (!isPlainObject(input.state)) {
    fail('state', '`state` must be an object of field definitions', 'object')
  } else {
    const entries = Object.entries(input.state)
    if (entries.length === 0) fail('state', '`state` must declare at least one field')
    if (entries.length > LIMITS.stateFields) {
      fail('state', `too many state fields (${entries.length}); the limit is ${LIMITS.stateFields}`)
    }
    for (const [name, field] of entries) {
      const path = `state.${name}`
      if (name === '' || name.includes('.') || /\s/.test(name)) {
        fail(path, 'state field names must be non-empty and may not contain "." or whitespace')
        continue
      }
      if (name === '__interrupt__' || name === '__start__' || name === '__end__') {
        fail(path, `"${name}" is reserved by LangGraph`)
        continue
      }
      if (!isPlainObject(field)) {
        fail(path, 'a state field must be an object', '{ "type", "default", "reducer"? }')
        continue
      }
      checkKeys(field, ['type', 'default', 'reducer'], path, fail)
      const typeKnown = STATE_TYPES.includes(field.type)
      if (!typeKnown) {
        fail(`${path}.type`, `unknown state type ${JSON.stringify(field.type)}`, STATE_TYPES.join(' | '))
      }
      if (!Object.prototype.hasOwnProperty.call(field, 'default')) {
        fail(`${path}.default`, '`default` is required', field.type)
      } else if (typeKnown && !matchesStateType(field.default, field.type)) {
        fail(`${path}.default`, `default ${preview(field.default)} does not match type "${field.type}"`, field.type)
      }
      const reducer = field.reducer ?? 'replace'
      if (field.reducer !== undefined && !REDUCERS.includes(field.reducer)) {
        fail(`${path}.reducer`, `unknown reducer ${JSON.stringify(field.reducer)}`, REDUCERS.join(' | '))
      } else if (typeKnown && !reducerFits(reducer, field.type)) {
        fail(`${path}.reducer`, `reducer "${reducer}" is not compatible with type "${field.type}"`, 'replace')
      }
      // Keep a best-effort entry even after a type error, so later messages do
      // not cascade into "unknown field" for every reference.
      stateFields.set(name, {
        type: typeKnown ? field.type : 'json',
        reducer,
        default: field.default,
      })
    }
  }

  // --- nodes ------------------------------------------------------------------
  if (!Array.isArray(input.nodes)) {
    fail('nodes', '`nodes` must be an array', 'array')
  } else {
    if (input.nodes.length === 0) fail('nodes', '`nodes` must have at least one node')
    if (input.nodes.length > LIMITS.nodes) {
      fail('nodes', `too many nodes (${input.nodes.length}); the limit is ${LIMITS.nodes}`)
    }
    input.nodes.forEach((node, index) => {
      const path = `nodes[${index}]`
      if (!isPlainObject(node)) {
        fail(path, 'a node must be an object')
        return
      }
      if (typeof node.id !== 'string' || node.id.trim() === '' || /\s/.test(node.id)) {
        fail(`${path}.id`, '`id` must be a non-empty string without whitespace')
        return
      }
      if (node.id === START || node.id === END) {
        fail(`${path}.id`, `"${node.id}" is reserved`)
        return
      }
      if (node.id === '__start__' || node.id === '__end__' || node.id === '__interrupt__') {
        fail(`${path}.id`, `"${node.id}" is reserved by LangGraph`)
        return
      }
      if (nodes.has(node.id)) {
        fail(`${path}.id`, `duplicate node id "${node.id}"`)
        return
      }
      if (stateFields.has(node.id)) {
        fail(`${path}.id`, `"${node.id}" is also a state field; node ids and state field names must differ`)
      }
      if (!NODE_KINDS.includes(node.do)) {
        fail(`${path}.do`, `unknown node kind ${JSON.stringify(node.do)}`, NODE_KINDS.join(' | '))
        return
      }
      nodes.set(node.id, node)
      checkKeys(node, NODE_FIELDS[node.do], path, fail)
      switch (node.do) {
        case 'tool':
          checkToolFields(node, path)
          break
        case 'model':
          checkModelFields(node, path)
          break
        case 'agent':
          checkAgentFields(node, path)
          break
        case 'subagent':
          checkSubagentFields(node, path)
          break
        case 'map': {
          if (typeof node.over !== 'string' || node.over === '' || node.over.includes('.')) {
            fail(`${path}.over`, '`over` must be a top-level array state field name')
          } else {
            const over = stateFields.get(node.over)
            if (over === undefined) {
              fail(`${path}.over`, `"${node.over}" is not a declared state field`, [...stateFields.keys()].sort().join(' | ') || undefined)
            } else if (over.type !== 'string[]' && over.type !== 'number[]') {
              fail(`${path}.over`, `"${node.over}" is ${over.type}; a map needs a string[] or number[] field`, 'string[] | number[]')
            }
          }
          if (node.maxItems !== undefined && (!Number.isInteger(node.maxItems) || node.maxItems < 1 || node.maxItems > LIMITS.maxMapItems)) {
            fail(`${path}.maxItems`, `\`maxItems\` must be an integer between 1 and ${LIMITS.maxMapItems}`, `integer 1..${LIMITS.maxMapItems}`)
          }
          if (node.maxConcurrency !== undefined && (!Number.isInteger(node.maxConcurrency) || node.maxConcurrency < 1 || node.maxConcurrency > LIMITS.maxMapConcurrency)) {
            fail(`${path}.maxConcurrency`, `\`maxConcurrency\` must be an integer between 1 and ${LIMITS.maxMapConcurrency}`, `integer 1..${LIMITS.maxMapConcurrency}`)
          }
          const over = typeof node.over === 'string' ? stateFields.get(node.over) : undefined
          checkMapBody(node, path, over?.type === 'number[]' ? 'number' : 'string')
          break
        }
        case 'gate':
          if (typeof node.question !== 'string' || node.question.trim() === '') {
            fail(`${path}.question`, '`question` must be a non-empty string')
          }
          if (node.options !== undefined) {
            if (!Array.isArray(node.options) || node.options.length === 0) {
              fail(`${path}.options`, '`options` must be a non-empty array of strings', 'array')
            } else {
              const seen = new Set()
              node.options.forEach((option, optionIndex) => {
                const optionPath = `${path}.options[${optionIndex}]`
                if (typeof option !== 'string' || option.trim() === '') {
                  fail(optionPath, 'an option must be a non-empty string')
                } else if (seen.has(option)) {
                  fail(optionPath, `duplicate option ${JSON.stringify(option)}`)
                } else {
                  seen.add(option)
                }
              })
            }
          }
          checkOut(node, path)
          break
        case 'set':
          if (!isPlainObject(node.values)) {
            fail(`${path}.values`, '`values` must be an object mapping state fields to values', 'object')
          } else {
            if (Object.keys(node.values).length === 0) {
              warn(`${path}.values`, 'this set node writes nothing', 'no-op')
            }
            for (const [field, value] of Object.entries(node.values)) {
              const valuePath = `${path}.values.${field}`
              const definition = stateFields.get(field)
              if (definition === undefined) {
                fail(valuePath, `"${field}" is not a declared state field`, [...stateFields.keys()].sort().join(' | ') || undefined)
                continue
              }
              checkAssignment(value, definition.type, valuePath)
            }
          }
          break
        default:
          // `NODE_KINDS` gates the switch; this is unreachable.
          break
      }
    })
  }

  // --- edges ------------------------------------------------------------------
  const validEdges = []
  if (!Array.isArray(input.edges)) {
    fail('edges', '`edges` must be an array', 'array')
  } else {
    if (input.edges.length === 0) {
      fail('edges', '`edges` must have at least one edge (START -> first node)')
    }
    if (input.edges.length > LIMITS.edges) {
      fail('edges', `too many edges (${input.edges.length}); the limit is ${LIMITS.edges}`)
    }
    const seenEdges = new Map()
    input.edges.forEach((edge, index) => {
      const path = `edges[${index}]`
      if (!isPlainObject(edge)) {
        fail(path, 'an edge must be an object')
        return
      }
      checkKeys(edge, ['from', 'to', 'when'], path, fail)
      let fromOk = false
      let toOk = false
      if (typeof edge.from !== 'string') {
        fail(`${path}.from`, '`from` must be a node id or "START"')
      } else if (edge.from === END) {
        fail(`${path}.from`, 'END cannot have outgoing edges')
      } else if (edge.from !== START && !nodes.has(edge.from)) {
        fail(`${path}.from`, `unknown source "${edge.from}"`, [START, ...nodes.keys()].join(' | '))
      } else {
        fromOk = true
      }
      if (typeof edge.to !== 'string') {
        fail(`${path}.to`, '`to` must be a node id or "END"')
      } else if (edge.to === START) {
        fail(`${path}.to`, 'START cannot be a target')
      } else if (edge.to !== END && !nodes.has(edge.to)) {
        fail(`${path}.to`, `unknown target "${edge.to}"`, [...nodes.keys(), END].join(' | '))
      } else {
        toOk = true
      }
      if (edge.from === START && edge.when !== undefined) {
        fail(`${path}.when`, 'START edges must be unconditional')
      }
      if (edge.when !== undefined) checkGuard(edge.when, `${path}.when`)
      let guardKey
      try {
        guardKey = edge.when === undefined ? 'always' : stableStringify(edge.when)
      } catch {
        guardKey = String(edge.when)
      }
      const key = `${edge.from}\u0000${edge.to}\u0000${guardKey}`
      if (seenEdges.has(key)) {
        fail(path, `duplicate of edges[${seenEdges.get(key)}]`)
      } else {
        seenEdges.set(key, index)
      }
      if (fromOk && toOk) validEdges.push(edge)
    })

    if (!validEdges.some(edge => edge.from === START)) {
      fail('edges', 'the graph needs at least one edge from START', 'START -> node')
    }

    for (const id of nodes.keys()) {
      const outgoing = validEdges.filter(edge => edge.from === id)
      if (outgoing.length === 0) continue
      const conditional = outgoing.filter(edge => edge.when !== undefined)
      const unconditional = outgoing.filter(edge => edge.when === undefined)
      if (conditional.length > 0 && unconditional.length > 0) {
        fail(`nodes.${id}`, 'outgoing edges mix conditional and unconditional edges; use sequence, choice, or parallel', 'one of sequence, choice, parallel')
      }
    }
  }

  // --- output / budget --------------------------------------------------------
  if (input.output !== undefined) {
    if (!Array.isArray(input.output)) {
      fail('output', '`output` must be an array of state field names', 'array')
    } else {
      const seen = new Set()
      input.output.forEach((field, index) => {
        const path = `output[${index}]`
        if (typeof field !== 'string' || field === '') {
          fail(path, 'an output field must be a non-empty string')
        } else if (!stateFields.has(field)) {
          fail(path, `"${field}" is not a declared state field`, [...stateFields.keys()].sort().join(' | ') || undefined)
        } else if (seen.has(field)) {
          fail(path, `duplicate output field "${field}"`)
        } else {
          seen.add(field)
        }
      })
      if (input.output.length === 0) warn('output', '`output` is empty; the run returns no state field', 'no-output')
    }
  }

  if (input.maxSteps !== undefined && (!Number.isInteger(input.maxSteps) || input.maxSteps < 1 || input.maxSteps > LIMITS.maxSteps)) {
    fail('maxSteps', `\`maxSteps\` must be an integer between 1 and ${LIMITS.maxSteps}`, `integer 1..${LIMITS.maxSteps}`)
  }

  let serialized
  try {
    serialized = JSON.stringify(input)
  } catch {
    fail('', 'the spec must be JSON-serializable')
  }
  if (serialized !== undefined) {
    const bytes = Buffer.byteLength(serialized, 'utf8')
    if (bytes > LIMITS.specBytes) {
      fail('', `the spec is ${bytes} bytes; the limit is ${LIMITS.specBytes}`, `<= ${LIMITS.specBytes} bytes`)
    }
  }

  if (errors.length === 0) {
    const analysis = analyze(input)
    warnings.push(...lintWarnings(input, analysis))
    errors.push(...fanOutProblems(input, analysis))
  }

  return { ok: errors.length === 0, errors, warnings }
}

/**
 * Validate a spec or throw a `SpecError` carrying every error.
 * @param {unknown} spec - the parsed spec.
 * @param {{ tools?: string[] | Set<string> }} [options] - visible tool names.
 * @returns {{ ok: true, errors: [], warnings: object[] }} the result.
 */
export function assertSpec(spec, options = {}) {
  const result = validateSpec(spec, options)
  if (!result.ok) throw new SpecError(result.errors)
  return result
}
