import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { createContext, createStorageDomain, exec } from './support/harness.js'

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/specs/${name}.json`, import.meta.url), 'utf8'))
}

function minimal(name) {
  return {
    ir: 1,
    ...(name === undefined ? {} : { name }),
    state: { text: { type: 'string', default: '' } },
    nodes: [{ id: 'one', do: 'set', values: { text: 'hi' } }],
    edges: [{ from: 'START', to: 'one' }, { from: 'one', to: 'END' }],
  }
}

function setup(options = {}) {
  const storage = createStorageDomain()
  const ctx = createContext(storage, options)
  apply(ctx, { prompt: false, ui: false })
  ctx.tools.definitions = () => [{ name: 'glob' }, { name: 'read' }]
  return {
    storage,
    ctx,
    compose: ctx.tools.get('langgraph_compose'),
    run: ctx.tools.get('langgraph_run'),
    threads: ctx.tools.get('langgraph_threads'),
  }
}

test('describes the IR without touching storage', async () => {
  const { ctx, compose } = setup()
  const result = await compose.execute({ action: 'describe' }, exec())
  assert.equal(result.ir, 1)
  assert.ok(result.example)
  assert.ok(result.nodes.tool)
  assert.ok(result.nodes.agent)
  assert.ok(result.nodes.map)
  assert.ok(result.nodes.subagent)
  assert.ok(result.guidance.some(line => /4-8/.test(line)))
  assert.ok(result.guidance.some(line => /fork/.test(line)))
  ctx.dispose()
})

test('validates without storing, and reports precise errors', async () => {
  const { ctx, compose } = setup()
  const valid = await compose.execute({ action: 'validate', spec: fixture('scan-report') }, exec())
  assert.equal(valid.ok, true)
  assert.deepEqual(valid.errors, [])
  assert.deepEqual(valid.topology.nodes.map(node => node.id), ['scan', 'judge', 'large', 'small'])

  const invalid = await compose.execute({ action: 'validate', spec: { ir: 2 } }, exec())
  assert.equal(invalid.ok, false)
  assert.ok(invalid.errors.some(error => error.path === 'ir'))
  assert.equal(invalid.topology, undefined)

  const listed = await compose.execute({ action: 'list' }, exec())
  assert.deepEqual(listed.graphs, [], 'validate does not store')
  ctx.dispose()
})

test('rejects a spec whose tool is not visible to the caller', async () => {
  const { ctx, compose } = setup()
  ctx.tools.definitions = () => []
  const result = await compose.execute({ action: 'validate', spec: fixture('scan-report') }, exec())
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(error => error.path === 'nodes[0].tool'))
  ctx.dispose()
})

test('composes, lists, gets and deletes a session-owned graph', async () => {
  const { ctx, compose } = setup()
  const spec = minimal('first')
  const composed = await compose.execute({ action: 'compose', spec }, exec('session-1'))
  assert.equal(composed.ok, true)
  assert.match(composed.graph, /^lg_adhoc_/)
  assert.equal(composed.created, true)
  assert.ok(composed.topology.nodes.some(node => node.id === 'one'))
  assert.match(composed.hint, /langgraph_run/)

  const again = await compose.execute({ action: 'compose', spec }, exec('session-1'))
  assert.equal(again.graph, composed.graph)
  assert.equal(again.created, false)

  const listed = await compose.execute({ action: 'list' }, exec('session-1'))
  assert.deepEqual(listed.graphs.map(row => row.id), [composed.graph])
  assert.equal(listed.graphs[0].threads, 0)
  assert.equal(listed.durable, true)

  const got = await compose.execute({ action: 'get', graph: composed.graph }, exec('session-1'))
  assert.equal(got.graph, composed.graph)
  assert.deepEqual(got.spec, spec)
  assert.equal(got.input.properties.text.type, 'string')

  const deleted = await compose.execute({ action: 'delete', graph: composed.graph }, exec('session-1'))
  assert.deepEqual(deleted, { deleted: composed.graph, threadsDeleted: 0 })
  assert.deepEqual((await compose.execute({ action: 'list' }, exec('session-1'))).graphs, [])
  ctx.dispose()
})

test('does not store an invalid spec', async () => {
  const { ctx, compose } = setup()
  const invalid = await compose.execute({ action: 'compose', spec: { ir: 2 } }, exec('session-1'))
  assert.equal(invalid.ok, false)
  assert.ok(invalid.errors.length > 0)
  assert.deepEqual((await compose.execute({ action: 'list' }, exec('session-1'))).graphs, [])
  ctx.dispose()
})

test('enforces ownership for get, list and delete', async () => {
  const { ctx, compose } = setup()
  const composed = await compose.execute({ action: 'compose', spec: minimal('owned') }, exec('session-1'))

  assert.deepEqual((await compose.execute({ action: 'list' }, exec('session-2'))).graphs, [])
  const got = await compose.execute({ action: 'get', graph: composed.graph }, exec('session-2'))
  assert.match(got.error, /no composed graph/)
  const deleted = await compose.execute({ action: 'delete', graph: composed.graph }, exec('session-2'))
  assert.match(deleted.error, /no composed graph/)
  assert.equal((await compose.execute({ action: 'list' }, exec('session-1'))).graphs.length, 1)
  ctx.dispose()
})

test('requires a calling session for compose and list', async () => {
  const { ctx, compose } = setup()
  const composed = await compose.execute({ action: 'compose', spec: minimal('session') }, {})
  assert.match(composed.error, /needs a calling session/)
  const listed = await compose.execute({ action: 'list' }, {})
  assert.match(listed.error, /needs a calling session/)
  ctx.dispose()
})

test('reads a spec file inside the session workspace and rejects escapes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lg-compose-'))
  try {
    await writeFile(join(dir, 'graph.lg.json'), JSON.stringify(minimal('from-file')), 'utf8')
    const { ctx, compose } = setup()
    const scope = { agent: { id: 'session-1', cwd: dir } }
    const composed = await compose.execute({ action: 'compose', path: 'graph.lg.json' }, scope)
    assert.equal(composed.ok, true)
    assert.match(composed.graph, /^lg_adhoc_/)
    const escape = await compose.execute({ action: 'compose', path: '../outside.json' }, scope)
    assert.match(escape.error, /inside the session workspace/)
    const absolute = await compose.execute({ action: 'compose', path: join(dir, 'graph.lg.json') }, scope)
    assert.match(absolute.error, /relative/)
    const noCwd = await compose.execute({ action: 'compose', path: 'graph.lg.json' }, exec('session-1'))
    assert.match(noCwd.error, /no cwd/)

    // A file with both `spec` and `path` is ambiguous and rejected.
    const both = await compose.execute({ action: 'compose', path: 'graph.lg.json', spec: minimal('both') }, scope)
    assert.match(both.error, /either `spec` or `path`/)
    ctx.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('deleting refuses while threads exist and can delete them explicitly', async () => {
  const { ctx, compose, run, threads } = setup()
  const composed = await compose.execute({ action: 'compose', spec: minimal('threaded') }, exec('session-1'))
  const ran = await run.execute({ graph: composed.graph }, exec('session-1'))
  assert.equal(ran.status, 'completed')
  assert.ok(ran.thread)

  const listed = await compose.execute({ action: 'list' }, exec('session-1'))
  assert.equal(listed.graphs[0].threads, 1)

  const refused = await compose.execute({ action: 'delete', graph: composed.graph }, exec('session-1'))
  assert.match(refused.error, /thread\(s\)/)
  const deleted = await compose.execute({ action: 'delete', graph: composed.graph, delete_threads: true }, exec('session-1'))
  assert.equal(deleted.deleted, composed.graph)
  assert.equal(deleted.threadsDeleted, 1)
  const remaining = await threads.execute({ action: 'list', graph: composed.graph }, exec('session-1'))
  assert.deepEqual(remaining.threads, [])
  ctx.dispose()
})

test('rejects unknown actions and missing graph ids', async () => {
  const { ctx, compose } = setup()
  assert.match((await compose.execute({ action: 'explode' }, exec())).error, /unknown action/)
  assert.match((await compose.execute({ action: 'get' }, exec())).error, /`graph` is required/)
  assert.match((await compose.execute({ action: 'delete' }, exec())).error, /`graph` is required/)
  const missing = await compose.execute({ action: 'get', graph: 'lg_adhoc_missing' }, exec())
  assert.match(missing.error, /no composed graph/)
  ctx.dispose()
})

test('works without a storage domain, using memory stores', async () => {
  const ctx = createContext(undefined)
  apply(ctx, { prompt: false, ui: false })
  ctx.tools.definitions = () => []
  const compose = ctx.tools.get('langgraph_compose')
  const composed = await compose.execute({ action: 'compose', spec: minimal('memory') }, exec())
  assert.equal(composed.ok, true)
  const listed = await compose.execute({ action: 'list' }, exec())
  assert.equal(listed.durable, false)
  const ran = await ctx.tools.get('langgraph_run').execute({ graph: composed.graph }, exec())
  assert.equal(ran.status, 'completed')
  assert.equal(ran.state.text, 'hi')
  ctx.dispose()
})
