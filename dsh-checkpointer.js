/**
 * Durable LangGraph checkpoints over the DSH `storageDomain` service.
 *
 * LangGraph's own `MemorySaver` keeps threads in process memory, so a run is lost
 * with the Host process. This saver stores the same data — one record per checkpoint,
 * one record per checkpoint's pending writes — in a schema-validated DSH storage
 * domain, which is the sanctioned place for plugin-owned durable data. Reads are
 * synchronous from the domain's validated in-memory state; every write is durable
 * before it resolves.
 *
 * Values are serialized with the saver's own `serde` (LangChain's `JsonPlusSerializer`)
 * and kept as base64 so LangChain classes such as messages survive the round trip;
 * only the record envelopes are plain JSON.
 * @module dsh-langgraph/checkpointer
 */

import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  compareWritesSortKeys,
  copyCheckpoint,
  writesSortKey,
} from '@langchain/langgraph-checkpoint'
import { z } from 'zod'

/** Keys that mutate `Object.prototype` when assigned through bracket notation. */
const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** One serialized value: LangChain's serialization tag plus base64 payload. */
const encodedValue = z.object({ type: z.string(), data: z.string() })

/**
 * Declared storage domain. `per-record` keeps each checkpoint and write-set its own
 * document, so a superstep rewrites only what it changed.
 * @type {Readonly<{ name: string, version: number, layout: 'per-record', tables: Record<string, { valueSchema: import('zod').ZodType }> }>}
 */
export const DOMAIN = Object.freeze({
  name: 'langgraph_checkpoints',
  version: 1,
  layout: 'per-record',
  tables: {
    checkpoints: {
      valueSchema: z.object({
        checkpoint: encodedValue,
        metadata: encodedValue,
        parent: z.string().nullable(),
        createdAt: z.number(),
      }),
    },
    writes: {
      valueSchema: z.object({
        entries: z.array(z.object({
          taskPath: z.string(),
          taskId: z.string(),
          idx: z.number(),
          channel: z.string(),
          value: encodedValue,
        })),
      }),
    },
    threads: {
      valueSchema: z.object({
        graph: z.string().nullable(),
        sessionId: z.string().nullable(),
        createdAt: z.number(),
        updatedAt: z.number(),
        checkpoints: z.number(),
        writes: z.number(),
      }),
    },
  },
})

/**
 * Reject a value that is unsafe as a storage key.
 * @param {string} field - configurable field name, for the message.
 * @param {unknown} value - candidate key.
 * @param {{ allowEmpty?: boolean }} [options] - whether the empty string is permitted.
 */
function assertSafeKey(field, value, options = {}) {
  if (typeof value !== 'string') {
    throw new Error(`checkpointer: configurable "${field}" must be a string, got ${value === null ? 'null' : typeof value}`)
  }
  if (options.allowEmpty !== true && value === '') {
    throw new Error(`checkpointer: configurable "${field}" must not be the empty string`)
  }
  if (POLLUTION_KEYS.has(value)) {
    throw new Error(`checkpointer: configurable "${field}" uses the reserved value "${value}"`)
  }
}

/** @param {Uint8Array} bytes - serialized bytes. @returns {string} base64 text. */
function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

/** @param {string} text - base64 text. @returns {Uint8Array} serialized bytes. */
function fromBase64(text) {
  return new Uint8Array(Buffer.from(text, 'base64'))
}

/**
 * Record keys must be path-safe for the per-record layout (JSON documents, one file
 * per record), so a key is the base64url of its JSON parts rather than raw JSON.
 * @param {string[]} parts - the key components.
 * @returns {string} a key matching `[A-Za-z0-9_-]+`.
 */
function encodeKey(parts) {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url')
}

/**
 * Read back the parts of one record key. A key this saver did not write decodes to
 * something that is not a parts array, and callers treat that as a foreign record.
 * @param {string} key - the record key.
 * @returns {string[]} the key components.
 */
