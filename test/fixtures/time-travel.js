/** A one-node graph whose single step is easy to fork and replay. */
export const id = 'time-travel'
export const description = 'Increments a value once.'

export function build({ StateGraph, Annotation, START, END }) {
  const State = Annotation.Root({
    value: Annotation({ reducer: (_left, right) => right, default: () => 0 }),
    runs: Annotation({ reducer: (left, right) => left + right, default: () => 0 }),
  })
  return new StateGraph(State)
    .addNode('step', async state => ({ value: state.value + 1, runs: 1 }))
    .addEdge(START, 'step')
    .addEdge('step', END)
}
