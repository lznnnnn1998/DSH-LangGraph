/**
 * LangGraph graphs as DSH tools, with durable threads.
 *
 * A graph module exports `id`, an optional `description`, an optional `input` JSON
 * Schema for its initial state, and `build(api)` where `api` carries the LangGraph API
 * plus `helpers` and the store's `checkpointer`. `helpers.callTool(name, args)` runs a
 * real DSH tool in the calling agent's scope (same sandbox, approvals, session), so a
 * graph coordinates DSH work instead of becoming a second runtime.
 *
 * Graphs are discovered from `graphs/*.js` in this package and from `config.graphs`
 * (`[{ id, module }]`, `module` relative to this package or an absolute path).
 *
 * Runs are checkpointed in a DSH storage domain, so a thread can be resumed in a later
 * turn — or a later Host process — with `langgraph_run({ graph, thread })`, and an
 * interrupted graph resumes with `langgraph_run({ graph, thread, resume })`.
 * @module dsh-langgraph
 */

import { readdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as langgraph from '@langchain/langgraph'
import { Command } from '@langchain/langgraph'
import { InMemoryStore, MemorySaver } from '@langchain/langgraph-checkpoint'
import { DshChatModel, AIMessage, HumanMessage, SystemMessage, ToolMessage } from './dsh-chat-model.js'
import { openCheckpointStore } from './dsh-checkpointer.js'
import { openDshStore } from './dsh-store.js'
import { createTracer } from './dsh-trace.js'
import { langchainTool } from './dsh-tools.js'

/**
 * Identity helper for graph modules written in TypeScript.
 *
 * It is deliberately a runtime no-op: it gives an editor the `GraphModule` type
 * from this package's declaration file without making a graph module import the
 * plugin at runtime.
 * @template {object} T
 * @param {T} module - the graph module.
 * @returns {T} the same module.
 */
export function defineGraph(module) {
  if (module === null || typeof module !== 'object') {
    throw new TypeError('defineGraph(module): module must be an object')
  }
  return module
}

/** Loader plugin name. */
export const name = 'langgraph'

/** The tool registry is the only hard dependency; storage, `llm` and the default model are looked up optionally per call. */
export const inject = ['tools']

const RUN_TOOL = 'langgraph_run'
const THREADS_TOOL = 'langgraph_threads'
const DEFAULT_RECURSION_LIMIT = 25
let callSeq = 0

/** Tail of the in-process queue for each thread id. */
const threadQueues = new Map()

/**
 * Serialize work on one durable thread. Distinct threads stay independent; the
 * storage domain already serializes its own writes, but a graph run also reads
 * state and compiles a graph, so two runs of the same thread must not interleave.
 * @template T
 * @param {string | undefined} thread - thread id, or undefined for a one-off run.
 * @param {() => Promise<T> | T} work - work to run.
 * @returns {Promise<T>} the work's result.
 */
async function withThreadLock(thread, work) {
  if (thread === undefined) return await work()
  const previous = threadQueues.get(thread) ?? Promise.resolve()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const tail = previous.then(() => gate)
  threadQueues.set(thread, tail)
  await previous.catch(() => {})
  try {
    return await work()
  } finally {
    release()
    if (threadQueues.get(thread) === tail) threadQueues.delete(thread)
  }
}

/** JSON-safe copy of a LangGraph state object. */
function toJsonSafe(value) {
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? String(item) : item)))
  } catch {
    return String(value)
  }
}

/** Concatenated text of one DSH tool result's content blocks. */
function textOf(result) {
  const content = result?.content ?? []
  const text = content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
  return text.trim()
}

/** Whether a graph module returned an already-compiled graph. */
function isCompiled(graph) {
  return typeof graph?.invoke === 'function'
}

/** Remove LangGraph's interrupt carrier from a returned state map. */
function withoutInterrupts(state) {
  if (state === null || typeof state !== 'object') return state
  const { __interrupt__, ...rest } = state
  return rest
}

/** One-line rendering of a graph's input schema for the agent-facing listing. */
function describeInput(entry) {
  if (entry.input === undefined) return undefined
  try {
    return JSON.stringify(entry.input)
  } catch {
    return undefined
  }
}

/**
 * Render the model-facing graph guidance. It is a system-prompt section rather
 * than a second tool: the model should know which graphs exist before deciding
 * to call `langgraph_run`. Input schemas stay out of the prompt; the tool's
 * no-argument listing returns them on demand.
 * @param {Map<string, object>} registry - graph registry.
 * @param {boolean} ready - whether the initial registry scan has completed.
 * @returns {string} section text.
 */
export function renderGraphPrompt(registry, ready) {
  const intro = 'LangGraph graphs are profile-registered, named graphs run by `langgraph_run`. '
    + 'They are not the `workflow` tool (`workflow` runs an ad-hoc JavaScript fan-out script).'
  if (!ready) {
    return `${intro} Call it with no \`graph\` to list the registered graphs and their input schemas.`
  }
  const available = [...registry.values()]
    .filter(entry => entry.error === undefined)
    .sort((left, right) => left.id.localeCompare(right.id))
  if (available.length === 0) {
    return `${intro}\n\nNo graph is registered yet; call it with no \`graph\` to re-check.`
  }
  const limit = 24
  const lines = available.slice(0, limit).map(entry => {
    const description = typeof entry.description === 'string' ? entry.description.replace(/\s+/g, ' ').trim() : ''
    return `- ${entry.id}${description === '' ? '' : `: ${description}`}`
  })
  if (available.length > limit) {
    lines.push(`- … and ${available.length - limit} more; call \`langgraph_run\` with no graph for the full list.`)
  }
  return [
    intro,
    'Use `langgraph_run` when:\n'
      + '- the user names one of the graph ids below;\n'
      + '- a registered graph\'s description matches the requested output; use that graph instead of '
      + 'hand-rolling its steps with bash, subagent, or ad-hoc calls;\n'
      + '- the task needs a durable LangGraph thread, a background run (a DSH job), checkpoint '
      + 'history or replay, a Trajectory sub-call record, or the graph description says it interrupts.',
    'When no graph\'s output matches, use ordinary DSH tools; do not wrap a single tool call in a graph '
      + 'just for ceremony, and do not use the `workflow` tool as a substitute for a named graph.',
    'A LangGraph thread is a durable checkpoint chain for one graph run, not a DSH Session. '
      + 'Use `langgraph_threads` to list, inspect, time-travel, or delete threads, or read a graph\'s topology.',
    `Registered graphs:\n${lines.join('\n')}`,
    'Omit `graph` to list input schemas.',
  ].join('\n\n')
}