function decodeKey(key) {
  const parsed = JSON.parse(Buffer.from(key, 'base64url').toString('utf8'))
  if (!Array.isArray(parsed) || parsed.some(part => typeof part !== 'string')) {
    throw new Error('not a checkpoint key')
  }
  return parsed
}

/** @param {string} thread - thread id. @param {string} ns - checkpoint namespace. @param {string} id - checkpoint id. */
function checkpointKey(thread, ns, id) {
  return encodeKey(['c', thread, ns, id])
}

/** @param {string} key - a checkpoint record key. @returns {[string, string, string]} thread, namespace, id. */
function parseCheckpointKey(key) {
  const parsed = decodeKey(key)
  if (parsed.length !== 4 || parsed[0] !== 'c') throw new Error('not a checkpoint key')
  return [parsed[1], parsed[2], parsed[3]]
}

/** @param {string} thread - thread id. @param {string} ns - checkpoint namespace. @param {string} id - checkpoint id. */
function writesKey(thread, ns, id) {
  return encodeKey(['w', thread, ns, id])
}

/** @param {string} key - a writes record key. @returns {[string, string, string]} thread, namespace, id. */
function parseWritesKey(key) {
  const parsed = decodeKey(key)
  if (parsed.length !== 4 || parsed[0] !== 'w') throw new Error('not a writes key')
  return [parsed[1], parsed[2], parsed[3]]
}

/** @param {string} thread - thread id. @returns {string} its record key. */
function threadKey(thread) {
  return encodeKey(['t', thread])
}

/** @param {string} key - a thread record key. @returns {string} the thread id. */
function parseThreadKey(key) {
  const parsed = decodeKey(key)
  if (parsed.length !== 2 || parsed[0] !== 't') throw new Error('not a thread key')
  return parsed[1]
}

/**
 * A `BaseCheckpointSaver` whose threads live in a DSH storage domain.
 *
 * It also keeps the small amount of thread bookkeeping a run tool needs — which graph
 * and session a thread belongs to, and how much it holds — so listing threads does not
 * have to read every checkpoint.
 */
export class DshCheckpointSaver extends BaseCheckpointSaver {
  /**
   * @param {object} domain - an open storage domain shaped by {@link DOMAIN}.
   */
  constructor(domain) {
    super()
    /** @type {object} */
    this.domain = domain
  }

  /** @param {'checkpoints' | 'writes' | 'threads'} table - table name. @returns {any} the table handle. */
  table(table) {
    return this.domain.table(table)
  }

  /**
   * Serialize one value for storage.
   * @param {unknown} value - value to store.
   * @returns {Promise<{ type: string, data: string }>} the encoded value.
   */
  async encode(value) {
    const [type, bytes] = await this.serde.dumpsTyped(value)
    return { type, data: toBase64(bytes) }
  }

  /**
   * Deserialize one stored value.
   * @param {{ type: string, data: string }} encoded - the encoded value.
   * @returns {Promise<unknown>} the value.
   */
  async decode(encoded) {
    return await this.serde.loadsTyped(encoded.type, fromBase64(encoded.data))
  }

  /**
   * Read the pending writes of one checkpoint, in the order live execution applies them.
   * @param {string} thread - thread id.
   * @param {string} ns - checkpoint namespace.
   * @param {string} id - checkpoint id.
   * @returns {Promise<Array<[string, string, unknown]>>} `[taskId, channel, value]`, sorted.
   */
  async pendingWrites(thread, ns, id) {
    const record = this.table('writes').get(writesKey(thread, ns, id))
    if (record === undefined) return []
    const ordered = [...record.entries].sort((left, right) => compareWritesSortKeys(
      writesSortKey(left.taskPath, left.taskId, left.idx),
      writesSortKey(right.taskPath, right.taskId, right.idx),
    ))
    return await Promise.all(ordered.map(async entry => [entry.taskId, entry.channel, await this.decode(entry.value)]))
  }

