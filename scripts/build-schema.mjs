/**
 * Build the JSON Schema for the GraphSpec IR.
 *
 * The validator in `compose/schema.js` is the contract; this file expresses the
 * same closed vocabulary as JSON Schema so editors and other tools can read a
 * spec before it is ever composed. Every vocabulary is imported from
 * `compose/constants.js`, so the two cannot drift apart; `test/schema.test.js`
 * fails if the committed file no longer matches this generator.
 *
 * The schema is a convenience, not the authority: `compose` still checks
 * cross-field rules (unique node ids, references between edges and nodes) that
 * JSON Schema cannot express.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  END,
  GUARD_OPS,
  IR_VERSION,
  LIMITS,
  MAP_BODY_FIELDS,
  MAP_BODY_KINDS,
  NODE_FIELDS,
  NODE_KINDS,
  REDUCERS,
  START,
  STATE_TYPES,
  TRANSFORMS,
} from '../compose/constants.js'

const here = dirname(fileURLToPath(import.meta.url))

/** Where the generated schema lives. */
export const SCHEMA_PATH = resolve(here, '../schema/graphspec.schema.json')

/** Stable `$id` so a spec can point at one URL from anywhere. */
export const SCHEMA_ID = 'https://raw.githubusercontent.com/lznnnnn1998/DSH-LangGraph/main/schema/graphspec.schema.json'

/** Fields a node of each kind must carry. */
const NODE_REQUIRED = {
  tool: ['tool', 'args', 'out'],
  model: ['prompt', 'out'],
  agent: ['prompt', 'tools', 'out'],
  gate: ['question', 'out'],
  map: ['over', 'body'],
  set: ['values'],
  subagent: ['prompt', 'out'],
}

/** The property schema of each node field, shared by nodes and map bodies. */
function fieldSchema(field, kind) {
  switch (field) {
    case 'id':
      return { $ref: '#/$defs/nodeId' }
    case 'do':
      return { const: kind }
    case 'tool':
      return { type: 'string', minLength: 1, pattern: '\\S' }
    case 'args':
      return {
        type: 'object',
        description: 'Passed to the tool unchanged. A whole argument may be { "$state": "<field>" }.',
      }
    case 'out':
      return { $ref: '#/$defs/out' }
    case 'prompt':
      return { $ref: '#/$defs/prompt' }
    case 'system':
      return { type: 'string', minLength: 1, pattern: '\\S' }
    case 'schema':
      return { type: 'object', description: 'A JSON Schema for the model or subagent result.' }
    case 'tools':
      return {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        uniqueItems: true,
        description: 'Tool names the agent may call; each must be visible to the calling session.',
      }
    case 'question':
      return { type: 'string', minLength: 1, pattern: '\\S' }
    case 'options':
      return {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1, pattern: '\\S' },
        uniqueItems: true,
        description: 'Labels shown to the human. The resume value is the answer itself, not an option index.',
      }
    case 'over':
      return { type: 'string', pattern: '^[^.]+$', description: 'A top-level string[] or number[] state field.' }
    case 'body':
      return {
        oneOf: MAP_BODY_KINDS.map(kindName => ({ $ref: `#/$defs/mapBody_${kindName}` })),
        description: 'One node, run once per item. A gate or a nested map is not allowed.',
      }
    case 'maxItems':
      return { type: 'integer', minimum: 1, maximum: LIMITS.maxMapItems }
    case 'maxConcurrency':
      return { type: 'integer', minimum: 1, maximum: LIMITS.maxMapConcurrency }
    case 'values':
      return { type: 'object', description: 'State fields written by this node; a value may be a state reference.' }
    default:
      return true
  }
}

/**
 * One `additionalProperties: false` node object for a kind.
 * @param {string} kind - node kind.
 * @param {readonly string[]} fields - fields the kind may carry.
 * @param {string[]} required - fields the kind must carry.
 * @param {{ idRequired?: boolean }} [options] - a map body's `id` is optional.
 */
