/**
 * Example ReAct workflow: LangGraph's prebuilt agent driving DSH tools with this
 * deployment's model.
 *
 * This is the "LangGraph in DSH" case end to end: the graph is LangGraph's own
 * prebuilt agent, its chat model is the DSH model route (`helpers.chatModel()`), and
 * every tool it calls is a DSH tool ran in this session's scope (`helpers.tools`).
 */

/** Graph id used by the `langgraph_run` tool. */
export const id = 'ask-tools'

/** One-line description shown when the agent lists graphs. */
export const description = 'Answer a question about this workspace with a ReAct agent over the glob/read tools.'

/** JSON Schema of the initial state, shown to the agent when it lists graphs. */
export const input = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'Question about this workspace.' },
  },
  additionalProperties: false,
}

/**
 * Build the graph.
 * @param {object} api - LangGraph API plus `helpers` bound to one run.
 * @returns {Promise<object>} a compiled LangGraph.
 */
export async function build({ StateGraph, Annotation, START, END, helpers }) {
  const State = Annotation.Root({
    question: Annotation({ reducer: (_, next) => next, default: () => 'What kind of project is this workspace?' }),
    answer: Annotation({ reducer: (_, next) => next, default: () => '' }),
    toolCalls: Annotation({ reducer: (_, next) => next, default: () => 0 }),
  })
  const agent = await helpers.createReactAgent({
    llm: helpers.chatModel({ temperature: 0 }),
    tools: helpers.tools(['glob', 'read']),
    prompt: 'You inspect a workspace with two tools and answer in at most three sentences.',
  })
  return new StateGraph(State)
    .addNode('react', async state => {
      const result = await agent.invoke({ messages: [['human', state.question]] })
      const messages = result.messages ?? []
      const last = messages[messages.length - 1]
      const text = typeof last?.content === 'string'
        ? last.content
        : Array.isArray(last?.content)
          ? last.content.map(part => (part?.type === 'text' ? part.text : '')).join('')
          : String(last?.content ?? '')
      const toolCalls = messages.filter(message => (message.getType?.() ?? '') === 'ai')
        .reduce((total, message) => total + (message.tool_calls?.length ?? 0), 0)
      return { answer: text.trim(), toolCalls }
    })
    .addEdge(START, 'react')
    .addEdge('react', END)
}
