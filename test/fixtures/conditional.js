/** A tiny graph with one conditional edge, for topology tests. */
export const id = 'conditional'
export const description = 'Branches on a boolean.'

export function build({ StateGraph, Annotation, START, END }) {
  const State = Annotation.Root({
    go: Annotation({ reducer: (_left, right) => right, default: () => false }),
  })
  return new StateGraph(State)
    .addNode('left', async () => ({}))
    .addNode('right', async () => ({}))
    .addEdge(START, 'left')
    .addConditionalEdges('left', state => (state.go ? 'right' : END))
    .addEdge('right', END)
}
