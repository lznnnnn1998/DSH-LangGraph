/**
 * Type declarations for `dsh-langgraph` graph modules.
 *
 * A graph module can be written in TypeScript and type-checked without importing
 * the plugin at runtime:
 *
 * ```ts
 * import type { GraphApi, GraphModule } from '@lzn1998/dsh-langgraph'
 * export const id = 'report'
 * export const input = { type: 'object' }
 * export function build({ StateGraph, Annotation, START, END, helpers }: GraphApi) { ... }
 * ```
 */
import { Annotation, END, START, StateGraph, interrupt } from '@langchain/langgraph'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'

/** Route options accepted by the model bridges. */
export interface ModelRouteOptions {
  provider?: string
  model?: string
  reasoningEffort?: string
}

/** Options for one text-only model call. */
export interface CallModelOptions extends ModelRouteOptions {
  system?: string
  temperature?: number
  maxTokens?: number
}

/** Options for one DSH subagent delegation. */
export interface SubagentOptions {
  /** Registered subagent provider; defaults to `spawn`. */
  provider?: string
  /** Display label for the child. */
  label?: string
  /** Unique child name; omitted assigns `agent-N`. */
  name?: string
  /** Initial child directory; relative paths resolve against the parent's cwd. */
  cwd?: string
  /** Independent agent preset; only local providers support this. */
  agentPreset?: string
  /** Child model/provider overrides. */
  agentOptions?: Record<string, unknown>
  /** Object-rooted JSON Schema for the child's structured result. */
  schema?: Record<string, unknown>
}

/** The result of one DSH subagent delegation. */
export interface SubagentResult {
  /** Concatenated text blocks of the child's final output. */
  text: string
  /** The child's final content blocks, including any images. */
  output: unknown[]
  /** The validated structured result when `schema` was supplied. */
  structured?: unknown
  /** `completed` or the provider's failure stop reason. */
  stopReason: string
  /** The child's model-facing name. */
  name: string
  /** The child's Session id. */
  childId: string
}

/** The helpers bound to one run. */
export interface GraphHelpers {
  /** The calling DSH agent, when the tool was invoked by an agent. */
  readonly agent: unknown
  /** The calling session id, when known. */
  readonly sessionId: string | undefined
  /** LangChain message classes, re-exported so a graph needs no LangChain dependency. */
  readonly messages: {
    AIMessage: unknown
    HumanMessage: unknown
    SystemMessage: unknown
    ToolMessage: unknown
  }
  /** A LangChain chat model over this deployment's model route. */
  chatModel(options?: ModelRouteOptions): BaseChatModel
  /** Wrap visible DSH tools as LangChain tools. */
  tools(names: string[]): unknown[]
  /** LangGraph's prebuilt ReAct agent over DSH tools and the DSH model. */
  createReactAgent(options?: Record<string, unknown>): Promise<unknown>
  /** One text completion on this deployment's model route. */
  callModel(prompt: string, options?: CallModelOptions): Promise<{ text: string; usage?: unknown }>
  /** Run one DSH tool in the calling agent's scope and return its text content. */
  callTool(name: string, args?: Record<string, unknown>): Promise<string>
  /** Delegate one task to a DSH subagent and await its final output. */
  subagent(prompt: string, options?: SubagentOptions): Promise<SubagentResult>
}

/** The API object passed to a graph module's `build(api)`. */
export interface GraphApi {
  readonly StateGraph: typeof StateGraph
  readonly Annotation: typeof Annotation
  readonly START: typeof START
  readonly END: typeof END
  readonly interrupt: typeof interrupt
  readonly helpers: GraphHelpers
  /** The durable checkpointer the plugin compiles the graph with. */
  readonly checkpointer: BaseCheckpointSaver
  readonly [key: string]: unknown
}

/** The module shape the plugin discovers. */
export interface GraphModule {
  /** Stable graph id used by the `langgraph_run` tool. */
  readonly id: string
  /** One-line description shown when the agent lists graphs. */
  readonly description?: string
  /** JSON Schema of the initial state, shown to the agent. */
  readonly input?: Record<string, unknown>
  /** Return an uncompiled StateGraph (preferred) or a compiled graph. */
  build(api: GraphApi): unknown | Promise<unknown>
}

/** Identity helper for a typed graph module. */
export function defineGraph<T extends GraphModule>(module: T): T
