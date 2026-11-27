/**
 * Node executors for the GraphSpec IR.
 *
 * Each executor receives the IR node and the current graph state and returns a
 * partial state update. The compiler wraps them with error annotation; this
 * module only runs the action and converts its result through the node's `out`
 * transforms.
 *
 * `agent` nodes use LangGraph's prebuilt ReAct agent over the calling session's
 * own tools, which is the IR's "open work" unit: the brief is prose, and the
 * compiler never inspects it.
 */

import { validateSchemaValue } from './schema.js'
import { messageText, parseJsonText, renderParts, resolveValue, transform } from './template.js'

/**
 * Build the executor for one spec. Agent nodes are compiled lazily on their
 * first run, so building a topology does not need the model service.
 * @param {object} api - `{ helpers, interrupt }` bound to one run.
 * @returns {{ run: (node: object, state: object) => Promise<object> | object }} the runner.
 */
export function createRunner(api) {
  const helpers = api.helpers
  const interrupt = api.interrupt
  const agents = new Map()

  function getAgent(node, key = node.id) {
    const cached = agents.get(key)
    if (cached !== undefined) return cached
    const promise = (async () => {
      const tools = node.tools.length === 0 ? [] : helpers.tools(node.tools)
      return await helpers.createReactAgent({ llm: helpers.chatModel(), tools })
    })()
    agents.set(key, promise)
    // A failed build (for example a model route that is not ready yet) should
    // not poison every later retry on the same thread.
    promise.catch(() => {
      if (agents.get(key) === promise) agents.delete(key)
    })
    return promise
  }

  function applyOut(node, base, parsed) {
    const patch = {}
    for (const [field, kind] of Object.entries(node.out ?? {})) {
      if (kind === 'json' && parsed !== undefined) patch[field] = parsed
      else if (kind === 'text' && parsed !== undefined && typeof parsed === 'string') patch[field] = parsed
      else patch[field] = transform(base, kind)
    }
    return patch
  }

  function runSet(node, state) {
    const patch = {}
    for (const [field, value] of Object.entries(node.values)) {
      patch[field] = resolveValue(value, state)
    }
    return patch
  }

  async function runTool(node, state) {
    const args = resolveValue(node.args, state)
    const text = await helpers.callTool(node.tool, args)
    return applyOut(node, text)
  }

  async function callModelWithSchema(node, prompt) {
    if (typeof helpers.callModel !== 'function') {
      throw new Error('model nodes need helpers.callModel, which this runtime did not provide')
    }
    const request = node.schema === undefined
      ? prompt
      : `${prompt}\n\nReply with a single JSON value only, matching this JSON Schema:\n${JSON.stringify(node.schema)}`
    const result = await helpers.callModel(request, node.system === undefined ? {} : { system: node.system })
    const text = typeof result === 'string' ? result : String(result?.text ?? '')
    let parsed
    if (node.schema !== undefined) {
      parsed = parseJsonText(text)
      const problems = validateSchemaValue(parsed, node.schema)
      if (problems.length > 0) {
        throw new Error(`model output does not match its schema: ${problems.join('; ')}`)
      }
    }
    return { text, parsed }
  }

  async function runModel(node, state) {
    const prompt = renderParts(node.prompt, state)
    if (prompt.trim() === '') throw new Error('the model prompt rendered empty')
    const { text, parsed } = await callModelWithSchema(node, prompt)
    return applyOut(node, text, parsed)
  }

  async function callSubagent(node, prompt) {
    if (typeof helpers.subagent !== 'function') {
      throw new Error('subagent nodes need helpers.subagent, which this runtime did not provide')
    }
    const result = await helpers.subagent(prompt, node.schema === undefined ? {} : { schema: node.schema })
    if (result.stopReason !== 'completed') {
      throw new Error(`subagent stopped: ${result.stopReason}`)
    }
    let parsed = result.structured
    if (node.schema !== undefined) {
      if (parsed === undefined) parsed = parseJsonText(result.text)
      const problems = validateSchemaValue(parsed, node.schema)
      if (problems.length > 0) {
        throw new Error(`subagent output does not match its schema: ${problems.join('; ')}`)
      }
    }
    return { text: String(result.text ?? ''), parsed }
  }

  async function runSubagent(node, state) {
    const prompt = renderParts(node.prompt, state)
    if (prompt.trim() === '') throw new Error('the subagent brief rendered empty')
    const { text, parsed } = await callSubagent(node, prompt)
    return applyOut(node, text, parsed)
  }

  async function runAgent(node, state) {
    if (typeof helpers.createReactAgent !== 'function') {
      throw new Error('agent nodes need helpers.createReactAgent, which this runtime did not provide')
    }
    const brief = renderParts(node.prompt, state)
    if (brief.trim() === '') throw new Error('the agent brief rendered empty')
    const agent = await getAgent(node)
    const result = await agent.invoke({ messages: [['human', brief]] })
    const messages = result?.messages
    const text = Array.isArray(messages) && messages.length > 0
      ? messageText(messages[messages.length - 1])
      : ''
    if (text.trim() === '') throw new Error('the agent returned an empty answer')
    return applyOut(node, text)
  }

  async function runGate(node, state) {
    if (typeof interrupt !== 'function') {
      throw new Error('gate nodes need LangGraph interrupt, which this runtime did not provide')
    }
    const answer = interrupt({
      node: node.id,
      question: node.question,
      ...(node.options === undefined ? {} : { options: node.options }),
    })
    return applyOut(node, answer)
  }

  /**
   * Run one `map` item. The dispatcher has already resolved the body's args or
   * prompt, so this only calls the helper and applies `out`.
   * @param {object} body - a validated map body node.
   * @param {object} state - the Send payload (`args`/`prompt`, item index).
   * @param {string} mapId - the map node id, used to cache an agent body.
   */
  async function runMapBody(body, state, mapId) {
    if (state?.__mapEmpty === true) return {}
    switch (body.do) {
      case 'tool':
        return applyOut(body, await helpers.callTool(body.tool, state.args ?? {}))
      case 'model': {
        const prompt = typeof state.prompt === 'string' ? state.prompt : ''
        if (prompt.trim() === '') throw new Error('the model prompt rendered empty')
        const { text, parsed } = await callModelWithSchema(body, prompt)
        return applyOut(body, text, parsed)
      }
      case 'agent': {
        if (typeof helpers.createReactAgent !== 'function') {
          throw new Error('agent nodes need helpers.createReactAgent, which this runtime did not provide')
        }
        const brief = typeof state.prompt === 'string' ? state.prompt : ''
        if (brief.trim() === '') throw new Error('the agent brief rendered empty')
        const agent = await getAgent(body, mapId)
        const result = await agent.invoke({ messages: [['human', brief]] })
        const messages = result?.messages
        const text = Array.isArray(messages) && messages.length > 0
          ? messageText(messages[messages.length - 1])
          : ''
        if (text.trim() === '') throw new Error('the agent returned an empty answer')
        return applyOut(body, text)
      }
      case 'subagent': {
        const prompt = typeof state.prompt === 'string' ? state.prompt : ''
        if (prompt.trim() === '') throw new Error('the subagent brief rendered empty')
        const { text, parsed } = await callSubagent(body, prompt)
        return applyOut(body, text, parsed)
      }
      default:
        throw new Error(`unsupported map body kind "${body.do}"`)
    }
  }

  return {
    async run(node, state) {
      switch (node.do) {
        case 'set':
          return runSet(node, state)
        case 'tool':
          return await runTool(node, state)
        case 'model':
          return await runModel(node, state)
        case 'agent':
          return await runAgent(node, state)
        case 'gate':
          return await runGate(node, state)
        case 'subagent':
          return await runSubagent(node, state)
        default:
          throw new Error(`unsupported node kind "${node.do}"`)
      }
    },
    runMapBody,
  }
}