function nodeSchema(kind, fields, required, options = {}) {
  const properties = {}
  for (const field of fields) properties[field] = fieldSchema(field, kind)
  return {
    type: 'object',
    additionalProperties: false,
    required: [...(options.idRequired === false ? [] : ['id']), 'do', ...required],
    properties: {
      id: properties.id,
      do: properties.do,
      ...Object.fromEntries(Object.entries(properties).filter(([field]) => field !== 'id' && field !== 'do')),
    },
  }
}

/** A state field: `type` and `default` must agree, and a reducer must fit. */
function stateFieldSchema() {
  const whenType = (type, then) => ({
    if: { properties: { type: { const: type } }, required: ['type'] },
    then: { properties: { default: then } },
  })
  return {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'default'],
    properties: {
      type: { enum: [...STATE_TYPES] },
      default: {},
      reducer: { enum: [...REDUCERS], description: 'How concurrent or repeated writes combine. Defaults to "replace".' },
    },
    allOf: [
      whenType('string', { type: 'string' }),
      whenType('number', { type: 'number' }),
      whenType('boolean', { type: 'boolean' }),
      whenType('string[]', { type: 'array', items: { type: 'string' } }),
      whenType('number[]', { type: 'array', items: { type: 'number' } }),
      {
        if: { properties: { reducer: { enum: ['add', 'max', 'min'] } }, required: ['reducer'] },
        then: { properties: { type: { const: 'number' } } },
      },
      {
        if: { properties: { reducer: { const: 'append' } }, required: ['reducer'] },
        then: {
          anyOf: [
            { properties: { type: { enum: ['string[]', 'number[]'] } }, required: ['type'] },
            { properties: { type: { const: 'json' }, default: { type: 'array' } }, required: ['type', 'default'] },
          ],
        },
      },
      {
        if: { properties: { reducer: { const: 'merge' } }, required: ['reducer'] },
        then: {
          properties: {
            type: { const: 'json' },
            default: { type: 'object' },
          },
        },
      },
    ],
  }
}

/** The guard grammar: boolean, or one operator applied to operands or guards. */
function guardSchema() {
  const whenOp = (ops, then) => ({
    if: { properties: { op: { enum: ops } }, required: ['op'] },
    then,
  })
  return {
    oneOf: [
      { type: 'boolean' },
      {
        type: 'object',
        additionalProperties: false,
        required: ['op', 'args'],
        properties: {
          op: { enum: [...GUARD_OPS] },
          args: { type: 'array' },
        },
        allOf: [
          whenOp(['and', 'or'], {
            properties: { args: { minItems: 1, items: { $ref: '#/$defs/guard' } } },
          }),
          whenOp(['not'], {
            properties: { args: { minItems: 1, maxItems: 1, items: { $ref: '#/$defs/guard' } } },
          }),
          whenOp(['exists'], {
            properties: { args: { minItems: 1, maxItems: 1, items: { $ref: '#/$defs/operand' } } },
          }),
          whenOp(['eq', 'ne', 'in', 'gt', 'gte', 'lt', 'lte'], {
            properties: { args: { minItems: 2, maxItems: 2, items: { $ref: '#/$defs/operand' } } },
          }),
        ],
      },
    ],
  }
}

/**
 * Build the schema object.
 * @returns {object} a draft 2020-12 JSON Schema.
 */