  /**
   * Build one checkpoint tuple from its stored record.
   * @param {string} thread - thread id.
   * @param {string} ns - checkpoint namespace.
   * @param {string} id - checkpoint id.
   * @param {{ checkpoint: object, metadata: object, parent: string | null }} record - stored record.
   * @returns {Promise<object>} the `CheckpointTuple`.
   */
  async tuple(thread, ns, id, record) {
    const checkpoint = await this.decode(record.checkpoint)
    const tuple = {
      config: { configurable: { thread_id: thread, checkpoint_ns: ns, checkpoint_id: id } },
      checkpoint,
      metadata: await this.decode(record.metadata),
      pendingWrites: await this.pendingWrites(thread, ns, id),
    }
    if (record.parent !== null) {
      tuple.parentConfig = { configurable: { thread_id: thread, checkpoint_ns: ns, checkpoint_id: record.parent } }
    }
    return tuple
  }

  /**
   * The newest checkpoint of one thread and namespace.
   * @param {string} thread - thread id.
   * @param {string} ns - checkpoint namespace.
   * @returns {{ id: string, record: object } | undefined} the newest checkpoint.
   */
  latest(thread, ns) {
    let best
    for (const [key, record] of this.table('checkpoints').entries()) {
      let parsed
      try {
        parsed = parseCheckpointKey(key)
      } catch {
        continue
      }
      if (parsed[0] !== thread || parsed[1] !== ns) continue
      if (best === undefined || parsed[2] > best.id) best = { id: parsed[2], record }
    }
    return best
  }

  /** @param {import('@langchain/core/runnables').RunnableConfig} config - a runnable config. */
  async getTuple(config) {
    const thread = config.configurable?.thread_id
    const ns = config.configurable?.checkpoint_ns ?? ''
    assertSafeKey('checkpoint_ns', ns, { allowEmpty: true })
    if (thread === undefined) return undefined
    assertSafeKey('thread_id', thread)
    const requested = config.configurable?.checkpoint_id
    if (typeof requested === 'string' && requested !== '') {
      assertSafeKey('checkpoint_id', requested)
      const record = this.table('checkpoints').get(checkpointKey(thread, ns, requested))
      return record === undefined ? undefined : await this.tuple(thread, ns, requested, record)
    }
    const newest = this.latest(thread, ns)
    return newest === undefined ? undefined : await this.tuple(thread, ns, newest.id, newest.record)
  }

  /**
   * Yield stored checkpoints newest first, honoring the standard list options.
   * @param {import('@langchain/core/runnables').RunnableConfig} config - a runnable config.
   * @param {{ limit?: number, before?: object, filter?: Record<string, unknown> }} [options] - paging and filter.
   */
  async *list(config, options = {}) {
    const wantedThread = config.configurable?.thread_id
    const wantedNs = config.configurable?.checkpoint_ns
    const wantedId = config.configurable?.checkpoint_id
    const before = options.before?.configurable?.checkpoint_id
    let limit = options.limit
    const rows = []
    for (const [key, record] of this.table('checkpoints').entries()) {
      let thread, ns, id
      try {
        [thread, ns, id] = parseCheckpointKey(key)
      } catch {
        continue
      }
      if (wantedThread !== undefined && thread !== wantedThread) continue
      if (wantedNs !== undefined && ns !== wantedNs) continue
      if (wantedId !== undefined && id !== wantedId) continue
      if (before !== undefined && id >= before) continue
      rows.push([thread, ns, id, record])
    }
    rows.sort((left, right) => (left[2] < right[2] ? 1 : left[2] > right[2] ? -1 : 0))
    for (const [thread, ns, id, record] of rows) {
      if (limit !== undefined && limit <= 0) break
      const tuple = await this.tuple(thread, ns, id, record)
      if (options.filter !== undefined && !Object.entries(options.filter).every(([key, value]) => tuple.metadata?.[key] === value)) continue
      if (limit !== undefined) limit -= 1
      yield tuple
    }
  }

