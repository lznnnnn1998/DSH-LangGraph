/**
 * Immutable, session-owned graph specs in the `langgraph_specs` domain.
 *
 * A composed graph is identified by a content hash of its normalized IR, so the
 * same spec is idempotent and any edit produces a new id. Specs are never
 * mutated: a changed graph is a new spec and a new thread, which keeps recovery
 * auditable. Without a `storageDomain` a process-local store keeps the same API;
 * those specs end with the Host process.
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { assertSpec } from './schema.js'
import { stableStringify } from './template.js'

/** Prefix of a composed graph id. */
export const SPEC_PREFIX = 'lg_adhoc_'

/** Compiler version recorded with each spec, for future migrations. */
export const COMPILER_VERSION = 1

/** Per-session cap. A spec past the cap is rejected, never evicted. */
export const MAX_SPECS_PER_SESSION = 64

/** One stored spec record. */
const storedSpec = z.object({
  spec: z.record(z.string(), z.unknown()),
  source: z.unknown().nullable(),
  sessionId: z.string().nullable(),
  createdAt: z.number(),
  compilerVersion: z.number(),
})

/** Declared DSH storage domain. */
export const SPEC_DOMAIN = Object.freeze({
  name: 'langgraph_specs',
  version: 1,
  layout: 'per-record',
  tables: {
    specs: { valueSchema: storedSpec },
  },
})

/** Whether a graph id has the composed-spec prefix. */
export function isSpecId(id) {
  return typeof id === 'string' && id.startsWith(SPEC_PREFIX)
}

/** A spec without editor metadata: `$schema` is not part of the graph. */
function semanticSpec(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) return spec
  if (!Object.prototype.hasOwnProperty.call(spec, '$schema')) return spec
  const copy = { ...spec }
  delete copy.$schema
  return copy
}

/**
 * Content id of a spec: `lg_adhoc_` plus 24 hex of the sha256 of its normalized
 * JSON. Object keys are sorted; array order is preserved; `ir` is included and
 * `$schema` is not, so adding an editor hint does not change the graph's id.
 * @param {object} spec - a GraphSpec.
 * @returns {string} the spec id.
 */
export function specId(spec) {
  const digest = createHash('sha256').update(stableStringify(semanticSpec(spec))).digest('hex')
  return `${SPEC_PREFIX}${digest.slice(0, 24)}`
}

/** Deep-copy a JSON value, so a caller cannot mutate a stored spec. */
function clone(value) {
  return structuredClone(value)
}

/** A store over a table-shaped object (a DSH domain or an in-memory Map). */
export class SpecStore {
  /** @param {{ get: Function, put: Function, delete: Function, entries: Function, keys: Function }} table - the specs table. */
  constructor(table) {
    this.specs = table
  }

  /** The table for tests and diagnostics. */
  table() {
    return this.specs
  }

  /** All records owned by one session, newest first. */
  records(sessionId) {
    const owner = sessionId ?? null
    const rows = []
    for (const [id, record] of this.specs.entries()) {
      if (record?.sessionId !== owner) continue
      rows.push({ id, record })
    }
    rows.sort((left, right) => right.record.createdAt - left.record.createdAt || left.id.localeCompare(right.id))
    return rows
  }

  /**
   * Save one spec. The same content is idempotent for its owner; an id owned by
   * another session is a conflict, because the table key is the content id.
   * @param {object} spec - a validated GraphSpec.
   * @param {{ sessionId?: string, source?: unknown }} [options] - owner and audit source.
   * @returns {Promise<{ id: string, created: boolean }>} the content id.
   */
  async save(spec, options = {}) {
    assertSpec(spec)
    const id = specId(spec)
    const sessionId = options.sessionId ?? null
    const existing = this.specs.get(id)
    if (existing !== undefined) {
      if ((existing.sessionId ?? null) !== sessionId) {
        throw new Error(`spec "${id}" belongs to another session`)
      }
      return { id, created: false }
    }
    if (this.records(sessionId).length >= MAX_SPECS_PER_SESSION) {
      throw new Error(`this session already has ${MAX_SPECS_PER_SESSION} composed graphs; delete one before composing another`)
    }
    await this.specs.put(id, {
      spec: clone(spec),
      source: options.source === undefined ? null : clone(options.source),
      sessionId,
      createdAt: Date.now(),
      compilerVersion: COMPILER_VERSION,
    })
    return { id, created: true }
  }