export function buildSchema() {
  const defs = {
    nodeId: {
      type: 'string',
      pattern: '^\\S+$',
      not: { enum: [START, END, '__start__', '__end__', '__interrupt__'] },
      description: `A node id. "${START}" and "${END}" are edges, not nodes.`,
    },
    stateRef: {
      type: 'object',
      additionalProperties: false,
      required: ['$state'],
      properties: {
        $state: { type: 'string', minLength: 1, description: 'A state field, or "field.key" for a json field.' },
      },
      description: 'A whole value read from the graph state.',
    },
    prompt: {
      type: 'array',
      minItems: 1,
      description: 'Text parts and state references, joined in order.',
      items: { anyOf: [{ type: 'string' }, { $ref: '#/$defs/stateRef' }] },
    },
    out: {
      type: 'object',
      propertyNames: { pattern: '^[^\\s.]+$' },
      additionalProperties: { enum: [...TRANSFORMS] },
      description: 'State fields this node writes, and the form each result takes.',
    },
    operand: {
      anyOf: [
        { $ref: '#/$defs/stateRef' },
        { type: ['string', 'number', 'boolean', 'null'] },
        { type: 'array' },
        { type: 'object', additionalProperties: true, not: { required: ['op'] } },
      ],
    },
    guard: guardSchema(),
    stateField: stateFieldSchema(),
    edge: {
      type: 'object',
      additionalProperties: false,
      required: ['from', 'to'],
      properties: {
        from: { type: 'string', minLength: 1, not: { const: END } },
        to: { type: 'string', minLength: 1, not: { const: START } },
        when: { $ref: '#/$defs/guard' },
      },
      allOf: [
        {
          if: { properties: { from: { const: START } }, required: ['from'] },
          then: { not: { required: ['when'] }, description: 'Edges from START are unconditional.' },
        },
      ],
    },
  }

  for (const kind of NODE_KINDS) {
    defs[`node_${kind}`] = nodeSchema(kind, NODE_FIELDS[kind], NODE_REQUIRED[kind])
  }
  for (const kind of MAP_BODY_KINDS) {
    defs[`mapBody_${kind}`] = nodeSchema(kind, MAP_BODY_FIELDS[kind], NODE_REQUIRED[kind], { idRequired: false })
  }

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: SCHEMA_ID,
    title: 'dsh-langgraph GraphSpec',
    description: 'The JSON intermediate representation a dsh-langgraph graph is composed from. The compiler is deterministic; no model translates it.',
    type: 'object',
    additionalProperties: false,
    required: ['ir', 'state', 'nodes', 'edges'],
    properties: {
      $schema: {
        type: 'string',
        description: `Optional. Points an editor at this schema; the compiler ignores it. Use ${SCHEMA_ID}.`,
      },
      ir: { const: IR_VERSION, description: 'IR version this spec is written for.' },
      name: { type: 'string', minLength: 1, pattern: '\\S' },
      description: { type: 'string', minLength: 1, pattern: '\\S' },
      state: {
        type: 'object',
        minProperties: 1,
        maxProperties: LIMITS.stateFields,
        propertyNames: { pattern: '^(?!__(interrupt|start|end)$)[^\\s.]+$' },
        additionalProperties: { $ref: '#/$defs/stateField' },
        description: 'The ledger every node reads and writes.',
      },
      nodes: {
        type: 'array',
        minItems: 1,
        maxItems: LIMITS.nodes,
        items: {
          oneOf: NODE_KINDS.map(kind => ({ $ref: `#/$defs/node_${kind}` })),
        },
      },
      edges: {
        type: 'array',
        minItems: 1,
        maxItems: LIMITS.edges,
        items: { $ref: '#/$defs/edge' },
        description: `Handoffs between nodes, including from "${START}" and to "${END}".`,
      },
      output: {
        type: 'array',
        uniqueItems: true,
        items: { type: 'string', minLength: 1 },
        description: 'State fields a run returns.',
      },
      maxSteps: { type: 'integer', minimum: 1, maximum: LIMITS.maxSteps },
    },
    $defs: defs,
  }
}

/**
 * The committed file's exact contents.
 * @returns {string} pretty JSON with a trailing newline.
 */
export function schemaText() {
  return `${JSON.stringify(buildSchema(), null, 2)}\n`
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await mkdir(dirname(SCHEMA_PATH), { recursive: true })
  await writeFile(SCHEMA_PATH, schemaText())
  console.log(`wrote ${SCHEMA_PATH}`)
}