  /** @param {object} config - a runnable config. @param {object} checkpoint - the checkpoint. @param {object} metadata - checkpoint metadata. */
  async put(config, checkpoint, metadata) {
    const thread = config.configurable?.thread_id
    const ns = config.configurable?.checkpoint_ns ?? ''
    if (thread === undefined) {
      throw new Error('checkpointer: put needs a "thread_id" in config.configurable')
    }
    assertSafeKey('thread_id', thread)
    assertSafeKey('checkpoint_ns', ns, { allowEmpty: true })
    assertSafeKey('checkpoint_id', checkpoint.id)
    const prepared = copyCheckpoint(checkpoint)
    const [encodedCheckpoint, encodedMetadata] = await Promise.all([this.encode(prepared), this.encode(metadata ?? {})])
    const parent = config.configurable?.checkpoint_id
    await this.table('checkpoints').put(checkpointKey(thread, ns, checkpoint.id), {
      checkpoint: encodedCheckpoint,
      metadata: encodedMetadata,
      parent: typeof parent === 'string' && parent !== '' ? parent : null,
      createdAt: Date.now(),
    })
    await this.touchThread(thread, 'checkpoints')
    return { configurable: { thread_id: thread, checkpoint_ns: ns, checkpoint_id: checkpoint.id } }
  }

  /** @param {object} config - a runnable config. @param {Array<[string, unknown]>} writes - channel writes. @param {string} taskId - the writing task. @param {string} [taskPath] - the task path. */
  async putWrites(config, writes, taskId, taskPath) {
    const thread = config.configurable?.thread_id
    const ns = config.configurable?.checkpoint_ns ?? ''
    const id = config.configurable?.checkpoint_id
    if (thread === undefined) {
      throw new Error('checkpointer: putWrites needs a "thread_id" in config.configurable')
    }
    if (id === undefined) {
      throw new Error('checkpointer: putWrites needs a "checkpoint_id" in config.configurable')
    }
    assertSafeKey('thread_id', thread)
    assertSafeKey('checkpoint_ns', ns, { allowEmpty: true })
    assertSafeKey('checkpoint_id', id)
    assertSafeKey('task_id', taskId)
    const key = writesKey(thread, ns, id)
    const path = taskPath ?? ''
    const incoming = await Promise.all(writes.map(async ([channel, value], index) => ({
      taskPath: path,
      taskId,
      idx: WRITES_IDX_MAP[channel] ?? index,
      channel,
      value: await this.encode(value),
    })))
    const table = this.table('writes')
    const existing = table.get(key)
    if (existing === undefined) {
      await table.put(key, { entries: incoming })
    } else {
      await table.update(key, current => {
        const merged = new Map(current.entries.map(entry => [`${entry.taskId},${entry.idx}`, entry]))
        for (const entry of incoming) {
          // A reserved index (error, scheduled, interrupt, resume) may be rewritten;
          // a regular index belongs to the first write that claimed it.
          if (entry.idx >= 0 && merged.has(`${entry.taskId},${entry.idx}`)) continue
          merged.set(`${entry.taskId},${entry.idx}`, entry)
        }
        return { entries: [...merged.values()] }
      })
    }
    await this.touchThread(thread, 'writes')
  }

  /** @param {string} thread - thread id to erase. */
  async deleteThread(thread) {
    assertSafeKey('thread_id', thread)
    await this.forgetThreadRecords(thread)
  }

  /**
   * Remove every checkpoint, write set, and thread record of one thread.
   * @param {string} thread - thread id.
   */
  async forgetThreadRecords(thread) {
    const checkpointKeys = []
    for (const key of this.table('checkpoints').keys()) {
      try {
        if (parseCheckpointKey(key)[0] === thread) checkpointKeys.push(key)
      } catch { /* not one of ours */ }
    }
    const writeKeys = []
    for (const key of this.table('writes').keys()) {
      try {
        if (parseWritesKey(key)[0] === thread) writeKeys.push(key)
      } catch { /* not one of ours */ }
    }
    if (checkpointKeys.length > 0) await this.table('checkpoints').deleteMany(checkpointKeys)
    if (writeKeys.length > 0) await this.table('writes').deleteMany(writeKeys)
    await this.table('threads').delete(threadKey(thread))
  }

