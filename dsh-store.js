/**
 * A durable LangGraph `BaseStore` over the DSH `storageDomain` service.
 *
 * `InMemoryStore` disappears with the Host process, and a graph's long-term
 * memories should not. This store keeps one validated record per
 * `(namespace, key)` in the `langgraph_store` domain; every write is durable
 * before it resolves.
 *
 * Only the filter/pagination part of `BaseStore` is implemented. Vector search
 * (`search({ query })`) is deliberately rejected rather than silently returning
 * unranked results: a graph that wants embeddings should configure a store that
 * actually implements them.
 * @module dsh-langgraph/store
 */

import { BaseStore } from '@langchain/langgraph-checkpoint'
import { z } from 'zod'

const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** One serialized store item. */
const storedItem = z.object({
  namespace: z.array(z.string()),
  key: z.string(),
  value: z.record(z.string(), z.unknown()),
  createdAt: z.number(),
  updatedAt: z.number(),
})

/** Declared DSH storage domain. */
export const STORE_DOMAIN = Object.freeze({
  name: 'langgraph_store',
  version: 1,
  layout: 'per-record',
  tables: {
    items: { valueSchema: storedItem },
  },
})

/** @param {unknown} value - candidate namespace. @param {boolean} [allowEmpty] - permit `[]` for search. */
function assertNamespace(value, allowEmpty = false) {
  if (!Array.isArray(value) || value.some(part => typeof part !== 'string' || part === '' || POLLUTION_KEYS.has(part))) {
    throw new Error('store: namespace must be an array of non-empty strings')
  }
  if (!allowEmpty && value.length === 0) throw new Error('store: namespace must not be empty')
  return value
}

/** @param {string[]} namespace - namespace. @param {string} key - item key. @returns {string} record key. */
function itemKey(namespace, key) {
  return Buffer.from(JSON.stringify([namespace, key]), 'utf8').toString('base64url')
}

/**
 * @param {string} encoded - record key.
 * @returns {[string[], string]} namespace and key.
 */
function parseItemKey(encoded) {
  const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  if (!Array.isArray(parsed) || parsed.length !== 2 || !Array.isArray(parsed[0]) || typeof parsed[1] !== 'string') {
    throw new Error('not a store item key')
  }
  return [parsed[0], parsed[1]]
}

/** JSON-safe clone, or a clear error for a value the domain cannot store. */
function jsonValue(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('store: value must be a plain JSON object')
  }
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? String(item) : item)))
  } catch {
    throw new Error('store: value must be JSON-serializable')
  }
}

/** @param {object} record - stored item. @returns {object} `Item` with Date timestamps. */
function itemOf(record) {
  return {
    value: record.value,
    key: record.key,
    namespace: record.namespace,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  }
}

/** Read a dotted field path from a value. */
function fieldOf(value, path) {
  let cursor = value
  for (const part of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object' || !(part in cursor)) return undefined
    cursor = cursor[part]
  }
  return cursor
}

/** Compare one value against one filter operand, including the supported operators. */
function matchesOperand(actual, expected) {
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    for (const [operator, operand] of Object.entries(expected)) {
      if (operator === '$eq' && actual !== operand) return false
      else if (operator === '$ne' && actual === operand) return false
      else if (operator === '$gt' && !(actual > operand)) return false
      else if (operator === '$gte' && !(actual >= operand)) return false
      else if (operator === '$lt' && !(actual < operand)) return false
      else if (operator === '$lte' && !(actual <= operand)) return false
      else if (!operator.startsWith('$')) return false
    }
    return true
  }
  return actual === expected
}

/** Whether one item satisfies every filter field. */
function matchesFilter(value, filter) {
  if (filter === undefined) return true
  return Object.entries(filter).every(([path, expected]) => matchesOperand(fieldOf(value, path), expected))
}

/** Whether a namespace starts with a prefix. */
function startsWith(namespace, prefix) {
  return prefix.length <= namespace.length && prefix.every((part, index) => part === namespace[index])
}

/** Match one wildcard path against a namespace prefix or suffix. */
function matchesPath(namespace, path, kind) {
  if (path.length > namespace.length) return false
  const offset = kind === 'suffix' ? namespace.length - path.length : 0
  return path.every((part, index) => part === '*' || part === namespace[offset + index])
}

/** A durable `BaseStore` backed by one DSH storage domain. */
export class DshStore extends BaseStore {
  /** @param {object} domain - an open storage domain shaped by {@link STORE_DOMAIN}. */
  constructor(domain) {
    super()
    this.domain = domain
  }

  /** @returns {any} the items table. */
  table() {
    return this.domain.table('items')
  }

