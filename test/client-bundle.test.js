import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { test } from 'node:test'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const bundlePath = new URL('../lib/client.js', import.meta.url)

test('the client bundle is built, valid, and points at the owner routes', () => {
  assert.equal(existsSync(bundlePath), true, 'lib/client.js is committed')
  const source = readFileSync(bundlePath, 'utf8')
  assert.match(source, /window\.__ModuleLoader__\.load\(/)
  assert.ok(source.includes(JSON.stringify(manifest.name)), 'the module id is the package name')
  assert.ok(source.includes('/api/plugins/langgraph/ui'))
  assert.ok(source.includes('/api/plugins/langgraph/topology'))
  // Parse without executing: the browser would fail the whole boot on a syntax error.
  assert.doesNotThrow(() => new Function(source))
})

test('package.json declares the web client half', () => {
  assert.equal(manifest.exports['./client']?.default, './lib/client.js')
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.deepEqual(manifest.dsh?.client?.inject, [
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-sidebar',
  ])
  assert.ok(manifest.files.includes('lib/client.js'))
})
