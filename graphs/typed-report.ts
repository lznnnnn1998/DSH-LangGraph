/**
 * A TypeScript example graph.
 *
 * The plugin loads `.ts` graph modules directly on Node 24.22+ (type stripping),
 * so this file needs no build step. Keep the syntax erasable: no enums,
 * namespaces, parameter properties, or decorators.
 *
 * It is also the smallest end-to-end proof that a typed graph module can use
 * `GraphApi` without importing the plugin at runtime: `import type` is erased.
 */
import type { GraphApi, GraphModule } from '../index.js'

/** Graph id used by the `langgraph_run` tool. */
export const id: string = 'typed-report'

/** One-line description shown when the agent lists graphs. */
export const description: string = 'TypeScript example: glob a pattern, then classify the match set.'

/** JSON Schema of the initial state, shown to the agent when it lists graphs. */
export const input = {
  type: 'object',
  properties: {
    pattern: { type: 'string', description: 'Glob pattern to scan; defaults to **/*.js.' },
  },
  additionalProperties: false,
}

/** Build a small typed graph over `helpers.callTool`. */
export function build({ StateGraph, Annotation, START, END, helpers }: GraphApi): unknown {
  const State = Annotation.Root({
    pattern: Annotation({ reducer: (_previous: string, next: string) => next, default: () => '**/*.js' }),
    files: Annotation({ reducer: (_previous: string, next: string) => next, default: () => '' }),
    count: Annotation({ reducer: (_previous: number, next: number) => next, default: () => 0 }),
    verdict: Annotation({ reducer: (_previous: string, next: string) => next, default: () => '' }),
  })
  return new StateGraph(State)
    .addNode('scan', async (state: { pattern: string }) => {
      const listing = await helpers.callTool('glob', { pattern: state.pattern })
      const count = listing.split('\n').map(line => line.trim()).filter(Boolean).length
      return { files: listing, count }
    })
    .addNode('large', async (state: { count: number; pattern: string }) => ({
      verdict: 'large',
      files: `${state.count} files match ${state.pattern}`,
    }))
    .addNode('small', async (state: { count: number; pattern: string }) => ({
      verdict: 'small',
      files: `${state.count} files match ${state.pattern}`,
    }))
    .addEdge(START, 'scan')
    .addConditionalEdges('scan', (state: { count: number }) => (state.count > 5 ? 'large' : 'small'))
    .addEdge('large', END)
    .addEdge('small', END)
}

/** The module shape the plugin checks at load time. */
const module: GraphModule = { id, description, input, build }
export default module
