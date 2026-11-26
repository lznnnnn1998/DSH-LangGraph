/**
 * Ask one question through DSH's native question UI, then report the answer.
 *
 * This is the human-in-the-loop path that needs no custom client: the node calls
 * `helpers.askUser`, which runs the stock `ask_user_question` tool in this
 * session, so the user sees the same question card as a model-asked question.
 */
export const id = 'ask-user'
export const description = 'Ask the user one question in the native question UI and return the answer.'
export const input = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'The question to put to the user.' },
    options: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional answer labels; omit for a free-text answer.',
    },
    multiSelect: { type: 'boolean', description: 'Allow more than one option (default false).' },
  },
  required: ['question'],
  additionalProperties: false,
}

export function build({ StateGraph, Annotation, START, END, helpers }) {
  const State = Annotation.Root({
    question: Annotation({ reducer: (_left, right) => right, default: () => '' }),
    options: Annotation({ reducer: (_left, right) => right, default: () => [] }),
    multiSelect: Annotation({ reducer: (_left, right) => right, default: () => false }),
    answer: Annotation({ reducer: (_left, right) => right, default: () => '' }),
    selected: Annotation({ reducer: (_left, right) => right, default: () => [] }),
  })

  return new StateGraph(State)
    .addNode('ask', async state => {
      const options = Array.isArray(state.options) ? state.options.filter(option => typeof option === 'string') : []
      const { answers } = await helpers.askUser([{
        id: 'answer',
        question: state.question,
        ...(options.length === 0 ? {} : { options }),
        multi_select: state.multiSelect === true,
      }])
      const reply = answers.find(answer => answer.id === 'answer')
      return {
        answer: reply?.custom ?? reply?.selected?.join(', ') ?? '',
        selected: reply?.selected ?? [],
      }
    })
    .addEdge(START, 'ask')
    .addEdge('ask', END)
}
