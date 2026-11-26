/**
 * A LangChain chat model backed by the DSH `llm` service.
 *
 * It lets a LangGraph node use the deployment's own model route, and it supports the
 * tool-calling protocol LangGraph's prebuilt agents expect: `bindTools` records the
 * LangChain tools, `_generate` passes their JSON schemas to DSH, and tool calls come
 * back as an `AIMessage` with `tool_calls`.
 * @module dsh-langgraph/chat-model
 */

import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'

/** Text of one LangChain message's content blocks. */
function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => (typeof part === 'string' ? part : part?.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
}

/**
 * Convert one LangChain message into a DSH request message.
 * @param {object} message - LangChain BaseMessage.
 * @param {{ provider: string, model: string }} route - route used for assistant provenance.
 * @returns {{ role: string, content: object[], source?: object, toolCallId?: string } | undefined}
 */
function toRequestMessage(message, route) {
  const text = textOf(message)
  const type = message?.getType?.() ?? message?._getType?.()
  if (type === 'human') return { role: 'user', content: [{ type: 'text', text }] }
  if (type === 'ai') {
    const content = [{ type: 'text', text }]
    for (const call of message.tool_calls ?? []) {
      content.push({ type: 'tool-call', id: call.id ?? `call_${content.length}`, name: call.name, arguments: JSON.stringify(call.args ?? {}) })
    }
    return { role: 'assistant', content, source: { kind: 'model', provider: route.provider, model: route.model } }
  }
  if (type === 'tool') {
    const callId = message.tool_call_id ?? message.additional_kwargs?.tool_call_id
    return { role: 'tool', content: [{ type: 'text', text }], source: { kind: 'tool', callId }, toolCallId: callId }
  }
  return undefined
}

/** The LangChain tool schema a DSH tool exposes to the model. */
function toolSchema(tool) {
  return {
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.dshParameters ?? { type: 'object', properties: {}, additionalProperties: false },
  }
}

/** A chat model over one DSH route, bound to one run's cancellation and session. */
export class DshChatModel extends BaseChatModel {
  /**
   * @param {{ stream: Function, route: { provider: string, model: string, reasoningEffort?: string }, sessionId?: string, signal?: AbortSignal, tools?: object[] }} fields
   */
  constructor(fields) {
    super({})
    this.streamFn = fields.stream
    this.route = fields.route
    this.sessionId = fields.sessionId
    this.signal = fields.signal
    this.tools = fields.tools ?? []
  }

  /** @returns {string} provider family name shown by LangChain. */
  _llmType() {
    return 'dsh'
  }

  /**
   * Record tools for the next call; LangGraph's prebuilt agents call this.
   * @param {object[]} tools - LangChain tools.
   * @returns {DshChatModel} a model bound to these tools.
   */
  bindTools(tools) {
    return new DshChatModel({
      stream: this.streamFn,
      route: this.route,
      sessionId: this.sessionId,
      signal: this.signal,
      tools: [...this.tools, ...tools],
    })
  }

  /**
   * One generation against the DSH model route.
   * @param {object[]} messages - LangChain messages.
   * @returns {Promise<{ generations: object[] }>} LangChain chat result.
   */
  async _generate(messages) {
    const system = messages
      .filter(message => (message?.getType?.() ?? message?._getType?.()) === 'system')
      .map(textOf)
      .filter(Boolean)
      .join('\n\n')
    const request = messages
      .filter(message => (message?.getType?.() ?? message?._getType?.()) !== 'system')
      .map(message => toRequestMessage(message, this.route))
      .filter(Boolean)
    let text = ''
    let usage
    const calls = new Map()
    let finish
    for await (const chunk of this.streamFn({
      provider: this.route.provider,
      model: this.route.model,
      ...(this.route.reasoningEffort === undefined ? {} : { reasoningEffort: this.route.reasoningEffort }),
      messages: request,
      ...(system === '' ? {} : { system }),
      ...(this.tools.length === 0 ? {} : { tools: this.tools.map(toolSchema) }),
      ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
      signal: this.signal,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'tool-call-delta') {
        const entry = calls.get(chunk.id) ?? { id: chunk.id, name: '', arguments: '' }
        if (chunk.name !== undefined) entry.name = chunk.name
        entry.arguments += chunk.argumentsDelta
        calls.set(chunk.id, entry)
      } else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
        const block = chunk.block
        const previous = calls.get(block.id)
        calls.set(block.id, {
          id: block.id,
          name: block.name ?? previous?.name ?? '',
          arguments: block.arguments ?? previous?.arguments ?? '',
        })
      } else if (chunk.type === 'finish') finish = chunk.reason
    }
    if (finish?.kind === 'error') throw new Error(`model call failed: ${finish.failure.message}`)
    const toolCalls = [...calls.values()].filter(entry => typeof entry.name === 'string' && entry.name !== '').map(entry => {
      let args = {}
      try {
        args = entry.arguments === '' ? {} : JSON.parse(entry.arguments)
      } catch {
        args = {}
      }
      return { id: entry.id, name: entry.name, args }
    })
    const message = new AIMessage({ content: text, tool_calls: toolCalls })
    return {
      generations: [{ text, message }],
      ...(usage === undefined ? {} : { llmOutput: { tokenUsage: usage } }),
    }
  }
}

/** Re-exported so graph modules can build message arrays without their own dependency. */
export { AIMessage, HumanMessage, SystemMessage, ToolMessage }
