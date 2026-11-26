/**
 * LangGraph workflows as DSH tools, with durable threads.
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
import { MemorySaver } from '@langchain/langgraph-checkpoint'
import { DshChatModel, AIMessage, HumanMessage, SystemMessage, ToolMessage } from './dsh-chat-model.js'
import { openCheckpointStore } from './dsh-checkpointer.js'
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
  const intro = 'LangGraph workflows are available through the `langgraph_run` tool.'
  if (!ready) {
    return `${intro} Call it with no \`graph\` to list the registered workflows and their input schemas.`
  }
  const available = [...registry.values()]
    .filter(entry => entry.error === undefined)
    .sort((left, right) => left.id.localeCompare(right.id))
  if (available.length === 0) {
    return `${intro}\n\nNo workflow is registered yet; call it with no \`graph\` to re-check.`
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
    'Use it when a task benefits from durable multi-step execution, background runs, '
      + 'interrupts/resume, or traced node/tool/model activity. '
      + 'Use `langgraph_threads` to list, inspect, or delete durable threads.',
    `Registered workflows:\n${lines.join('\n')}`,
    'Omit `graph` to see each workflow\'s input schema.',
  ].join('\n\n')
}

/**
 * Register the graph tools and the graph registry for one activation.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's context.
 * @param {{ graphs?: { id?: string, module: string }[], recursionLimit?: number, model?: { provider?: string, model?: string, reasoningEffort?: string } }} [config]
 *   row config: extra graph modules, the default LangGraph recursion limit, and the
 *   model route graph nodes use through `helpers.callModel` (defaults to this
 *   deployment's selected model).
 */
