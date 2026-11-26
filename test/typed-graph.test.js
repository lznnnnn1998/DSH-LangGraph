import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as langgraph from '@langchain/langgraph'
import { MemorySaver } from '@langchain/langgraph-checkpoint'
import { build } from '../graphs/typed-report.ts'

test('loads a TypeScript graph and runs it', async () => {
  const helpers = {
    async callTool(name, args) {
      assert.equal(name, 'glob')
      assert.deepEqual(args, { pattern: 'src/*.js' })
      return 'src/a.js\nsrc/b.js\n'
    },
  }
  const graph = build({ ...langgraph, helpers })
  const compiled = graph.compile({ checkpointer: new MemorySaver() })
  const state = await compiled.invoke(
    { pattern: 'src/*.js' },
    { configurable: { thread_id: 'typed-report-test' } },
  )
  assert.equal(state.count, 2)
  assert.equal(state.verdict, 'small')
  assert.equal(state.files, '2 files match src/*.js')
})
