import assert from 'node:assert/strict'
import { DOMAIN } from '../../dsh-checkpointer.js'
import { STORE_DOMAIN } from '../../dsh-store.js'

/** A minimal in-memory stand-in for one domain table. */
export function createTable() {
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
    async deleteMany(keys) {
      let removed = 0
      for (const key of keys) if (records.delete(key)) removed += 1
      return removed
    },
    async update(key, update) {
      if (!records.has(key)) throw new Error(`missing-key: ${key}`)
      const next = update(structuredClone(records.get(key)))
      records.set(key, structuredClone(next))
      return next
    },
  }
}

/** A storage domain that serves both the checkpoint and the long-term store domains. */
export function createStorageDomain() {
  const tables = new Map()
  const opened = []
  return {
    opened,
    async open(spec) {
      assert.ok(spec === DOMAIN || spec === STORE_DOMAIN, `unexpected domain: ${spec?.name}`)
      opened.push(spec.name)
      return {
        table(name) {
          const key = `${spec.name}/${name}`
          if (!tables.has(key)) tables.set(key, createTable())
          return tables.get(key)
        },
        async close() {},
      }
    },
  }
}

/** A context with just the services `apply` touches. */
export function createContext(storageDomain, options = {}) {
  const tools = new Map()
  const disposers = []
  const routes = new Map()
  const sections = []
  const systemPrompt = options.systemPrompt === true
    ? {
        section(definition) {
          sections.push(definition)
          return () => {}
        },
        getSectionOrder(name) {
          return name === 'TOOL_SUBAGENT' ? 2800 : 2600
        },
      }
    : undefined
  const connection = options.routes === true
    ? {
        fetch: {
          register(definition) {
            routes.set(definition.path, definition)
            return () => routes.delete(definition.path)
          },
        },
      }
    : undefined
  const ctx = {
    routes,
    sections,
    effect(factory) {
      const disposer = factory()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    inject(dependencies, callback) {
      if (dependencies.includes('connection') && connection !== undefined) return callback(ctx)
      return undefined
    },
    get(service) {
      if (service === 'storageDomain') return storageDomain
      if (service === 'connection') return connection
      if (service === 'systemPrompt') return systemPrompt
      return undefined
    },
    logger: { warn() {} },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      definitions: () => [],
      execute: async () => {
        throw new Error('this test graph does not call DSH tools')
      },
    },
    dispose() {
      for (const disposer of disposers.reverse()) disposer()
    },
  }
  ctx.tools = Object.assign(ctx.tools, { get: name => tools.get(name) })
  return ctx
}

/** Absolute file URL path for a fixture module. */
export function fixture(name) {
  return new URL(`../fixtures/${name}`, import.meta.url).pathname
}

/** The execution scope passed to a tool call in tests. */
export function exec(sessionId = 'session-1') {
  return { agent: { id: sessionId } }
}
