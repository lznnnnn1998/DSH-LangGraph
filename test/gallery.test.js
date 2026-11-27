import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { validateSpec } from '../compose/schema.js'

const TOOLS = ['glob', 'read', 'write', 'bash']

test('every gallery spec validates with the DSH tools it uses', () => {
  const directory = new URL('../gallery/specs/', import.meta.url)
  const files = readdirSync(directory).filter(file => file.endsWith('.lg.json')).sort()
  assert.ok(files.length >= 6, 'the gallery should keep at least six graphs')
  for (const file of files) {
    const spec = JSON.parse(readFileSync(new URL(file, directory), 'utf8'))
    const result = validateSpec(spec, { tools: TOOLS })
    const detail = result.errors.map(error => `${error.path} ${error.message}`).join('; ')
    assert.equal(result.ok, true, `${file}: ${detail}`)
  }
})
