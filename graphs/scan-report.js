/**
 * Example LangGraph workflow shipped with the plugin.
 *
 * It demonstrates the two things this plugin adds to LangGraph inside DSH:
 * - a graph is registered by id and run from the agent's `langgraph_run` tool;
 * - nodes call real DSH tools through `helpers.callTool`, in the calling agent's
 *   scope (same sandbox, same approvals, same session), so the graph is a
 *   coordinator of DSH work rather than a separate runtime.
 */

/** Graph id used by the `langgraph_run` tool. */
export const id = 'scan-report'

/** One-line description shown when the agent lists graphs. */
export const description = 'Glob a pattern in the workspace, then report whether the match set is large.'

/** JSON Schema of the initial state, shown to the agent when it lists graphs. */
export const input = {
  type: 'object',
  properties: {
    pattern: { type: 'string', description: 'Glob pattern to scan; defaults to **/*.js.' },
  },
  additionalProperties: false,
}

/**
 * Build the graph.
 * @param {object} api - LangGraph API plus `helpers` bound to one run.
 * @returns {object} a compiled LangGraph.
 */
export function build({ StateGraph, Annotation, START, END, helpers }) {
  const State = Annotation.Root({
    pattern: Annotation({ reducer: (_, next) => next, default: () => '**/*.js' }),
    matches: Annotation({ reducer: (_, next) => next, default: () => '' }),
    count: Annotation({ reducer: (_, next) => next, default: () => 0 }),
    verdict: Annotation({ reducer: (_, next) => next, default: () => '' }),
    report: Annotation({ reducer: (_, next) => next, default: () => '' }),
  })
  return new StateGraph(State)
    .addNode('scan', async state => {
      const listing = await helpers.callTool('glob', { pattern: state.pattern })
      const count = listing.split('\n').map(line => line.trim()).filter(Boolean).length
      return { matches: listing, count }
    })
    .addNode('large', async state => ({ verdict: 'large', report: `${state.count} files match ${state.pattern}` }))
    .addNode('small', async state => ({ verdict: 'small', report: `${state.count} files match ${state.pattern}` }))
    .addEdge(START, 'scan')
    .addConditionalEdges('scan', state => (state.count > 5 ? 'large' : 'small'))
    .addEdge('large', END)
    .addEdge('small', END)
}
