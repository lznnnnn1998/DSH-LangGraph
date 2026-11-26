/**
 * Example graph that delegates one task to a DSH subagent.
 *
 * `helpers.subagent(prompt, options)` starts a caller-delivered child through
 * `ctx.subagents`, awaits its final output, and disposes the exact activation.
 * The child has its own Session and tool scope; the parent graph only sees the
 * returned text/structured result. In Trajectory the delegation appears as a
 * `langgraph:subagent` sub-call under the enclosing node.
 */

/** Graph id used by the `langgraph_run` tool. */
export const id = 'ask-subagent'

/** One-line description shown when the agent lists graphs. */
export const description = 'Delegate a question to a DSH subagent from inside a graph node.'

/** JSON Schema of the initial state, shown to the agent when it lists graphs. */
export const input = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'Task sent to the child agent.' },
  },
  additionalProperties: false,
}

/**
 * Build the graph.
 * @param {object} api - LangGraph API plus `helpers` bound to one run.
 * @returns {object} an uncompiled StateGraph.
 */
export function build({ StateGraph, Annotation, START, END, helpers }) {
  const State = Annotation.Root({
    question: Annotation({ reducer: (_, next) => next, default: () => 'What is this workspace?' }),
    answer: Annotation({ reducer: (_, next) => next, default: () => '' }),
    stopReason: Annotation({ reducer: (_, next) => next, default: () => '' }),
    child: Annotation({ reducer: (_, next) => next, default: () => '' }),
  })
  return new StateGraph(State)
    .addNode('delegate', async state => {
      const result = await helpers.subagent(
        `${state.question}\n\nUse this workspace's tools when you need evidence, and answer in at most three sentences.`,
        { label: 'langgraph delegation' },
      )
      return { answer: result.text, stopReason: result.stopReason, child: result.name }
    })
    .addEdge(START, 'delegate')
    .addEdge('delegate', END)
}
