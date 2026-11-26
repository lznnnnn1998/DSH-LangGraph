/**
 * Example workflow that pauses for a decision before doing any work.
 *
 * The gate node calls LangGraph's `interrupt(...)`: the run stops, the agent sees
 * `status: "interrupted"` with the question, and `langgraph_run({ graph, thread,
 * resume })` continues exactly at the same node with the answer.
 */

/** Graph id used by the `langgraph_run` tool. */
export const id = 'approval-gate'

/** One-line description shown when the agent lists graphs. */
export const description = 'Ask before scanning: pause on a decision, then glob the approved pattern.'

/** JSON Schema of the initial state, shown to the agent when it lists graphs. */
export const input = {
  type: 'object',
  properties: {
    pattern: { type: 'string', description: 'Glob pattern to scan once approved; defaults to **/*.js.' },
  },
  additionalProperties: false,
}

/** Interpret the resume value as an approve/reject decision. */
function approvedBy(answer) {
  if (typeof answer === 'boolean') return answer
  return /^(y|yes|ok|approve|approved|true)$/i.test(String(answer ?? '').trim())
}

/**
 * Build the graph.
 * @param {object} api - LangGraph API plus `helpers` bound to one run.
 * @returns {object} an uncompiled StateGraph; the plugin compiles it with the checkpointer.
 */
export function build({ StateGraph, Annotation, START, END, interrupt, helpers }) {
  const State = Annotation.Root({
    pattern: Annotation({ reducer: (_, next) => next, default: () => '**/*.js' }),
    decision: Annotation({ reducer: (_, next) => next, default: () => '' }),
    approved: Annotation({ reducer: (_, next) => next, default: () => false }),
    listing: Annotation({ reducer: (_, next) => next, default: () => '' }),
  })
  return new StateGraph(State)
    .addNode('confirm', async state => {
      // Pauses the run; the value returned here is the `resume` value.
      const answer = interrupt({ question: `Scan ${state.pattern} in this workspace?` })
      return { decision: String(answer), approved: approvedBy(answer) }
    })
    .addNode('scan', async state => ({ listing: await helpers.callTool('glob', { pattern: state.pattern }) }))
    .addEdge(START, 'confirm')
    .addConditionalEdges('confirm', state => (state.approved ? 'scan' : END))
    .addEdge('scan', END)
}