  /**
   * Read one record with an owner check. A record with a null owner is readable
   * by any session; `allSessions` is for the owner-only Web panel, not for a
   * model tool.
   * @param {string} id - spec id.
   * @param {string | undefined} sessionId - calling session.
   * @param {{ allSessions?: boolean }} [options] - skip the session check.
   * @returns {object | undefined} a cloned record.
   */
  getRecord(id, sessionId, options = {}) {
    const record = this.specs.get(id)
    if (record === undefined) return undefined
    const owner = record.sessionId ?? null
    if (options.allSessions !== true && owner !== null && owner !== (sessionId ?? null)) {
      return undefined
    }
    return clone(record)
  }

  /**
   * Read one spec with an owner check.
   * @param {string} id - spec id.
   * @param {string | undefined} sessionId - calling session.
   * @param {{ allSessions?: boolean }} [options] - skip the session check.
   * @returns {object | undefined} a cloned spec.
   */
  getSpec(id, sessionId, options = {}) {
    return this.getRecord(id, sessionId, options)?.spec
  }

  /**
   * List one session's specs, newest first.
   * @param {string | undefined} sessionId - calling session.
   * @param {{ limit?: number }} [options] - maximum rows.
   * @returns {object[]} summaries.
   */
  listSpecs(sessionId, options = {}) {
    const limit = Number.isInteger(options.limit) && options.limit > 0
      ? Math.min(options.limit, MAX_SPECS_PER_SESSION)
      : 20
    return this.records(sessionId).slice(0, limit).map(({ id, record }) => ({
      id,
      ...(typeof record.spec?.name === 'string' ? { name: record.spec.name } : {}),
      ...(typeof record.spec?.description === 'string' ? { description: record.spec.description } : {}),
      createdAt: record.createdAt,
    }))
  }

  /**
   * Delete one spec after an owner check. Threads are checked by the compose
   * tool, which can see the checkpoint saver.
   * @param {string} id - spec id.
   * @param {string | undefined} sessionId - calling session.
   * @returns {Promise<{ deleted: boolean, reason?: string }>} what happened.
   */
  async deleteSpec(id, sessionId) {
    const record = this.specs.get(id)
    if (record === undefined) return { deleted: false, reason: 'missing' }
    if ((record.sessionId ?? null) !== (sessionId ?? null)) return { deleted: false, reason: 'owner' }
    await this.specs.delete(id)
    return { deleted: true }
  }

  /** Number of specs owned by one session. */
  count(sessionId) {
    return this.records(sessionId).length
  }
}

/** An in-memory table with the same shape as a DSH domain table. */
function memoryTable() {
  const records = new Map()
  return {
    get: key => records.get(key),
    entries: () => records.entries(),
    keys: () => records.keys(),
    async put(key, value) {
      records.set(key, structuredClone(value))
    },
    async delete(key) {
      return records.delete(key)
    },
  }
}

/** A process-local store for profiles without a storage domain. */
export function createMemorySpecStore() {
  return new SpecStore(memoryTable())
}

/**
 * Open the durable spec domain.
 * @param {object} storageDomain - the `storageDomain` service.
 * @returns {Promise<{ store: SpecStore, close: () => Promise<void> }>} the open store.
 */
export async function openSpecStore(storageDomain) {
  const domain = await storageDomain.open(SPEC_DOMAIN)
  return { store: new SpecStore(domain.table('specs')), close: () => domain.close() }
}