export function apply(ctx, config) {
  const extra = Array.isArray(config?.graphs) ? config.graphs : []
  const recursionLimit = Number.isInteger(config?.recursionLimit) ? config.recursionLimit : DEFAULT_RECURSION_LIMIT
  const configuredModel = config?.model ?? {}
  const traceEnabled = config?.trace !== false
  const promptEnabled = config?.prompt !== false
  const backgroundEnabled = config?.background !== false
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
  let disposed = false
  ctx.effect(() => () => {
    disposed = true
    if (opened !== undefined) void opened.close()
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
        const store = await openCheckpointStore(storageDomain)
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
  function createHelpers(exec, tracer) {
    const agent = exec?.agent
    const signal = exec?.signal ?? new AbortController().signal
    const helpersRef = {

      agent,
      sessionId: agent?.id,
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
    if (registry.size === 0) return 'No LangGraph workflow is registered.'
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
   * @returns {Promise<object>} the compiled graph.
   */
  async function compile(entry, saver, helpers) {
    const built = await entry.build({ ...langgraph, helpers, checkpointer: saver })
    if (isCompiled(built)) return built
    if (typeof built?.compile !== 'function') {
      throw new Error(`graph "${entry.id}" build(api) must return a StateGraph or a compiled graph`)
    }
    return built.compile({ checkpointer: saver })
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

      const config = {
        recursionLimit: Number.isInteger(args?.maxSteps) ? args.maxSteps : recursionLimit,
        ...(thread === undefined ? {} : { configurable: { thread_id: thread } }),
        ...(signal === undefined ? {} : { signal }),
      }

      // An explicit `resume` answers an interrupt; an explicit `input` applies new input;
      // otherwise a thread that is still mid-run continues from its last checkpoint.
      let input
      let mode
      if (args?.resume !== undefined) {
        input = new Command({ resume: args.resume })
        mode = 'resume'
      } else if (args?.input !== undefined && args.input !== null) {
        input = args.input
        mode = 'input'
      } else if (checkpointed && requestedThread !== undefined && typeof compiled.getState === 'function') {
        const snapshot = await compiled.getState(config)
        if ((snapshot?.next?.length ?? 0) > 0) {
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
  function startBackgroundRun({ args, exec, entry, saver, durable, store, id, requestedThread, thread, sessionId }) {
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
        const helpers = createHelpers(runExec, tracer)
        const done = (async () => {
          try {
            const compiled = await compile(entry, saver, helpers)
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

    const { saver, durable, store } = await ensureSaver()
    const sessionId = exec?.agent?.id
    const requestedThread = typeof args.thread === 'string' && args.thread.trim() !== '' ? args.thread.trim() : undefined

    if (args?.run_in_background === true) {
      if (!backgroundEnabled) return { error: 'run_in_background is disabled for this plugin' }
      if (sessionId === undefined) return { error: 'background runs need a calling agent' }
      const thread = requestedThread ?? `lg_${id}_${Date.now().toString(36)}_${callSeq++}`
      return startBackgroundRun({ args, exec, entry, saver, durable, store, id, requestedThread, thread, sessionId })
    }

    const tracer = createTracer(exec, id, traceEnabled)
    const helpers = createHelpers(exec, tracer)
    const compiled = await compile(entry, saver, helpers)
    const checkpointed = durable || compiled.checkpointer !== undefined
    if (requestedThread !== undefined && !checkpointed) {
      return { error: `graph "${id}" does not carry a checkpointer, so thread "${requestedThread}" cannot be continued` }
    }
    const thread = checkpointed
      ? requestedThread ?? `lg_${id}_${Date.now().toString(36)}_${callSeq++}`
      : undefined
    const conflict = thread === undefined ? undefined : threadConflict(store, thread, sessionId, id)
    if (conflict !== undefined) return { error: conflict }
    return await executeRun({
      id,
      compiled,
      store,
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
    if (action === 'state') {
      const id = typeof args?.graph === 'string' ? args.graph.trim() : ''
      const thread = typeof args?.thread === 'string' ? args.thread.trim() : ''
      if (id === '' || thread === '') return { error: '`graph` and `thread` are required to read a thread state' }
      const entry = registry.get(id)
      if (entry === undefined) return { error: `unknown graph "${id}"` }
      if (entry.error !== undefined) return { error: `graph "${id}" is unavailable: ${entry.error.message}` }
      const conflict = threadConflict(store, thread, sessionId, id)
      if (conflict !== undefined) return { error: conflict }
      const { saver } = await ensureSaver()
      const helpers = createHelpers(exec)
      const compiled = await compile(entry, saver, helpers)
      if (typeof compiled.getState !== 'function' || compiled.checkpointer === undefined) {
        return { error: `graph "${id}" does not carry a checkpointer` }
      }
      const snapshot = await withThreadLock(thread, () => compiled.getState({ configurable: { thread_id: thread } }))
      return {
        graph: id,
        thread,
        values: toJsonSafe(withoutInterrupts(snapshot?.values ?? {})),
        next: toJsonSafe(snapshot?.next ?? []),
        interrupts: toJsonSafe(snapshot?.tasks?.flatMap(task => task.interrupts ?? []) ?? []),
      }
    }
    return { error: `unknown action "${action}"; expected list, state, or delete` }
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
      let order = 2600
      try {
        if (typeof systemPrompt.getSectionOrder === 'function') {
          order = systemPrompt.getSectionOrder('TOOL_WORKFLOW')
        }
      } catch {
        // A future DSH may rename the order; 2600 is the tool-guidance band.
      }
      ctx.effect(() => systemPrompt.section({
        name: 'tool:langgraph',
        order,
        text: () => renderGraphPrompt(registry, scannedReady),
        retirement: 'The langgraph_run workflow guidance no longer applies.',
      }), 'langgraph: prompt section')
    }
  }

  ctx.effect(() => ctx.tools.register({
    name: RUN_TOOL,
    description: 'Run a registered LangGraph workflow. Workflows coordinate work in this workspace: '
      + 'their nodes call the same tools you have, in this session and sandbox. Omit `graph` to list them '
      + 'with their input schemas. Threads are durable: pass `thread` to continue one, and `resume` to answer '
      + 'an interrupted graph. Set `run_in_background` to return a job id immediately; read it with '
      + 'job_output and stop it with job_kill.',
    parameters: {
      type: 'object',
      properties: {
        graph: { type: 'string', description: 'Graph id. Omit to list the registered graphs.' },
        input: { type: 'object', description: 'Initial graph state, as a JSON object.', additionalProperties: true },
        thread: { type: 'string', description: 'Thread to continue. Omit to start a new durable thread.' },
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
    description: 'List, inspect, or delete durable LangGraph threads. Threads of this session are listed by '
      + 'default; `state` shows a thread\'s current values and what it is waiting on.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'state', 'delete'], description: 'Defaults to list.' },
        graph: { type: 'string', description: 'Restrict to one graph id.' },
        thread: { type: 'string', description: 'Thread id, required by state and delete.' },
        all: { type: 'boolean', description: 'List threads of every session, not only this one.' },
        limit: { type: 'integer', description: 'Maximum threads to list (default 25).' },
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
}
