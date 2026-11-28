/**
 * Assert what `npm publish` would ship.
 *
 * `files` in package.json is easy to widen by accident; a raw recording or a
 * local secret in the tarball is not recoverable once it is on the registry.
 * This test reads the real tarball listing from npm, not a hand-kept list.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function packList() {
  const stdout = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 120_000,
  })
  return JSON.parse(stdout)[0]
}

const packed = packList()
const paths = packed.files.map(file => file.path)

test('the tarball carries no local or private material', () => {
  const forbidden = ['.secrets/', '.lg-big/', 'node_modules/', 'test/', 'media/raw/', '.git/']
  for (const path of paths) {
    for (const prefix of forbidden) assert.ok(!path.startsWith(prefix), `packed: ${path}`)
  }
})

test('media is an explicit allowlist', () => {
  const allowed = new Set(['media/dsh-langgraph-demo.webm'])
  for (const path of paths.filter(item => item.startsWith('media/'))) {
    assert.ok(allowed.has(path), `unexpected media in the tarball: ${path}`)
  }
  assert.ok(paths.includes('media/dsh-langgraph-demo.webm'))
})

test('the package carries the files the README promises', () => {
  const required = [
    'package.json',
    'index.js',
    'index.d.ts',
    'README.md',
    'LICENSE',
    'icon.svg',
    'compose/schema.js',
    'compose/constants.js',
    'schema/graphspec.schema.json',
    'docs/COMPOSE.md',
    'gallery/index.html',
    'gallery/specs/research-brief.lg.json',
    'bench/README.md',
  ]
  for (const path of required) assert.ok(paths.includes(path), `missing from the tarball: ${path}`)
})

test('the tarball stays small enough to install without thinking', () => {
  assert.ok(packed.entryCount <= 100, `too many files: ${packed.entryCount}`)
  assert.ok(packed.unpackedSize <= 5 * 1024 * 1024, `unpacked size: ${packed.unpackedSize}`)
  for (const file of packed.files) {
    if (file.path === 'media/dsh-langgraph-demo.webm') continue
    assert.ok(file.size <= 2 * 1024 * 1024, `large file: ${file.path} (${file.size} bytes)`)
  }
})
