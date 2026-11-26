/**
 * LangGraph activity as DSH log-only trace events.
 *
 * DSH's Trajectory view renders a tool call and its nested sub-calls from
 * `tool/ptc-dispatch-start` and `tool/ptc-dispatch`. Those two events are
 * log-only: `deriveMessages()` ignores them, so a trace never enters the model
 * context. They are also the only nested-call vocabulary the stock Trajectory
 * view understands, which makes them the non-invasive bridge for a third-party
 * plugin: neither DSH nor LangGraph is modified.
 *
 * Every event below has the shape the PTC executor writes. The outer tool call
 * is the `langgraph_run` row; node boundaries, LangChain tool calls, and model
 * calls are its nested sub-calls, so the whole graph is one expandable run.
 * @module dsh-langgraph/trace
 */

const MAX_TEXT = 4000
const MAX_MESSAGE_TEXT = 1500

/** JSON-safe value, or the fallback when the value cannot round-trip. */
function jsonValue(value, fallback = {}) {
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? String(item) : item)))
  } catch {
    return fallback
  }
}

/** Concatenated text of a content value. */
function contentText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map(part => (typeof part === 'string' ? part : part?.type === 'text' ? part.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  if (value === null || value === undefined) return ''
  return JSON.stringify(jsonValue(value))
}

/** Bound one trace field so a large state or result cannot flood the log. */
function clip(text, limit = MAX_TEXT) {
  const value = String(text ?? '')
  return value.length <= limit ? value : `${value.slice(0, limit)}\n… [truncated ${value.length - limit} chars]`
}

/** Summarize the LangChain message batches of one model call. */
function summarizeMessages(messages) {
  const flat = Array.isArray(messages) ? messages.flat(1) : []
  return flat.map(message => ({
    role: String(message?.getType?.() ?? message?._getType?.() ?? message?.role ?? 'message'),
    text: clip(contentText(message?.content), MAX_MESSAGE_TEXT),
  }))
}

/** Text of one `LLMResult`, falling back to the tool calls a model-only reply requested. */
function resultText(output) {
  const generation = output?.generations?.[0]?.[0]
  if (generation === undefined) return ''
  if (typeof generation.text === 'string' && generation.text !== '') return generation.text
  const content = contentText(generation.message?.content)
  if (content !== '') return content
  const toolCalls = generation.message?.tool_calls
  return Array.isArray(toolCalls) && toolCalls.length > 0 ? JSON.stringify(jsonValue(toolCalls, [])) : ''
}

/**
 * Create a tracer bound to one `langgraph_run` execution.
 * @param {{ agent?: object, callId?: string, rootCallId?: string }} exec - the tool execution.
 * @param {string} graphId - the graph being run.
 * @param {boolean} [configured=true] - row config; false disables tracing.
 * @param {(event: { phase: 'start' | 'end', name: string, isError?: boolean }) => void} [onEvent]
 *   optional progress sink for a background job's output ring.
 * @returns {object} tracer with `callbacks`, `begin`, `finish`, and `currentNode`.
 */
export function createTracer(exec, graphId, configured = true, onEvent) {
  const session = exec?.agent?.session
  const outerCallId = exec?.callId
  const rootCallId = exec?.rootCallId ?? outerCallId
  const enabled = configured && session !== undefined && typeof session.append === 'function'
    && typeof outerCallId === 'string' && typeof rootCallId === 'string'
  let live = enabled
  let sequence = 0
  /** runId -> trace handle for a node, inner chain, tool, or model call. */
  const runs = new Map()
  /** Active node traces in start order; the last one is the best-effort current node. */
  const nodes = []

  /**
   * Append one trace event. A rejected append disables tracing for this run
   * rather than risking the graph, which is the product work.
   */
  function append(type, data) {
    if (!live) return false
    try {
      session.append(type, data)
      return true
    } catch {
      live = false
      return false
    }
  }

  /** Report one trace transition to the optional background-job sink. */
  function notify(event) {
    if (onEvent === undefined) return
    try {
      onEvent(event)
    } catch {
      // A progress sink must never break the graph.
    }
  }

  /**
   * Start one nested trace.
   * @param {string} name - display name in Trajectory.
   * @param {unknown} args - JSON-safe arguments shown by the inspector.
   * @param {object} [parent] - explicit parent trace; defaults to the current node.
   * @returns {object | undefined} a handle for `finish`, or undefined when tracing is off.
   */
  function begin(name, args, parent) {
    if (!live) return undefined
    // An omitted parent means "the current node"; null means "explicitly outer"
    // (siblings under the root graph must not nest under the last active node).
    const resolved = parent === undefined ? nodes.at(-1) : parent
    const parentCallId = resolved === null ? outerCallId : resolved?.subCallId ?? outerCallId
    const subCallId = `${outerCallId}:lg:${++sequence}`
    const argumentsValue = jsonValue(args ?? {})
    if (!append('tool/ptc-dispatch-start', {
      rootCallId,
      parentCallId,
      subCallId,
      name,
      arguments: argumentsValue,
    })) return undefined
    notify({ phase: 'start', name })
    return { rootCallId, parentCallId, subCallId, name, arguments: argumentsValue }
  }

  /**
   * Settle one nested trace.
   * @param {object | undefined} handle - the handle from `begin`.
   * @param {{ content?: unknown[], isError?: boolean, error?: object, meta?: unknown }} [outcome] - trace outcome.
   */
  function finish(handle, outcome = {}) {
    if (handle === undefined || !live) return
    const { content = [], isError = false, error, meta } = outcome
    if (!append('tool/ptc-dispatch', {
      rootCallId: handle.rootCallId,
      parentCallId: handle.parentCallId,
      subCallId: handle.subCallId,
      name: handle.name,
      arguments: handle.arguments,
      isError,
      content: jsonValue(content, []),
      ...(error === undefined ? {} : { error: jsonValue(error, {}) }),
      ...(meta === undefined ? {} : { meta: jsonValue(meta, {}) }),
    })) return
    notify({ phase: 'end', name: handle.name, isError })
  }

  /**
   * The trace a nested callback belongs to. An undefined parent run means the
   * caller has no enclosing run and the current node is the right fallback; a
   * defined but unmapped run (the graph root) must stay at the outer level so
   * fan-out siblings do not nest under whichever node started last.
   */
  function parentOf(runId) {
    if (runId === undefined) return undefined
    return runs.get(runId) ?? null
  }

  /** Close a trace as a failure, or as a pause when LangGraph interrupted it. */
  function closeError(handle, error) {
    if (error?.name === 'GraphInterrupt' || error?.name === 'NodeInterrupt') {
      finish(handle, {
        isError: false,
        content: [{ type: 'text', text: `interrupted: ${clip(error?.message ?? '')}` }],
      })
      return
    }
    finish(handle, {
      isError: true,
      content: [{ type: 'text', text: clip(error?.message ?? String(error ?? 'failed')) }],
      error: {
        name: error?.name ?? 'Error',
        code: typeof error?.code === 'string' ? error.code : 'LANGGRAPH_ERROR',
      },
    })
  }

  /** Whether one chain run is an actual graph node rather than an inner runnable. */
  function isNodeRun(node, tags) {
    return typeof node === 'string' && node !== '' && node !== '__start__' && node !== '__end__'
      && Array.isArray(tags) && tags.some(tag => typeof tag === 'string' && tag.startsWith('graph:step:'))
      && !tags.includes('langsmith:hidden')
  }

  const handler = {
    name: 'dsh-langgraph-trace',

    handleChainStart(serialized, inputs, runId, parentRunId, tags, metadata) {
      const node = metadata?.langgraph_node
      if (isNodeRun(node, tags)) {
        const handle = begin(`langgraph:node ${node}`, {
          graph: graphId,
          node,
          step: metadata?.langgraph_step,
        }, parentRunId === undefined ? null : parentOf(parentRunId))
        if (handle !== undefined) {
          const trace = { ...handle, kind: 'node', runId, node }
          runs.set(runId, trace)
          nodes.push(trace)
        }
        return
      }
      // Inner chains inherit their node's trace, so a tool/model event nested
      // under a RunnableLambda still lands inside the node.
      const inherited = runs.get(parentRunId)
      if (inherited !== undefined) runs.set(runId, inherited)
    },

    handleChainEnd(outputs, runId) {
      const trace = runs.get(runId)
      if (trace === undefined) return
      if (trace.kind === 'node' && trace.runId === runId) {
        finish(trace, {
          content: [{ type: 'text', text: clip(JSON.stringify(jsonValue(outputs))) }],
        })
        const index = nodes.lastIndexOf(trace)
        if (index >= 0) nodes.splice(index, 1)
      }
      runs.delete(runId)
    },

    handleChainError(error, runId) {
      const trace = runs.get(runId)
      if (trace === undefined) return
      if (trace.kind === 'node' && trace.runId === runId) {
        closeError(trace, error)
        const index = nodes.lastIndexOf(trace)
        if (index >= 0) nodes.splice(index, 1)
      }
      runs.delete(runId)
    },

    handleToolStart(tool, input, runId, parentRunId) {
      // Prebuilt ToolNode serializes a DynamicStructuredTool wrapper without a
      // name; the DSH bridge traces the real name from the tool definition.
      const name = typeof tool?.name === 'string' && tool.name !== '' ? tool.name : undefined
      if (name === undefined) return
      const handle = begin(`langgraph:tool ${name}`, input, parentOf(parentRunId))
      if (handle !== undefined) runs.set(runId, { ...handle, kind: 'tool' })
    },

    handleToolEnd(output, runId) {
      const trace = runs.get(runId)
      if (trace === undefined) return
      finish(trace, { content: [{ type: 'text', text: clip(contentText(output)) }] })
      runs.delete(runId)
    },

    handleToolError(error, runId) {
      const trace = runs.get(runId)
      if (trace === undefined) return
      closeError(trace, error)
      runs.delete(runId)
    },

    handleChatModelStart(llm, messages, runId, parentRunId) {
      const handle = begin('langgraph:model', {
        model: llm?.model ?? llm?.name ?? llm?._llmType?.(),
        messages: summarizeMessages(messages),
      }, parentOf(parentRunId))
      if (handle !== undefined) runs.set(runId, { ...handle, kind: 'model' })
    },

    handleLLMStart(llm, prompts, runId, parentRunId) {
      const handle = begin('langgraph:model', {
        model: llm?.model ?? llm?.name ?? llm?._llmType?.(),
        prompts: (Array.isArray(prompts) ? prompts : []).map(prompt => clip(prompt, MAX_MESSAGE_TEXT)),
      }, parentOf(parentRunId))
      if (handle !== undefined) runs.set(runId, { ...handle, kind: 'model' })
    },

    handleLLMEnd(output, runId) {
      const trace = runs.get(runId)
      if (trace === undefined) return
      const usage = output?.llmOutput?.tokenUsage
      finish(trace, {
        content: [{ type: 'text', text: clip(resultText(output)) }],
        ...(usage === undefined ? {} : { meta: { usage } }),
      })
      runs.delete(runId)
    },

    handleLLMError(error, runId) {
      const trace = runs.get(runId)
      if (trace === undefined) return
      closeError(trace, error)
      runs.delete(runId)
    },
  }

  return {
    enabled,
    callbacks: enabled ? [handler] : [],
    begin,
    finish,
    currentNode: () => nodes.at(-1),
  }
}