  /**
   * Read one item.
   * @param {{ namespace: string[], key: string }} operation - get operation.
   * @returns {Promise<object | null>} the item or null.
   */
  async getOperation(operation) {
    assertNamespace(operation.namespace, true)
    if (typeof operation.key !== 'string' || operation.key === '') throw new Error('store: key must be a non-empty string')
    const record = this.table().get(itemKey(operation.namespace, operation.key))
    return record === undefined ? null : itemOf(record)
  }

  /**
   * Put or delete one item.
   * @param {{ namespace: string[], key: string, value: object | null }} operation - put operation.
   * @returns {Promise<undefined>} nothing.
   */
  async putOperation(operation) {
    assertNamespace(operation.namespace)
    if (typeof operation.key !== 'string' || operation.key === '') throw new Error('store: key must be a non-empty string')
    const key = itemKey(operation.namespace, operation.key)
    if (operation.value === null) {
      await this.table().delete(key)
      return undefined
    }
    const now = Date.now()
    const existing = this.table().get(key)
    await this.table().put(key, {
      namespace: operation.namespace,
      key: operation.key,
      value: jsonValue(operation.value),
      createdAt: existing === undefined ? now : existing.createdAt,
      updatedAt: now,
    })
    return undefined
  }

  /**
   * Search items under a namespace prefix.
   * @param {{ namespacePrefix: string[], filter?: object, limit?: number, offset?: number, query?: string }} operation - search operation.
   * @returns {Promise<object[]>} matching items.
   */
  async searchOperation(operation) {
    if (operation.query !== undefined) {
      throw new Error('store: vector search is not implemented; omit `query` or use embeddings-backed store')
    }
    assertNamespace(operation.namespacePrefix, true)
    const matched = []
    for (const [key, record] of this.table().entries()) {
      let namespace
      try {
        [namespace] = parseItemKey(key)
      } catch {
        continue
      }
      if (!startsWith(namespace, operation.namespacePrefix)) continue
      if (!matchesFilter(record.value, operation.filter)) continue
      matched.push(itemOf(record))
    }
    matched.sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime() || left.key.localeCompare(right.key))
    const offset = Number.isInteger(operation.offset) && operation.offset > 0 ? operation.offset : 0
    const limit = Number.isInteger(operation.limit) && operation.limit >= 0 ? operation.limit : 10
    return matched.slice(offset, offset + limit)
  }

  /**
   * List namespaces, with prefix/suffix wildcard conditions.
   * @param {{ matchConditions?: { matchType: 'prefix' | 'suffix', path: string[] }[], maxDepth?: number, limit?: number, offset?: number }} operation - list operation.
   * @returns {Promise<string[][]>} namespaces.
   */
  async listNamespacesOperation(operation) {
    const namespaces = new Map()
    for (const key of this.table().keys()) {
      let namespace
      try {
        [namespace] = parseItemKey(key)
      } catch {
        continue
      }
      if (operation.maxDepth !== undefined) namespace = namespace.slice(0, operation.maxDepth)
      const conditions = operation.matchConditions ?? []
      if (!conditions.every(condition => matchesPath(namespace, condition.path, condition.matchType))) continue
      namespaces.set(JSON.stringify(namespace), namespace)
    }
    const rows = [...namespaces.values()].sort((left, right) => left.join('/').localeCompare(right.join('/')))
    const offset = Number.isInteger(operation.offset) && operation.offset > 0 ? operation.offset : 0
    const limit = Number.isInteger(operation.limit) && operation.limit >= 0 ? operation.limit : 100
    return rows.slice(offset, offset + limit)
  }

  /**
   * Execute a batch of LangGraph store operations.
   * @param {object[]} operations - get/put/search/listNamespaces operations.
   * @returns {Promise<unknown[]>} one result per operation.
   */
  async batch(operations) {
    const results = []
    for (const operation of operations) {
      if (operation.namespacePrefix !== undefined) results.push(await this.searchOperation(operation))
      else if ('value' in operation) results.push(await this.putOperation(operation))
      else if (operation.namespace === undefined) results.push(await this.listNamespacesOperation(operation))
      else results.push(await this.getOperation(operation))
    }
    return results
  }
}

/**
 * Open the durable store domain.
 * @param {object} storageDomain - the `storageDomain` service.
 * @returns {Promise<{ store: DshStore, close: () => Promise<void> }>} the open store.
 */
export async function openDshStore(storageDomain) {
  const domain = await storageDomain.open(STORE_DOMAIN)
  return { store: new DshStore(domain), close: () => domain.close() }
}
