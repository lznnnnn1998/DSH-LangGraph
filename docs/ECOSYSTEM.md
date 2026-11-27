# Using the LangChain ecosystem

The plugin is a bridge, not a fork: LangGraph and LangChain stay the libraries you
already know, and DSH stays the runtime. This page covers the seams that are already
wired and how to add an integration that is not bundled.

## What is already bridged

| Need | Use | Notes |
|---|---|---|
| Run a DSH tool from a node | `helpers.callTool(name, args)` | Same session, sandbox, approvals; traced as `langgraph:tool`. |
| Expose DSH tools to LangGraph | `helpers.tools([...names])` | Real LangChain `tool()` instances; visible names only. |
| One text completion | `helpers.callModel(prompt, options)` | Deployment model route; text only. |
| A LangChain chat model | `helpers.chatModel(options)` | Supports `bindTools`; reports usage. |
| Prebuilt ReAct agent | `helpers.createReactAgent(options)` | Wraps the DSH model and tools; returns a compiled graph (LangGraph 1.7.5). |
| Message classes | `helpers.messages` | `AIMessage`, `HumanMessage`, `SystemMessage`, `ToolMessage`. |
| Durable checkpoints | `api.checkpointer` | The plugin compiles your graph with it by default. |
| Long-term memory | `getStore(config)`, `api.store`, `helpers.store()` | `DshStore` over `langgraph_store`; filters/pagination, no vector search. |
| A DSH child agent | `helpers.subagent(prompt, options)` | Caller-delivered; shares the session's subagent tree. |
| Ask the user | `helpers.askUser(questions)` | Stock `ask_user_question` UI; no client code. |
| DSH Trajectory | automatic | LangGraph callbacks → log-only PTC events. |
| LangSmith | environment variables | Independent of the DSH trace; see below. |

## Adding your own LangChain packages

A graph module is an ordinary ES module, so it can import any package resolvable from
its own location. Two practical rules:

- **Put custom graphs in their own package.** Declare the LangChain/LangGraph packages
  you use there, then register the built file with
  `config.graphs: [{ id, module: "/abs/path/to/graph.js" }]`. A module inside this
  package resolves against this package's dependencies, which is convenient but couples
  it to the plugin's versions.
- **Do not load a second `@langchain/core`.** LangChain and LangGraph use `instanceof`
  and class identity across packages; two copies in one Host can reject each other's
  messages and tools. Prefer the classes from `api` (`api.StateGraph`, `api.Annotation`,
  `api.messages`, …) instead of importing a second copy, and pin one version of
  `@langchain/core` in the Host.

The versions this plugin is built and tested against are in `package.json`:
`@langchain/core` 1.5, `@langchain/langgraph` 1.7, and
`@langchain/langgraph-checkpoint` 1.2.

## Retrieval and vector stores

The built-in `DshStore` deliberately implements only the filter/pagination surface.
`search({ query })` throws instead of returning unranked rows, because a fake similarity
result is worse than no result.

For embeddings, compile the graph yourself with a store that implements them:

```ts
import { InMemoryStore } from '@langchain/langgraph-checkpoint'
import { OpenAIEmbeddings } from '@langchain/openai'

export function build({ StateGraph, Annotation, START, END, checkpointer }) {
  const store = new InMemoryStore({
    index: {
      embed: new OpenAIEmbeddings({ model: 'text-embedding-3-small' }),
      dims: 1536,
    },
  })
  return new StateGraph(State)
    // … nodes …
    .compile({ checkpointer, store })
}
```

- Returning a compiled graph opts out of the plugin's automatic compile, including its
  `DshStore`; pass `checkpointer` if you still want durable threads.
- `InMemoryStore` is process-local. A durable vector store (pgvector, a managed vector
  service, …) needs its own package and client; pass it to `compile({ store })` the same
  way.
- A graph can also keep a vector store in a module-level variable. Modules are cached for
  the Host process, so the store survives runs but not restarts.
- The plugin's `api.store` / `helpers.store()` still point at the `DshStore`; a custom
  compiled graph simply does not use them.

## LangSmith

LangChain's own tracing is respected by the underlying runnables. Start the Host with:

```bash
export LANGSMITH_TRACING=true
export LANGSMITH_API_KEY=...
export LANGSMITH_PROJECT=dsh-langgraph
```

`LANGCHAIN_TRACING_V2` / `LANGCHAIN_API_KEY` are still accepted by the installed
`@langchain/core`. The plugin does not read or forward these variables.

- LangSmith and DSH Trajectory are independent traces: LangSmith sees LangGraph runnables,
  models, and tool callbacks; DSH Trajectory sees one `langgraph_run` row with
  `langgraph:node` / `langgraph:tool` / `langgraph:model` sub-calls.
- LangSmith captures prompts and outputs. Do not enable it for profiles that handle data
  you cannot send to that account.
- This bridge was not exercised in this repository's tests (it needs an external key);
  the environment variables are the ones the installed LangChain version reads.

## Prebuilt agents and tools

`helpers.createReactAgent(options)` is LangGraph's prebuilt ReAct agent wired to the DSH
model and tools:

```js
const agent = await helpers.createReactAgent({
  llm: helpers.chatModel(),
  tools: helpers.tools(['read', 'glob', 'bash']),
})
```

In LangGraph 1.7.5 this already returns a **compiled** graph. `compile(entry, ...)`
detects that and does not inject the plugin's checkpointer or store, so returning it
directly as the whole graph loses the durable thread. Use it inside a node (as the
`ask-tools` example and the IR `agent` node do):

```js
return new StateGraph(State)
  .addNode('react', async state => {
    const result = await agent.invoke({ messages: [['human', state.question]] })
    const last = result.messages.at(-1)
    return { answer: typeof last.content === 'string' ? last.content : '' }
  })
  .addEdge(START, 'react')
  .addEdge('react', END)
```

If you do use it as the graph itself, pass `checkpointer` and `store` explicitly to
`createReactAgent`. LangGraph only accepts LangChain Runnables as tools, so use
`helpers.tools` rather than raw DSH tool names; the original DSH JSON schema is what the
model sees.

## Composed graphs

`langgraph_compose` is a declarative front end over the same runtime, not a second
ecosystem. A composed node may be `tool`, `model`, `agent` (this same prebuilt ReAct
agent), `gate`, `map`, `set`, or `subagent`; it cannot import a package or construct a
custom retriever. When a shape needs an arbitrary LangChain package, a vector store, or
custom streaming, write a graph module, or keep that work inside an `agent` node. A
composed spec is never written into `graphs/*.js` and never loads code.

## Streaming

A DSH tool returns one result, so `langgraph_run` cannot stream tokens into the model's
message. Two seams exist today:

- **Background runs** report node/tool progress through the job's output ring
  (`job_output`), not tokens.
- **Inside a node**, `helpers.chatModel().stream()` and LangGraph's own streaming APIs
  work as usual for the graph's own logic. Delivering those chunks to the DSH client is a
  client-side feature (a separate view subscribing to session events), not something the
  tool result can carry.

## What is not a LangChain concern

- DSH's agent loop, permissions, sandbox, subagent tree, and question UI stay DSH's.
  Graphs use them through helpers; they do not reimplement them.
- LangGraph Platform/Studio is not emulated. Threads and the store live in the DSH
  storage domains; there is no hosted API or graph server.
