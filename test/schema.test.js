/**
 * The published JSON Schema must describe the same IR the validator accepts.
 *
 * These tests hold three lines: the committed file is the generator's output,
 * the vocabulary comes from `compose/constants.js`, and the gallery specs pass
 * an independent validator (ajv) as well as the compiler's own.
 */
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import Ajv2020 from 'ajv/dist/2020.js'

import { MAP_BODY_FIELDS, NODE_FIELDS, NODE_KINDS } from '../compose/constants.js'
import { validateSpec } from '../compose/schema.js'
import { specId } from '../compose/specs.js'
import { SCHEMA_PATH, schemaText } from '../scripts/build-schema.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'))
const ajv = new Ajv2020({ allErrors: true, strict: false })
const validate = ajv.compile(schema)

/** A minimal spec that the compiler accepts. */
function baseSpec(extra = {}) {
  return {
    ir: 1,
    state: { note: { type: 'string', default: '' } },
    nodes: [{ id: 'write_note', do: 'set', values: { note: 'done' } }],
    edges: [{ from: 'START', to: 'write_note' }],
    ...extra,
  }
}

const gallerySpecs = (await readdir(join(root, 'gallery/specs'))).filter(file => file.endsWith('.lg.json'))

test('the committed schema is what the generator writes', async () => {
  const committed = await readFile(SCHEMA_PATH, 'utf8')
  assert.equal(committed, schemaText(), 'run `node scripts/build-schema.mjs` and commit the result')
})

test('the schema vocabulary is the compiler vocabulary', () => {
  for (const kind of NODE_KINDS) {
    assert.deepEqual(Object.keys(schema.$defs[`node_${kind}`].properties).sort(), [...NODE_FIELDS[kind]].sort(), kind)
  }
  for (const [kind, fields] of Object.entries(MAP_BODY_FIELDS)) {
    assert.deepEqual(Object.keys(schema.$defs[`mapBody_${kind}`].properties).sort(), [...fields].sort(), kind)
  }
})

test('every gallery spec validates against the schema', async () => {
  assert.ok(gallerySpecs.length >= 6)
  for (const file of gallerySpecs) {
    const spec = JSON.parse(await readFile(join(root, 'gallery/specs', file), 'utf8'))
    const ok = validate(spec)
    assert.ok(ok, `${file}: ${ajv.errorsText(validate.errors, { separator: '; ' })}`)
  }
})

test('the schema rejects what the compiler rejects', () => {
  const cases = {
    'unknown node kind': baseSpec({ nodes: [{ id: 'n', do: 'loop' }] }),
    'unknown field': baseSpec({ extra: true }),
    'merge over an array default': baseSpec({
      state: { rows: { type: 'json', default: [], reducer: 'merge' } },
    }),
    'append over a scalar': baseSpec({
      state: { total: { type: 'number', default: 0, reducer: 'append' } },
    }),
    'conditional START edge': baseSpec({
      edges: [{ from: 'START', to: 'write_note', when: true }],
    }),
    'map body with an unknown transform': baseSpec({
      state: { files: { type: 'string[]', default: [] }, rows: { type: 'json', default: [], reducer: 'append' } },
      nodes: [{
        id: 'scan',
        do: 'map',
        over: 'files',
        body: { do: 'tool', tool: 'read', args: { file_path: { $state: 'item' } }, out: { rows: 'tabel' } },
      }],
      edges: [{ from: 'START', to: 'scan' }],
    }),
  }
  for (const [label, spec] of Object.entries(cases)) {
    assert.equal(validate(spec), false, `schema accepted: ${label}`)
  }
})

test('$schema is editor metadata, not part of the graph', () => {
  const spec = baseSpec({ $schema: schema.$id })
  assert.equal(validateSpec(spec).ok, true)
  assert.equal(validate(spec), true)
  assert.equal(specId(spec), specId(baseSpec()))
})