  /**
   * Record which graph and session own a thread, creating the record when absent.
   * @param {string} thread - thread id.
   * @param {{ graph: string, sessionId?: string }} meta - owner facts.
   */
  async claimThread(thread, meta) {
    assertSafeKey('thread_id', thread)
    const table = this.table('threads')
    const now = Date.now()
    const key = threadKey(thread)
    const existing = table.get(key)
    if (existing === undefined) {
      await table.put(key, {
        graph: meta.graph,
        sessionId: meta.sessionId ?? null,
        createdAt: now,
        updatedAt: now,
        checkpoints: 0,
        writes: 0,
      })
      return
    }
    if (existing.sessionId !== null && meta.sessionId !== undefined && existing.sessionId !== meta.sessionId) {
      throw new Error(`thread "${thread}" belongs to another session`)
    }
    if (existing.graph !== null && existing.graph !== meta.graph) {
      throw new Error(`thread "${thread}" belongs to graph "${existing.graph}", not "${meta.graph}"`)
    }
    await table.update(key, current => ({
      ...current,
      graph: meta.graph,
      sessionId: meta.sessionId ?? current.sessionId,
      updatedAt: now,
    }))
  }

  /**
   * Bump the counters and timestamp of one thread record.
   * @param {string} thread - thread id.
   * @param {'checkpoints' | 'writes'} field - counter to increment.
   */
  async touchThread(thread, field) {
    const table = this.table('threads')
    const now = Date.now()
    const key = threadKey(thread)
    const existing = table.get(key)
    if (existing === undefined) {
      await table.put(key, {
        graph: null,
        sessionId: null,
        createdAt: now,
        updatedAt: now,
        checkpoints: field === 'checkpoints' ? 1 : 0,
        writes: field === 'writes' ? 1 : 0,
      })
      return
    }
    await table.update(key, current => ({ ...current, updatedAt: now, [field]: current[field] + 1 }))
  }

  /**
   * List known threads, newest first.
   * @param {{ sessionId?: string, graph?: string, limit?: number }} [options] - filters.
   * @returns {Array<{ thread: string, graph: string | null, sessionId: string | null, createdAt: number, updatedAt: number, checkpoints: number, writes: number }>} threads.
   */
  listThreads(options = {}) {
    const rows = []
    for (const [key, record] of this.table('threads').entries()) {
      let thread
      try {
        thread = parseThreadKey(key)
      } catch {
        continue
      }
      if (options.sessionId !== undefined && record.sessionId !== options.sessionId) continue
      if (options.graph !== undefined && record.graph !== options.graph) continue
      rows.push({ thread, ...record })
    }
    rows.sort((left, right) => right.updatedAt - left.updatedAt)
    return options.limit === undefined ? rows : rows.slice(0, options.limit)
  }

  /**
   * Whether one thread holds at least one checkpoint.
   * @param {string} thread - thread id.
   * @returns {boolean} true when the thread can be continued.
   */
  hasThread(thread) {
    return this.table('threads').get(threadKey(thread)) !== undefined
  }

  /**
   * Read one thread's ownership and counters.
   * @param {string} thread - thread id.
   * @returns {object | undefined} the thread record, or undefined.
   */
  threadMeta(thread) {
    assertSafeKey('thread_id', thread)
    return this.table('threads').get(threadKey(thread))
  }
}

/**
 * Open the checkpoint domain.
 * @param {object} storageDomain - the `storageDomain` service.
 * @returns {Promise<{ saver: DshCheckpointSaver, close: () => Promise<void> }>} the open store.
 */
export async function openCheckpointStore(storageDomain) {
  const domain = await storageDomain.open(DOMAIN)
  const saver = new DshCheckpointSaver(domain)
  return { saver, close: () => domain.close() }
}
