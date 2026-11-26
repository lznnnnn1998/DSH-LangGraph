/**
 * Example workflow that mixes DSH tool calls with a model call inside one graph.
 *
 * `scan` reads the workspace through the DSH `glob` tool; `answer` asks the
 * deployment's model to explain the result. The graph owns the control flow, DSH
 * owns the tools and the model route.
 */

/** Graph id used by the `langgraph_run` tool. */
export const id = 'ask-workspace'

/** One-line description shown when the agent lists graphs. */
export const description = 'List files matching a glob, then have the model explain the result in one sentence.'

/** JSON Schema of the initial state, shown to the agent when it lists graphs. */
export const input = {
  type: 'object',
  properties: {
    pattern: { type: 'string', description: 'Glob pattern to list; defaults to **/*.md.' },
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
    pattern: Annotation({ reducer: (_, next) => next, default: () => '**/*.md' }),
    files: Annotation({ reducer: (_, next) => next, default: () => '' }),
    explanation: Annotation({ reducer: (_, next) => next, default: () => '' }),
  })
  return new StateGraph(State)
    .addNode('scan', async state => ({ files: await helpers.callTool('glob', { pattern: state.pattern }) }))
    .addNode('answer', async state => {
      const { text } = await helpers.callModel(
        `Files matching ${state.pattern}:\n${state.files || '(none)'}\n\n`
        + 'In one sentence, say what this says about the project layout.',
        { system: 'You are explaining a repository layout to its owner. Be concrete and brief.' },
      )
      return { explanation: text }
    })
    .addEdge(START, 'scan')
    .addEdge('scan', 'answer')
    .addEdge('answer', END)
}