/**
 * Register the graph tools and the graph registry for one activation.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's context.
 * @param {{ graphs?: { id?: string, module: string }[], recursionLimit?: number, model?: { provider?: string, model?: string, reasoningEffort?: string }, store?: boolean, retention?: number }} [config]
 *   row config: extra graph modules, the default LangGraph recursion limit, the
 *   model route graph nodes use through `helpers.callModel` (defaults to this
 *   deployment's selected model), whether graphs get a long-term BaseStore
 *   (`store: false` passes none), and how many checkpoints each thread keeps
 *   (default 200; `0` is unlimited).
 */
export function apply(ctx, config) {
  const extra = Array.isArray(config?.graphs) ? config.graphs : []
  const recursionLimit = Number.isInteger(config?.recursionLimit) ? config.recursionLimit : DEFAULT_RECURSION_LIMIT
  const configuredModel = config?.model ?? {}
  const traceEnabled = config?.trace !== false
  const promptEnabled = config?.prompt !== false
  const backgroundEnabled = config?.background !== false
  const storeEnabled = config?.store !== false
  // Keep bounded thread history by default; 0 keeps every checkpoint, which a
  // graph that time-travels further back needs.
  const retention = Number.isInteger(config?.retention) && config.retention >= 0 ? config.retention : 200
  const uiEnabled = config?.ui !== false
  const configuredSubagentProvider = typeof config?.subagentProvider === 'string' && config.subagentProvider !== ''
    ? config.subagentProvider
    : 'spawn'
  /** id -> { id, description, input, build } | { id, error } */
  const registry = new Map()
  let scanned

  // --- durable checkpoint store -------------------------------------------------
  // The domain opens once per activation, on the first call that needs it, so a
  // `storageDomain` mounted after this plugin is still found. A profile without it
  // still gets working threads through `MemorySaver`, but they end with the process.
  let opened
  let openFailure
  let openedGraphStore
  let disposed = false
  ctx.effect(() => () => {
    disposed = true
    if (opened !== undefined) void opened.close()
    if (openedGraphStore !== undefined) void openedGraphStore.close()
  })

  /** @type {Promise<object | undefined> | undefined} */
  let storePromise
  /** @type {import('@langchain/langgraph-checkpoint').MemorySaver | undefined} */
  let memorySaver
  /** thread id -> { graph, sessionId } for the in-process fallback store. */
  const memoryThreads = new Map()

  /** Open the checkpoint store once, or resolve undefined when the profile has none. */
  function openStore() {
    storePromise ??= (async () => {
      const storageDomain = ctx.get('storageDomain')
      if (storageDomain === undefined) {
        openFailure = new Error('the storageDomain service is unavailable in this profile')
        return undefined
      }
      try {
        const store = await openCheckpointStore(storageDomain, { retention })
        if (disposed) {
          await store.close()
          return undefined
        }
        opened = store
        return store
      } catch (error) {
        openFailure = error
        return undefined
      }
    })()
    return storePromise
  }

  /** The saver for one run plus whether threads outlive the process. */
  async function ensureSaver() {
    const store = await openStore()
    if (store !== undefined) return { saver: store.saver, durable: true, store: store.saver }
    memorySaver ??= new MemorySaver()
    return { saver: memorySaver, durable: false, store: undefined }
  }

  // --- long-term store ----------------------------------------------------------
  // The store is a second domain, opened lazily for the same reason. A profile
  // without `storageDomain` gets an InMemoryStore, so a graph that uses memory
  // still runs; only its memories end with the process.
  /** @type {Promise<object | undefined> | undefined} */
  let graphStorePromise
  /** @type {import('@langchain/langgraph-checkpoint').InMemoryStore | undefined} */
  let memoryGraphStore
  let graphStoreFailure

  /** Open the durable BaseStore once, or resolve undefined without a storage domain. */
  function openGraphStore() {
    graphStorePromise ??= (async () => {
      const storageDomain = ctx.get('storageDomain')
      if (storageDomain === undefined) return undefined
      try {
        const openedStore = await openDshStore(storageDomain)
        if (disposed) {
          await openedStore.close()
          return undefined
        }
        openedGraphStore = openedStore
        return openedStore.store
      } catch (error) {
        graphStoreFailure = error
        ctx.logger?.warn(`langgraph: durable store unavailable, falling back to memory: ${error?.message ?? error}`)
        return undefined
      }
    })()
    return graphStorePromise
  }

  /** The BaseStore for one run plus whether it outlives the process. */
  async function ensureGraphStore() {
    if (!storeEnabled) return { store: undefined, durableStore: false }
    const store = await openGraphStore()
    if (store !== undefined) return { store, durableStore: true }
    memoryGraphStore ??= new InMemoryStore()
    return { store: memoryGraphStore, durableStore: false }
  }

  /**
   * Why this caller may not use a thread, or undefined when it may. A durable
   * thread is owned by the graph and session that created it; resuming it from
   * another session or as another graph would mix two runs' state.
   * @param {object | undefined} store - the durable saver, when one is open.
   * @param {string} thread - thread id.
   * @param {string | undefined} sessionId - calling session.
   * @param {string | undefined} graph - graph the caller wants to run.
   * @returns {string | undefined} a model-facing error.
   */
  function threadConflict(store, thread, sessionId, graph) {
    const meta = store === undefined ? memoryThreads.get(thread) : store.threadMeta(thread)
    if (meta === undefined) return undefined
    if (typeof meta.graph === 'string' && graph !== undefined && meta.graph !== graph) {
      return `thread "${thread}" belongs to graph "${meta.graph}", not "${graph}"`
    }
    if (meta.sessionId !== null && meta.sessionId !== undefined && meta.sessionId !== sessionId) {
      return `thread "${thread}" belongs to another session`
    }
    return undefined
  }

  /**
   * Record ownership for the in-process fallback store, or return a conflict.
   * @param {string} thread - thread id.
   * @param {{ graph: string, sessionId?: string }} meta - owner facts.
   * @returns {string | undefined} a model-facing error on conflict.
   */
  function claimMemoryThread(thread, meta) {
    const conflict = threadConflict(undefined, thread, meta.sessionId, meta.graph)
    if (conflict !== undefined) return conflict
    const existing = memoryThreads.get(thread)
    if (existing === undefined) {
      memoryThreads.set(thread, { graph: meta.graph, sessionId: meta.sessionId ?? null })
    } else if (meta.sessionId !== undefined) {
      existing.sessionId = meta.sessionId
    }
    return undefined
  }

  // --- graph registry -----------------------------------------------------------
  async function scan() {
    if (scanned) return scanned
    scanned = (async () => {
      const dir = new URL('./graphs/', import.meta.url)
      let files = []
      try {
        files = (await readdir(dir))
          .filter(file => file.endsWith('.js') || file.endsWith('.mjs') || (file.endsWith('.ts') && !file.endsWith('.d.ts')))
          .sort()
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      const sources = [
        ...files.map(file => ({ module: fileURLToPath(new URL(file, dir)) })),
        ...extra.map(entry => ({ id: entry.id, module: entry.module })),
      ]
      for (const source of sources) {
        let url
        try {
          url = source.module.startsWith('.')
            ? new URL(source.module, import.meta.url)
            : pathToFileURL(source.module)
        } catch (error) {
          registry.set(source.id ?? source.module, { id: source.id ?? source.module, error })
          continue
        }
        try {
          const module = await import(url.href)
          const id = source.id ?? module.id
          if (typeof id !== 'string' || id === '') throw new Error('graph module must export a string `id`')
          if (typeof module.build !== 'function') throw new Error('graph module must export `build(api)`')
          registry.set(id, { id, description: module.description, input: module.input, build: module.build })
        } catch (error) {
          registry.set(source.id ?? source.module, { id: source.id ?? source.module, error })
        }
      }
      return registry
    })()
    return scanned
  }

  /** Resolve the model route for one call: explicit request, row config, then the deployment default. */
  function resolveRoute(requested) {
    const llm = ctx.get('llm')
    if (llm === undefined) throw new Error('the llm service is unavailable in this profile')
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? {}
    const provider = requested?.provider ?? configuredModel.provider ?? selection.provider
    const model = requested?.model ?? configuredModel.model ?? selection.model
    if (typeof provider !== 'string' || typeof model !== 'string') {
      throw new Error('no model route: set config.model.provider/model or ask for one explicitly')
    }
    const reasoningEffort = requested?.reasoningEffort ?? configuredModel.reasoningEffort ?? selection.reasoningEffort
    return { llm, provider, model, reasoningEffort }
  }

  /** Helpers bound to one run: they close over the calling agent and its cancellation. */
  function createHelpers(exec, tracer, store) {
    const agent = exec?.agent
    const signal = exec?.signal ?? new AbortController().signal
    const helpersRef = {

      agent,
      sessionId: agent?.id,
      /**
       * The LangGraph long-term store for this run. With a storage domain it is
       * durable across turns and Host processes; otherwise it is an InMemoryStore.
       * @returns {object | undefined} the BaseStore, or undefined when `config.store` is false.
       */
      store() {
        return store
      },
      /** LangChain message classes, so a graph module needs no LangChain dependency of its own. */
      messages: { AIMessage, HumanMessage, SystemMessage, ToolMessage },
      /**
       * A LangChain chat model over this deployment's model route; supports `bindTools`.
       * @param {{ provider?: string, model?: string, reasoningEffort?: string }} [options]
       * @returns {DshChatModel} the model.
       */
      chatModel(options = {}) {
        const route = resolveRoute(options)
        return new DshChatModel({
          stream: options2 => route.llm.stream(options2),
          route: { provider: route.provider, model: route.model, ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }) },
          ...(agent === undefined ? {} : { sessionId: agent.id }),
          signal,
        })
      },
      /**
       * Wrap DSH tools as LangChain tools, so a LangGraph prebuilt agent can call them.
       * @param {string[]} names - tool names visible to this agent.
       * @returns {object[]} LangChain tools; each call runs the DSH tool in this scope.
       */
      tools(names) {
        const visible = new Map(ctx.tools.definitions(agent).map(definition => [definition.name, definition]))
        const built = []
        for (const toolName of names) {
          const definition = visible.get(toolName)
          if (definition === undefined) {
            throw new Error(`tool "${toolName}" is not visible to this agent; visible: ${[...visible.keys()].sort().join(', ')}`)
          }
          // LangGraph's prebuilt ToolNode serializes its wrapper, not the tool,
          // so its callback cannot name this call. The helper knows the real
          // name; the tracer skips the unnamed callback to avoid a second row.
          built.push(langchainTool(definition, (name, args) => helpersRef.callTool(name, args)))
        }
        return built
      },
      /**
       * LangGraph's prebuilt ReAct agent, using the helpers above.
       * @param {object} options - the prebuilt options; `llm` defaults to `chatModel()`.
       * @returns {object} a compiled graph.
       */
      async createReactAgent(options = {}) {
        const { createReactAgent } = await import('@langchain/langgraph/prebuilt')
        return createReactAgent({ llm: options.llm ?? this.chatModel(), ...options })
      },
      /**
       * One text completion on this deployment's model, from inside a graph node.
       * @param {string} prompt - user text for this call.
       * @param {{ system?: string, provider?: string, model?: string, reasoningEffort?: string, temperature?: number, maxTokens?: number }} [options]
       * @returns {Promise<{ text: string, usage?: object }>}
       */
      async callModel(prompt, options = {}) {
        if (typeof prompt !== 'string' || prompt.trim() === '') throw new Error('callModel needs a non-empty prompt string')
        const route = resolveRoute(options)
        const trace = tracer?.begin('langgraph:model', {
          provider: route.provider,
          model: route.model,
          ...(options.system === undefined ? {} : { system: options.system }),
          prompt,
        })
        try {
          const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
          let text = ''
          let usage
          for await (const chunk of route.llm.stream({
            provider: route.provider,
            model: route.model,
            messages,
            ...(options.system === undefined ? {} : { system: options.system }),
            ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
            ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
            ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
            ...(agent === undefined ? {} : { sessionId: agent.id }),
            signal,
          })) {
            if (chunk.type === 'text-delta') text += chunk.text
            else if (chunk.type === 'usage') usage = chunk.usage
            else if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
              throw new Error(`model call failed: ${chunk.reason.failure.message}`)
            }
          }
          tracer?.finish(trace, {
            content: [{ type: 'text', text: text.trim() }],
            ...(usage === undefined ? {} : { meta: { usage } }),
          })
          return { text: text.trim(), ...(usage === undefined ? {} : { usage }) }
        } catch (error) {
          tracer?.finish(trace, {
            isError: true,
            content: [{ type: 'text', text: String(error?.message ?? error) }],
            error: { name: error?.name ?? 'Error', code: 'LANGGRAPH_MODEL_ERROR' },
          })
          throw error
        }
      },
      /** Run one DSH tool in the calling agent's scope and return its text content. */
      async callTool(toolName, args = {}, options = {}) {
        const trace = options.trace === false ? undefined : tracer?.begin(`langgraph:tool ${toolName}`, args)
        let batch
        try {
          batch = await ctx.tools.execute({
            calls: [{
              type: 'tool-call',
              id: `${RUN_TOOL}-${Date.now()}-${callSeq++}`,
              name: toolName,
              arguments: JSON.stringify(args ?? {}),
            }],
            signal,
            ...(agent === undefined ? {} : { agent }),
          })
        } catch (error) {
          tracer?.finish(trace, {
            isError: true,
            content: [{ type: 'text', text: String(error?.message ?? error) }],
            error: { name: error?.name ?? 'Error', code: 'LANGGRAPH_TOOL_ERROR' },
          })
          throw error
        }
        const settled = batch.results[0]?.result
        const text = textOf(settled)
        if (settled?.isError === true) {
          tracer?.finish(trace, {
            isError: true,
            content: settled?.content ?? [{ type: 'text', text }],
            ...(settled?.error?.info === undefined ? {} : { error: settled.error.info }),
          })
          throw new Error(text === '' ? `tool "${toolName}" failed` : text)
        }
        tracer?.finish(trace, { content: settled?.content ?? [{ type: 'text', text }] })
        return text
      },
      /**
       * Ask the user through DSH's native `ask_user_question` tool. The question
       * renders in the stock question UI, so no client code is needed; the call
       * blocks the node until the user answers (or the profile's wait times out).
       * @param {Array<{ id?: string, question: string, header?: string, options?: Array<string | { label: string, description?: string }>, multi_select?: boolean }>} questions
       *   one or more questions; a missing `id` becomes `q1`, `q2`, …
       * @returns {Promise<{ answers: Array<{ id: string, selected: string[], custom?: string }> }>}
       *   one answer per question; `selected: []` with no `custom` means the user skipped it.
       */
      async askUser(questions) {
        if (!Array.isArray(questions) || questions.length === 0) {
          throw new Error('askUser needs at least one question')
        }
        const normalized = questions.map((question, index) => {
          if (question === null || typeof question !== 'object') {
            throw new Error(`askUser: question ${index + 1} must be an object`)
          }
          if (typeof question.question !== 'string' || question.question.trim() === '') {
            throw new Error(`askUser: question ${index + 1} needs a non-empty \`question\``)
          }
          const id = typeof question.id === 'string' && question.id !== '' ? question.id : `q${index + 1}`
          const options = question.options === undefined ? undefined : question.options.map((option, optionIndex) => {
            if (typeof option === 'string') return { label: option }
            if (option === null || typeof option !== 'object' || typeof option.label !== 'string') {
              throw new Error(`askUser: option ${optionIndex + 1} of question "${id}" needs a label`)
            }
            return { label: option.label, ...(option.description === undefined ? {} : { description: option.description }) }
          })
          return {
            id,
            question: question.question,
            ...(question.header === undefined ? {} : { header: question.header }),
            ...(options === undefined ? {} : { options }),
            ...(question.multi_select === undefined ? {} : { multi_select: question.multi_select }),
          }
        })
        const text = await helpersRef.callTool('ask_user_question', { questions: normalized })
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch {
          throw new Error(`askUser: unexpected answer format: ${text.slice(0, 500)}`)
        }
        if (!Array.isArray(parsed?.answers)) {
          throw new Error(`askUser: unexpected answer format: ${text.slice(0, 500)}`)
        }
        return {
          answers: parsed.answers.map(answer => ({
            id: String(answer?.id ?? ''),
            selected: Array.isArray(answer?.selected) ? answer.selected.map(String) : [],
            ...(typeof answer?.custom === 'string' ? { custom: answer.custom } : {}),
          })),
        }
      },
      /**
       * Delegate one task to a DSH subagent from inside a graph node.
       *
       * The child is caller-delivered: it emits no parent completion notice, and
       * this helper awaits and disposes the exact activation. The child gets its
       * own Session and tool scope, so a graph can fan work out without making
       * the graph itself the agent loop.
       * @param {string} prompt - the child's initial task.
       * @param {{ provider?: string, label?: string, name?: string, cwd?: string, agentPreset?: string, agentOptions?: object, schema?: object }} [options]
       * @returns {Promise<{ text: string, output: object[], structured?: unknown, stopReason: string, name: string, childId: string }>}
       */
      async subagent(prompt, options = {}) {
        if (typeof prompt !== 'string' || prompt.trim() === '') throw new Error('subagent needs a non-empty prompt string')
        if (agent === undefined) throw new Error('subagent needs a calling agent')
        const subagents = ctx.get('subagents')
        if (subagents === undefined) throw new Error('the subagents service is unavailable in this profile')
        const provider = typeof options.provider === 'string' && options.provider !== ''
          ? options.provider
          : configuredSubagentProvider
        // Respect the profile's delegation depth policy, the same one the
        // model-facing subagent tool resolves; a graph must not bypass it.
        const maxDepth = typeof subagents.resolveMaxDepth === 'function' ? subagents.resolveMaxDepth() : undefined
        const trace = tracer?.begin('langgraph:subagent', {
          provider,
          ...(options.label === undefined ? {} : { label: options.label }),
          ...(maxDepth === undefined ? {} : { maxDepth }),
          prompt,
        })
        let started
        let disposeChild
        try {
          started = await subagents.startActivation({
            provider,
            label: options.label ?? `langgraph:${agent.id}`,
            ...(options.name === undefined ? {} : { name: options.name }),
            prompt: [{ type: 'text', text: prompt }],
            parent: agent,
            signal,
            delivery: 'caller',
            ...(maxDepth === undefined ? {} : { maxDepth }),
            ...(options.schema === undefined ? {} : { outputSchema: options.schema }),
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
            ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
            ...(options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions }),
          })
          // A published activation is not cancelled by the caller signal alone;
          // dispose it on abort so cancelling the graph also stops the child.
          let disposing
          disposeChild = () => {
            disposing ??= started.dispose().catch(() => {})
            return disposing
          }
          const onAbort = () => { void disposeChild() }
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
          let result
          try {
            result = await started.result
          } finally {
            signal.removeEventListener('abort', onAbort)
          }
          const text = textOf({ content: result.output })
          const failed = result.stopReason !== 'completed'
          tracer?.finish(trace, {
            isError: failed,
            content: result.output,
            ...(failed ? { error: { name: 'SubagentError', code: `SUBAGENT_${String(result.stopReason).toUpperCase()}` } } : {}),
          })
          return {
            text,
            output: result.output,
            ...(result.structured === undefined ? {} : { structured: result.structured }),
            stopReason: result.stopReason,
            name: started.name,
            childId: started.childId,
          }
        } catch (error) {
          tracer?.finish(trace, {
            isError: true,
            content: [{ type: 'text', text: String(error?.message ?? error) }],
            error: { name: error?.name ?? 'Error', code: 'LANGGRAPH_SUBAGENT_ERROR' },
          })
          throw error
        } finally {
          if (disposeChild !== undefined) await disposeChild()
        }
      },
    }

    return helpersRef
  }

  // --- tools --------------------------------------------------------------------
  async function describeGraphs() {
    await scan()
    if (registry.size === 0) return 'No LangGraph graph is registered.'
    const lines = [...registry.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(entry => {
        if (entry.error !== undefined) return `- ${entry.id}: unavailable (${entry.error.message})`
        const input = describeInput(entry)
        return `- ${entry.id}${entry.description === undefined ? '' : `: ${entry.description}`}`
          + (input === undefined ? '' : `\n  input: ${input}`)
      })
    const { durable } = await ensureSaver()
    lines.push('', durable
      ? 'Threads are durable: pass `thread` to continue a thread, `resume` to answer an interrupt.'
      : `Threads are not durable in this profile${openFailure === undefined ? '' : ` (${openFailure.message})`}: a run ends with this process.`)
    return lines.join('\n')
  }

  /**
   * Build and compile one graph.
   * @param {{ build: (api: object) => object | Promise<object> }} entry - registry entry.
   * @param {object} saver - the checkpointer for this run.
   * @param {object} helpers - run helpers.
   * @param {object | undefined} store - the BaseStore for this run.
   * @returns {Promise<object>} the compiled graph.
   */
  async function compile(entry, saver, helpers, store) {
    const built = await entry.build({ ...langgraph, helpers, checkpointer: saver, store })
    if (isCompiled(built)) return built
    if (typeof built?.compile !== 'function') {
      throw new Error(`graph "${entry.id}" build(api) must return a StateGraph or a compiled graph`)
    }
    return built.compile({ checkpointer: saver, ...(store === undefined ? {} : { store }) })
  }

  /**
   * Compile one graph and return its drawable topology, as plain JSON.
   * @param {{ id: string }} entry - registry entry.
   * @returns {Promise<object>} `{ graph, description?, input?, nodes, edges }`.
   */
  async function topologyOf(entry) {
    const { saver } = await ensureSaver()
    const { store: graphStore } = await ensureGraphStore()
    const helpers = createHelpers(undefined, undefined, graphStore)
    const compiled = await compile(entry, saver, helpers, graphStore)
    if (typeof compiled.getGraph !== 'function' && typeof compiled.getGraphAsync !== 'function') {
      throw new Error(`graph "${entry.id}" does not expose a topology`)
    }
    const drawable = typeof compiled.getGraphAsync === 'function'
      ? await compiled.getGraphAsync()
      : compiled.getGraph()
    // `Graph.toJSON()` yields arrays; the object form is keyed by node id.
    const snapshot = typeof drawable?.toJSON === 'function' ? drawable.toJSON() : drawable
    const rawNodes = Array.isArray(snapshot?.nodes)
      ? snapshot.nodes
      : Object.entries(snapshot?.nodes ?? {}).map(([nodeId, node]) => ({ id: nodeId, ...(node ?? {}) }))
    const nodes = rawNodes.map(node => ({
      id: node?.id,
      ...(node?.type === undefined ? {} : { type: node.type }),
      ...(typeof (node?.name ?? node?.data?.name) === 'string' ? { name: node.name ?? node.data.name } : {}),
      ...(typeof (node?.description ?? node?.data?.description) === 'string'
        ? { description: node.description ?? node.data.description }
        : {}),
    }))
    const edges = (Array.isArray(snapshot?.edges) ? snapshot.edges : []).map(edge => ({
      source: edge?.source,
      target: edge?.target,
      ...(edge?.conditional === true ? { conditional: true } : {}),
    }))
    return {
      graph: entry.id,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      ...(entry.input === undefined ? {} : { input: toJsonSafe(entry.input) }),
      nodes,
      edges,
    }
  }

  /** Bound one background job's model-facing result text. */
  function renderJobResult(result) {
    let text
    try {
      text = JSON.stringify(result, null, 2)
    } catch {
      text = String(result)
    }
    return text.length > 50000 ? `${text.slice(0, 50000)}\n… [truncated ${text.length - 50000} chars]` : text
  }

  /**
   * Execute one prepared graph run under its thread lock. Shared by the
   * foreground tool path and a background job.
   * @param {object} run - prepared run facts.
   * @returns {Promise<object>} the model-facing run result.
   */
  async function executeRun({ id, compiled, store, thread, requestedThread, checkpointed, args, tracer, signal, sessionId }) {
    return await withThreadLock(thread, async () => {
      if (thread !== undefined) {
        const owner = { graph: id, ...(sessionId === undefined ? {} : { sessionId }) }
        if (store === undefined) {
          const conflict = claimMemoryThread(thread, owner)
          if (conflict !== undefined) return { error: conflict }
        } else {
          try {
            await store.claimThread(thread, owner)
          } catch (error) {
            return { error: error?.message ?? String(error) }
          }
        }
      }

      const requestedCheckpoint = typeof args?.checkpoint === 'string' && args.checkpoint.trim() !== ''
        ? args.checkpoint.trim()
        : undefined
      const config = {
        recursionLimit: Number.isInteger(args?.maxSteps) ? args.maxSteps : recursionLimit,
        ...(thread === undefined ? {} : {
          configurable: {
            thread_id: thread,
            ...(requestedCheckpoint === undefined ? {} : { checkpoint_id: requestedCheckpoint }),
          },
        }),
        ...(signal === undefined ? {} : { signal }),
      }

      // An explicit `resume` answers an interrupt; an explicit `input` applies new input;
      // otherwise a thread that is still mid-run continues from its last checkpoint. A
      // checkpoint id replays from that snapshot instead of the thread head.
      let input
      let mode
      if (args?.resume !== undefined) {
        input = new Command({ resume: args.resume })
        mode = 'resume'
      } else if (args?.input !== undefined && args.input !== null) {
        input = args.input
        mode = 'input'
      } else if (checkpointed && requestedThread !== undefined && typeof compiled.getState === 'function') {
        // `getState` synthesizes an empty snapshot for an unknown checkpoint id
        // instead of failing, so ask the saver whether that checkpoint exists.
        if (requestedCheckpoint !== undefined && typeof compiled.checkpointer?.getTuple === 'function') {
          const tuple = await compiled.checkpointer.getTuple(config).catch(() => undefined)
          if (tuple === undefined) {
            return { error: `checkpoint "${requestedCheckpoint}" was not found in thread "${thread}"` }
          }
        }
        let snapshot
        try {
          snapshot = await compiled.getState(config)
        } catch (error) {
          return { error: `checkpoint "${requestedCheckpoint}" was not found in thread "${thread}"` }
        }
        if (snapshot === undefined) {
          return { error: `checkpoint "${requestedCheckpoint}" was not found in thread "${thread}"` }
        }
        if (requestedCheckpoint !== undefined) {
          input = null
          mode = 'replay'
        } else if ((snapshot?.next?.length ?? 0) > 0) {
          input = null
          mode = 'continue'
        } else {
          input = {}
          mode = 'input'
        }
      } else {
        input = {}
        mode = 'input'
      }

      const output = await compiled.invoke(input, { ...config, callbacks: tracer.callbacks })
      const interrupts = output?.__interrupt__
      const state = toJsonSafe(withoutInterrupts(output))
      const head = {
        graph: id,
        mode,
        durable: checkpointed,
        ...(thread === undefined ? {} : { thread }),
        ...(requestedCheckpoint === undefined ? {} : { checkpoint: requestedCheckpoint }),
      }
      if (interrupts !== undefined) {
        return {
          ...head,
          status: 'interrupted',
          interrupts: toJsonSafe(interrupts),
          hint: 'Answer with `langgraph_run({ graph, thread, resume: <value> })`.',
          state,
        }
      }
      return { ...head, status: 'completed', state }
    })
  }

  /**
   * Start one background run as a DSH job. The job owns cancellation and
   * progress; the tool returns its id immediately.
   * @param {object} run - prepared run facts.
   * @returns {object} a background handle, or a model-facing error.
   */
  function startBackgroundRun({ args, exec, entry, saver, durable, store, graphStore, id, requestedThread, thread, sessionId }) {
    const jobs = ctx.get('jobs')
    if (jobs === undefined) {
      return { error: 'background jobs are unavailable in this profile: load @deepseek-ai/dsh-jobs-local and @deepseek-ai/dsh-tool-jobs' }
    }
    const conflict = thread === undefined ? undefined : threadConflict(store, thread, sessionId, id)
    if (conflict !== undefined) return { error: conflict }
    const jobId = jobs.start({
      kind: 'langgraph',
      label: `${id}${thread === undefined ? '' : ` (${thread})`}`,
      ...(sessionId === undefined ? {} : { owner: sessionId }),
      ...(exec?.callId === undefined ? {} : {
        toolCall: { callId: exec.callId, rootCallId: exec.rootCallId ?? exec.callId },
      }),
      run: (job) => {
        const controller = new AbortController()
        const runExec = { ...exec, signal: controller.signal }
        const tracer = createTracer(runExec, id, traceEnabled, (event) => {
          try {
            if (event.phase === 'start') job.append(`▶ ${event.name}\n`)
            else job.append(`${event.isError ? '✗' : '✓'} ${event.name}\n`)
            job.updateProgress(event.name)
          } catch {
            // Progress is best-effort; the graph must not fail on a job write.
          }
        })
        const helpers = createHelpers(runExec, tracer, graphStore)
        const done = (async () => {
          try {
            const compiled = await compile(entry, saver, helpers, graphStore)
            const checkpointed = durable || compiled.checkpointer !== undefined
            if (requestedThread !== undefined && !checkpointed) {
              return { status: 'failed', detail: `graph "${id}" does not carry a checkpointer, so thread "${requestedThread}" cannot be continued` }
            }
            const result = await executeRun({
              id,
              compiled,
              store,
              thread: checkpointed ? thread : undefined,
              requestedThread,
              checkpointed,
              args,
              tracer,
              signal: controller.signal,
              sessionId,
            })
            if (result?.error !== undefined) return { status: 'failed', detail: result.error }
            job.updateProgress(result.status === 'interrupted' ? 'interrupted' : 'completed')
            return {
              status: 'completed',
              detail: result.status === 'interrupted' ? 'interrupted' : `${id} completed`,
              result: renderJobResult(result),
            }
          } catch (error) {
            if (controller.signal.aborted) {
              return { status: 'killed', detail: String(controller.signal.reason ?? 'cancelled') }
            }
            return { status: 'failed', detail: error?.message ?? String(error) }
          }
        })()
        return {
          cancel: (reason) => { controller.abort(reason ?? 'background langgraph run cancelled') },
          done,
        }
      },
    })
    return {
      kind: 'background',
      jobId,
      graph: id,
      status: 'started',
      ...(thread === undefined ? {} : { thread }),
      hint: 'The run continues as a DSH job. Read it with job_output, stop it with job_kill.',
    }
  }

  async function runGraph(args, exec) {
    await scan()
    const id = typeof args?.graph === 'string' ? args.graph.trim() : ''
    if (id === '') return { answer: await describeGraphs() }
    const entry = registry.get(id)
    if (entry === undefined) {
      return { error: `unknown graph "${id}". Registered: ${[...registry.keys()].join(', ') || '(none)'}` }
    }
    if (entry.error !== undefined) {
      return { error: `graph "${id}" is unavailable: ${entry.error.message}` }
    }

    const { saver, durable, store: checkpointStore } = await ensureSaver()
    const { store: graphStore } = await ensureGraphStore()
    const sessionId = exec?.agent?.id
    const requestedThread = typeof args.thread === 'string' && args.thread.trim() !== '' ? args.thread.trim() : undefined
    const requestedCheckpoint = typeof args?.checkpoint === 'string' && args.checkpoint.trim() !== '' ? args.checkpoint.trim() : undefined
    if (requestedCheckpoint !== undefined && requestedThread === undefined) {
      return { error: '`checkpoint` requires `thread`: a checkpoint id belongs to one thread' }
    }

    if (args?.run_in_background === true) {
      if (!backgroundEnabled) return { error: 'run_in_background is disabled for this plugin' }
      if (sessionId === undefined) return { error: 'background runs need a calling agent' }
      const thread = requestedThread ?? `lg_${id}_${Date.now().toString(36)}_${callSeq++}`
      return startBackgroundRun({ args, exec, entry, saver, durable, store: checkpointStore, graphStore, id, requestedThread, thread, sessionId })
    }

    const tracer = createTracer(exec, id, traceEnabled)
    const helpers = createHelpers(exec, tracer, graphStore)
    const compiled = await compile(entry, saver, helpers, graphStore)
    const checkpointed = durable || compiled.checkpointer !== undefined
    if (requestedThread !== undefined && !checkpointed) {
      return { error: `graph "${id}" does not carry a checkpointer, so thread "${requestedThread}" cannot be continued` }
    }
    const thread = checkpointed
      ? requestedThread ?? `lg_${id}_${Date.now().toString(36)}_${callSeq++}`
      : undefined
    const conflict = thread === undefined ? undefined : threadConflict(checkpointStore, thread, sessionId, id)
    if (conflict !== undefined) return { error: conflict }
    return await executeRun({
      id,
      compiled,
      store: checkpointStore,
      thread,
      requestedThread,
      checkpointed,
      args,
      tracer,
      signal: exec?.signal,
      sessionId,
    })
  }

  async function manageThreads(args, exec) {
    await scan()
    const { store } = await ensureSaver()
    const sessionId = exec?.agent?.id
    const action = typeof args?.action === 'string' ? args.action : 'list'
    if (action === 'list') {
      if (store === undefined) {
        return { error: 'threads are not durable in this profile: no storage domain is mounted' }
      }
      if (args?.all !== true && sessionId === undefined) {
        return { error: 'this call has no session; pass `all: true` to list every session\'s threads' }
      }
      const threads = store.listThreads({
        graph: typeof args?.graph === 'string' && args.graph.trim() !== '' ? args.graph.trim() : undefined,
        sessionId: args?.all === true ? undefined : sessionId,
        ...(Number.isInteger(args?.limit) ? { limit: args.limit } : { limit: 25 }),
      })
      return { threads }
    }
    if (action === 'delete') {
      const thread = typeof args?.thread === 'string' ? args.thread.trim() : ''
      if (thread === '') return { error: '`thread` is required to delete a thread' }
      if (store === undefined) return { error: 'threads are not durable in this profile: no storage domain is mounted' }
      const conflict = threadConflict(store, thread, sessionId, undefined)
      if (conflict !== undefined) return { error: conflict }
      await withThreadLock(thread, () => store.forgetThreadRecords(thread))
      return { deleted: thread }
    }
    if (action === 'topology') {
      const id = typeof args?.graph === 'string' ? args.graph.trim() : ''
      if (id === '') return { error: '`graph` is required to read a topology' }
      const entry = registry.get(id)
      if (entry === undefined) return { error: `unknown graph "${id}"` }
      if (entry.error !== undefined) return { error: `graph "${id}" is unavailable: ${entry.error.message}` }
      try {
        return await topologyOf(entry)
      } catch (error) {
        return { error: error?.message ?? String(error) }
      }
    }
    if (action === 'state' || action === 'history' || action === 'edit') {
      const id = typeof args?.graph === 'string' ? args.graph.trim() : ''
      const thread = typeof args?.thread === 'string' ? args.thread.trim() : ''
      if (id === '' || thread === '') {
        return { error: `\`graph\` and \`thread\` are required to ${action === 'edit' ? 'edit' : 'read'} a thread` }
      }
      const entry = registry.get(id)
      if (entry === undefined) return { error: `unknown graph "${id}"` }
      if (entry.error !== undefined) return { error: `graph "${id}" is unavailable: ${entry.error.message}` }
      const conflict = threadConflict(store, thread, sessionId, id)
      if (conflict !== undefined) return { error: conflict }
      const { saver } = await ensureSaver()
      const { store: graphStore } = await ensureGraphStore()
      const helpers = createHelpers(exec, undefined, graphStore)
      const compiled = await compile(entry, saver, helpers, graphStore)
      if (typeof compiled.getState !== 'function' || compiled.checkpointer === undefined) {
        return { error: `graph "${id}" does not carry a checkpointer` }
      }
      const checkpoint = typeof args?.checkpoint === 'string' ? args.checkpoint.trim() : ''
      const checkpointConfig = {
        configurable: {
          thread_id: thread,
          ...(checkpoint === '' ? {} : { checkpoint_id: checkpoint }),
        },
      }
      // `getState` returns an empty snapshot for an unknown id; validate against
      // the saver so `state` and `edit` cannot silently act on a missing checkpoint.
      const checkpointSaver = compiled.checkpointer ?? saver
      if (checkpoint !== '' && action !== 'history' && typeof checkpointSaver?.getTuple === 'function') {
        const tuple = await checkpointSaver.getTuple(checkpointConfig).catch(() => undefined)
        if (tuple === undefined) {
          return { error: `checkpoint "${checkpoint}" was not found in thread "${thread}"` }
        }
      }

      if (action === 'history') {
        if (typeof compiled.getStateHistory !== 'function') {
          return { error: `graph "${id}" cannot list checkpoint history` }
        }
        const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 200) : 20
        const checkpoints = await withThreadLock(thread, async () => {
          const list = []
          for await (const snapshot of compiled.getStateHistory({ configurable: { thread_id: thread } })) {
            list.push({
              checkpoint: snapshot.config?.configurable?.checkpoint_id,
              step: snapshot.metadata?.step,
              source: snapshot.metadata?.source,
              createdAt: snapshot.createdAt,
              next: toJsonSafe(snapshot.next ?? []),
              paused: (snapshot.tasks ?? []).some(task => (task.interrupts?.length ?? 0) > 0),
            })
            if (list.length >= limit) break
          }
          return list
        })
        return {
          graph: id,
          thread,
          checkpoints,
          hint: 'Read one with `state` and its checkpoint, or replay it with `langgraph_run({ graph, thread, checkpoint })`.',
        }
      }

      if (action === 'edit') {
        const values = args?.values
        if (values === null || typeof values !== 'object' || Array.isArray(values)) {
          return { error: '`values` must be a JSON object to edit a thread state' }
        }
        if (typeof compiled.updateState !== 'function') {
          return { error: `graph "${id}" cannot update state` }
        }
        const asNode = typeof args?.asNode === 'string' && args.asNode.trim() !== '' ? args.asNode.trim() : undefined
        const updated = await withThreadLock(thread, () => compiled.updateState(checkpointConfig, values, asNode))
        const newCheckpoint = updated?.configurable?.checkpoint_id
        const snapshot = await compiled.getState(updated)
        return {
          graph: id,
          thread,
          checkpoint: newCheckpoint,
          ...(checkpoint === '' ? {} : { editedFrom: checkpoint }),
          values: toJsonSafe(withoutInterrupts(snapshot?.values ?? {})),
          next: toJsonSafe(snapshot?.next ?? []),
          hint: 'Replay the edit with `langgraph_run({ graph, thread, checkpoint })`.',
        }
      }

      let snapshot
      try {
        snapshot = await withThreadLock(thread, () => compiled.getState(checkpointConfig))
      } catch {
        snapshot = undefined
      }
      if (snapshot === undefined) {
        return {
          error: checkpoint === ''
            ? `thread "${thread}" has no state for graph "${id}"`
            : `checkpoint "${checkpoint}" was not found in thread "${thread}"`,
        }
      }
      return {
        graph: id,
        thread,
        checkpoint: checkpoint === '' ? snapshot.config?.configurable?.checkpoint_id : checkpoint,
        values: toJsonSafe(withoutInterrupts(snapshot?.values ?? {})),
        next: toJsonSafe(snapshot?.next ?? []),
        interrupts: toJsonSafe(snapshot?.tasks?.flatMap(task => task.interrupts ?? []) ?? []),
      }
    }
    return { error: `unknown action "${action}"; expected list, state, history, edit, topology, or delete` }
  }

  // --- model-facing guidance ----------------------------------------------------
  // A system-prompt section, not another tool: the model should know which
  // graphs exist before it decides to call `langgraph_run`. The section is
  // effect-owned and retires with this plugin; no DSH source is touched.
  if (promptEnabled) {
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt !== undefined) {
      let scannedReady = false
      void scan().then(() => { scannedReady = true }).catch(error => {
        ctx.logger?.warn(`langgraph: graph scan failed: ${error?.message ?? error}`)
      })
      // Sit after the `workflow` tool's "only when the user asks" rule and just
      // before subagent guidance. The old TOOL_WORKFLOW slot put this section
      // next to a second "workflow" rule, which read as one instruction.
      let order = 2790
      try {
        if (typeof systemPrompt.getSectionOrder === 'function') {
          order = systemPrompt.getSectionOrder('TOOL_SUBAGENT') - 10
        }
      } catch {
        // A future DSH may rename the order; 2790 is just before subagents.
      }
      ctx.effect(() => systemPrompt.section({
        name: 'tool:langgraph',
        order,
        text: () => renderGraphPrompt(registry, scannedReady),
        retirement: 'The langgraph_run graph guidance no longer applies.',
      }), 'langgraph: prompt section')
    }
  }

  ctx.effect(() => ctx.tools.register({
    name: RUN_TOOL,
    description: 'Run one registered LangGraph graph by id. Use it when the user names a graph, a graph\'s '
      + 'description matches the requested output, or the task needs a durable thread, background job, '
      + 'checkpoint replay, or Trajectory record; it is not the `workflow` tool. Omit `graph` to list graphs '
      + 'and input schemas. Threads are durable LangGraph checkpoint chains (not DSH Sessions): pass `thread` '
      + 'to continue one, `resume` to answer an interrupt, and `checkpoint` to replay a snapshot from '
      + '`langgraph_threads` history. `run_in_background` returns a DSH job id for `job_output`/`job_kill`.',
    parameters: {
      type: 'object',
      properties: {
        graph: { type: 'string', description: 'Registered graph id; omit to list graphs and input schemas.' },
        input: { type: 'object', description: 'Initial graph state, as a JSON object.', additionalProperties: true },
        thread: { type: 'string', description: 'LangGraph thread to continue; omit to start a new durable thread. Not a DSH Session id.' },
        checkpoint: {
          type: 'string',
          description: 'Checkpoint id to replay from (langgraph_threads action "history"); requires `thread`.',
        },
        resume: { description: 'Value handed to an interrupted graph, resuming it where it stopped.' },
        maxSteps: { type: 'integer', description: 'Upper bound on graph supersteps for this run.' },
        ...(backgroundEnabled ? {
          run_in_background: {
            type: 'boolean',
            description: 'Run as a background DSH job: return a job id immediately instead of waiting. '
              + 'The run keeps going after this tool call; its result is read with job_output.',
          },
        } : {}),
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
    // Two runs are safe to overlap: the per-thread queue serializes the same
    // thread, and distinct threads share only the storage domain's own write chain.
    isConcurrencySafe: () => true,
    execute: (args, exec) => runGraph(args ?? {}, exec),
  }), 'langgraph: run tool')

  ctx.effect(() => ctx.tools.register({
    name: THREADS_TOOL,
    description: 'Manage durable LangGraph threads and a graph\'s topology. `list` (this session by default), '
      + '`state` (values, next, interrupts), `history` (checkpoint ids), `edit` (fork a checkpoint with new '
      + 'values), `topology` (nodes/edges), or `delete`. A thread is a LangGraph checkpoint chain, not a '
      + 'DSH Session. Replay an edit with `langgraph_run({ checkpoint })`.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'state', 'history', 'edit', 'topology', 'delete'], description: 'Defaults to list.' },
        graph: { type: 'string', description: 'Graph id; required by state, history, edit, and topology.' },
        thread: { type: 'string', description: 'LangGraph thread id; required by state, history, edit, and delete. Not a DSH Session id.' },
        checkpoint: { type: 'string', description: 'Checkpoint id for state, edit, or replay; defaults to the thread head.' },
        values: { type: 'object', description: 'State fields to write in an edit, as a JSON object.', additionalProperties: true },
        asNode: { type: 'string', description: 'Attribute an edit to this node, when the graph needs one.' },
        all: { type: 'boolean', description: 'List threads of every session, not only this one.' },
        limit: { type: 'integer', description: 'Maximum threads (default 25) or checkpoints (default 20) to return.' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
    execute: (args, exec) => manageThreads(args ?? {}, exec),
  }), 'langgraph: threads tool')

  // --- owner UI routes ----------------------------------------------------------
  // The optional client panel reads these authenticated, owner-only exact routes.
  // A headless Host has no `connection` service, so nothing is served; no DSH
  // source is touched. `config.ui: false` keeps the routes off in a Web profile.
  if (uiEnabled && typeof ctx.inject === 'function') {
    ctx.inject(['connection'], (scope) => {
      const connection = scope.get('connection')
      if (typeof connection?.fetch?.register !== 'function') return
      const json = (value, status = 200) => new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
      scope.effect(() => connection.fetch.register({
        path: '/api/plugins/langgraph/ui',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => {
          await scan()
          const { store } = await ensureSaver()
          const byGraph = {}
          let total = 0
          if (store !== undefined) {
            for (const thread of store.listThreads({})) {
              total += 1
              const key = typeof thread.graph === 'string' ? thread.graph : '(unknown)'
              byGraph[key] = (byGraph[key] ?? 0) + 1
            }
          }
          return json({
            graphs: [...registry.values()]
              .sort((left, right) => left.id.localeCompare(right.id))
              .map(entry => entry.error === undefined
                ? {
                    id: entry.id,
                    ...(entry.description === undefined ? {} : { description: entry.description }),
                    ...(entry.input === undefined ? {} : { input: toJsonSafe(entry.input) }),
                  }
                : { id: entry.id, error: entry.error.message }),
            threads: { total, byGraph, durable: store !== undefined },
          })
        },
      }), 'langgraph: ui route')
      scope.effect(() => connection.fetch.register({
        path: '/api/plugins/langgraph/topology',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async request => {
          await scan()
          const id = new URL(request.url).searchParams.get('graph') ?? ''
          if (id === '') return json({ error: '`graph` query parameter is required' }, 400)
          const entry = registry.get(id)
          if (entry === undefined) return json({ error: `unknown graph "${id}"` }, 404)
          if (entry.error !== undefined) return json({ error: `graph "${id}" is unavailable: ${entry.error.message}` }, 500)
          try {
            return json(await topologyOf(entry))
          } catch (error) {
            return json({ error: error?.message ?? String(error) }, 500)
          }
        },
      }), 'langgraph: topology route')
    })
  }
}
