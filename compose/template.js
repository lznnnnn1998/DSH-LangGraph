/**
 * Value handling for the GraphSpec IR: state references, prompt parts and the
 * small transforms that turn a node result into a typed state value.
 *
 * Everything here is deterministic. A state reference is exactly
 * `{ "$state": "field" }` or `{ "$state": "field.path" }`; dotted paths read into
 * a `json` field. Literal objects may not use the `$state` key.
 */

/** Whether a value is a plain JSON object (not null, not an array). */
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Whether a value is an object carrying the reserved `$state` key. */
export function hasStateKey(value) {
  return isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, '$state')
}

/** Whether a value is a well-formed state reference. */
export function isStateRef(value) {
  return hasStateKey(value)
    && Object.keys(value).length === 1
    && typeof value.$state === 'string'
    && value.$state !== ''
}

/**
 * Read a dotted state path. A missing path, a non-object hop, or a bad array
 * index yields `undefined` instead of throwing; guards treat that as false.
 * @param {object | undefined} state - the current graph state.
 * @param {string} path - a field name or a dotted path into a json field.
 * @returns {unknown} the value, or undefined.
 */
export function readState(state, path) {
  if (typeof path !== 'string' || path === '') return undefined
  let current = state
  for (const part of path.split('.')) {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(part)) return undefined
      current = current[Number(part)]
    } else if (typeof current === 'object') {
      if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined
      current = current[part]
    } else {
      return undefined
    }
  }
  return current
}

/**
 * Resolve state references inside one tool argument or set value. Arrays and
 * plain objects are walked recursively; everything else is returned as is.
 * @param {unknown} value - a literal or a state reference.
 * @param {object} state - the current graph state.
 * @returns {unknown} the resolved value.
 */
export function resolveValue(value, state) {
  if (isStateRef(value)) return readState(state, value.$state)
  if (Array.isArray(value)) return value.map(item => resolveValue(item, state))
  if (isPlainObject(value)) {
    const resolved = {}
    for (const [key, item] of Object.entries(value)) resolved[key] = resolveValue(item, state)
    return resolved
  }
  return value
}

/** Render one state value inside a prompt. Arrays join with newlines. */
function stringifyPart(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map(item => (typeof item === 'string' ? item : JSON.stringify(item)))
      .join('\n')
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * Render a prompt from its parts. Parts are concatenated exactly as written, so
 * `["Find files: ", { "$state": "pattern" }]` keeps its spacing.
 * @param {Array<string | { $state: string }>} parts - the prompt parts.
 * @param {object} state - the current graph state.
 * @returns {string} the rendered prompt.
 */
export function renderParts(parts, state) {
  return parts
    .map(part => (typeof part === 'string' ? part : stringifyPart(readState(state, part.$state))))
    .join('')
}

/** Split text into lines, normalizing CRLF and dropping trailing empty lines. */
export function splitLines(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Parse JSON text. A fenced code block is accepted; prose around it is not,
 * because the model is told to answer with JSON only.
 * @param {string} text - candidate JSON.
 * @returns {unknown} the parsed value.
 */
export function parseJsonText(text) {
  let source = String(text).trim()
  if (source.startsWith('```')) {
    const firstNewline = source.indexOf('\n')
    const lastFence = source.lastIndexOf('```')
    if (firstNewline !== -1 && lastFence > firstNewline) {
      source = source.slice(firstNewline + 1, lastFence).trim()
    }
  }
  try {
    return JSON.parse(source)
  } catch (error) {
    throw new Error(`expected JSON: ${error?.message ?? error}`)
  }
}

/**
 * Apply one IR transform to a node result.
 * @param {unknown} value - the node's base value (text, resume value, array, …).
 * @param {string} kind - the transform name from the IR.
 * @returns {unknown} the transformed value.
 */
export function transform(value, kind) {
  switch (kind) {
    case 'text':
      if (value === undefined || value === null) return ''
      return typeof value === 'string' ? value.trim() : String(value)
    case 'lines':
      if (Array.isArray(value)) return value.map(item => (typeof item === 'string' ? item : String(item)))
      return splitLines(value)
    case 'json':
      if (typeof value === 'string') return parseJsonText(value)
      if (isJsonValue(value)) return value
      throw new Error('cannot read JSON from a non-JSON value')
    case 'bool': {
      if (typeof value === 'boolean') return value
      if (typeof value === 'string') {
        const text = value.trim().toLowerCase()
        if (text === 'true') return true
        if (text === 'false') return false
      }
      throw new Error('expected a boolean or the text "true"/"false"')
    }
    case 'number': {
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string' && value.trim() !== '') {
        const number = Number(value.trim())
        if (Number.isFinite(number)) return number
      }
      throw new Error('expected a finite number')
    }
    case 'first': {
      const lines = Array.isArray(value)
        ? value
        : typeof value === 'string' ? splitLines(value) : undefined
      if (lines === undefined) throw new Error('expected text or an array')
      if (lines.length === 0) throw new Error('cannot take the first item of an empty value')
      return typeof lines[0] === 'string' ? lines[0] : String(lines[0])
    }
    case 'count':
      if (Array.isArray(value)) return value.length
      if (typeof value === 'string') return splitLines(value).length
      throw new Error('expected text or an array')
    default:
      throw new Error(`unknown transform "${kind}"`)
  }
}

/** Text of the last message a prebuilt agent returned. */
export function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part
        if (typeof part?.text === 'string') return part.text
        return ''
      })
      .join('')
  }
  if (content === undefined || content === null) return ''
  return String(content)
}

/** JSON kind of a value, or undefined when it is not JSON. */
export function jsonKind(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const type = typeof value
  if (type === 'string' || type === 'boolean') return type
  if (type === 'number') return Number.isFinite(value) ? 'number' : undefined
  if (type === 'object') return 'object'
  return undefined
}

/** Whether a value is a JSON value (finite numbers only, no cycles). */
export function isJsonValue(value, stack = new Set()) {
  const kind = jsonKind(value)
  if (kind === undefined) return false
  if (kind !== 'array' && kind !== 'object') return true
  if (stack.has(value)) return false
  stack.add(value)
  const values = kind === 'array' ? value : Object.values(value)
  const ok = values.every(item => isJsonValue(item, stack))
  stack.delete(value)
  return ok
}

/** Whether a literal matches one declared state type. */
export function matchesStateType(value, type) {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'json':
      return isJsonValue(value)
    case 'string[]':
      return Array.isArray(value) && value.every(item => typeof item === 'string')
    case 'number[]':
      return Array.isArray(value) && value.every(item => typeof item === 'number' && Number.isFinite(item))
    default:
      return false
  }
}

/** Deep equality over JSON values. */
export function deepEqual(left, right) {
  if (left === right) return true
  if (typeof left !== typeof right) return false
  if (left === null || right === null || typeof left !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  if (Array.isArray(left)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]))
  }
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]))
}

/** JSON with object keys sorted, so equal specs produce equal text. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}
