import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../index.js'
import { createContext, createStorageDomain, exec } from './support/harness.js'

/** Stand in for the stock question tool and record what the graph asked. */
function answerWith(ctx, answers) {
  const calls = []
  ctx.tools.execute = async request => {
    const call = request.calls[0]
    calls.push({ name: call.name, args: JSON.parse(call.arguments) })
    return {
      results: [{
        result: {
          isError: false,
          content: [{ type: 'text', text: JSON.stringify({ answers }) }],
        },
      }],
    }
  }
  return calls
}

function setup() {
  const storage = createStorageDomain()
  const ctx = createContext(storage)
  apply(ctx)
  return { ctx, run: ctx.tools.get('langgraph_run') }
}

test('askUser renders a question through the stock ask_user_question tool', async () => {
  const { ctx, run } = setup()
  const calls = answerWith(ctx, [{ id: 'answer', selected: ['Yes'] }])

  const result = await run.execute({ graph: 'ask-user', input: { question: 'Ship it?', options: ['Yes', 'No'] } }, exec())
  assert.equal(result.status, 'completed')
  assert.equal(result.state.answer, 'Yes')
  assert.deepEqual(result.state.selected, ['Yes'])

  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'ask_user_question')
  assert.deepEqual(calls[0].args, {
    questions: [{
      id: 'answer',
      question: 'Ship it?',
      options: [{ label: 'Yes' }, { label: 'No' }],
      multi_select: false,
    }],
  })
  ctx.dispose()
})

test('askUser keeps custom text and reports a skipped question', async () => {
  const { ctx, run } = setup()

  answerWith(ctx, [{ id: 'answer', selected: [], custom: 'maybe later' }])
  const custom = await run.execute({ graph: 'ask-user', input: { question: 'Ship it?' } }, exec())
  assert.equal(custom.state.answer, 'maybe later')
  assert.deepEqual(custom.state.selected, [])

  answerWith(ctx, [{ id: 'answer', selected: [] }])
  const skipped = await run.execute({ graph: 'ask-user', input: { question: 'Ship it?' } }, exec())
  assert.equal(skipped.state.answer, '')
  assert.deepEqual(skipped.state.selected, [])
  ctx.dispose()
})

test('askUser rejects a question without text before calling the tool', async () => {
  const { ctx, run } = setup()
  const calls = answerWith(ctx, [])
  const failed = await run.execute({ graph: 'ask-user', input: { question: '' } }, exec())
  assert.equal(failed.status, 'failed')
  assert.match(failed.error.message, /non-empty `question`/)
  assert.equal(failed.failedNode, 'ask')
  assert.equal(calls.length, 0)
  ctx.dispose()
})
