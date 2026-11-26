/**
 * DSH tools as LangChain tools.
 *
 * LangGraph's prebuilt agents only accept tools that are Runnables, so each DSH tool is
 * wrapped with `tool()` and a zod schema converted from the DSH tool's own JSON schema.
 * The original JSON schema stays on the wrapper as `dshParameters`, which is what the
 * chat model sends to the provider.
 * @module dsh-langgraph/tools
 */

import { z } from 'zod'
import { tool } from '@langchain/core/tools'

/**
 * Convert the JSON-schema subset DSH tool parameters use into a zod schema.
 * @param {object} schema - JSON schema node.
 * @returns {import('zod').ZodTypeAny} the zod schema.
 */
export function zodFromJsonSchema(schema) {
  if (schema === null || typeof schema !== 'object') return z.any()
  const type = schema.type
  if (type === 'string') return Array.isArray(schema.enum) ? z.enum(schema.enum) : z.string()
  if (type === 'number') return z.number()
  if (type === 'integer') return z.number().int()
  if (type === 'boolean') return z.boolean()
  if (type === 'null') return z.null()
  if (type === 'array') return z.array(zodFromJsonSchema(schema.items ?? {}))
  const properties = schema.properties
  if (type === 'object' || (properties !== undefined && typeof properties === 'object')) {
    const shape = {}
    const required = new Set(Array.isArray(schema.required) ? schema.required : [])
    for (const [key, value] of Object.entries(properties ?? {})) {
      const inner = zodFromJsonSchema(value)
      shape[key] = required.has(key) ? inner : inner.optional()
    }
    const object = z.object(shape)
    return schema.additionalProperties === true ? object.passthrough() : object
  }
  return z.any()
}

/**
 * Wrap one DSH tool definition as a LangChain tool.
 * @param {{ name: string, description: string, parameters: object }} definition - DSH tool definition.
 * @param {(name: string, args: object) => Promise<string>} callTool - runs the DSH tool.
 * @returns {object} a LangChain tool carrying `dshParameters`.
 */
export function langchainTool(definition, callTool) {
  const wrapped = tool(async input => callTool(definition.name, input ?? {}), {
    name: definition.name,
    description: definition.description,
    schema: zodFromJsonSchema(definition.parameters),
  })
  wrapped.dshParameters = definition.parameters
  return wrapped
}
