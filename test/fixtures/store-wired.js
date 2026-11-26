/** A graph that proves the plugin hands it a real, shared BaseStore. */
export const id = 'store-wired'
export const description = 'Writes and reads one long-term memory.'

export function build({ StateGraph, Annotation, START, END, getStore, helpers }) {
  const State = Annotation.Root({
    value: Annotation({ reducer: (_left, right) => right, default: () => 0 }),
    same: Annotation({ reducer: (_left, right) => right, default: () => false }),
  })
  return new StateGraph(State)
    .addNode('remember', async (_state, config) => {
      // LangGraph wraps the compiled store in an AsyncBatchedStore for the node,
      // so `getStore(config)` is a wrapper over the same DshStore, not the object itself.
      const scoped = getStore(config)
      const viaHelper = helpers.store()
      if (scoped === undefined || viaHelper === undefined) {
        return { value: -1, same: scoped === viaHelper }
      }
      await scoped.put(['wired'], 'answer', { value: 42 })
      const item = await viaHelper.get(['wired'], 'answer')
      return { value: item.value.value, same: item.value.value === 42 }
    })
    .addEdge(START, 'remember')
    .addEdge('remember', END)
}
