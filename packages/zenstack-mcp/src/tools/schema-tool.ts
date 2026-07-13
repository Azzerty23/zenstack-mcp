import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type {
  McpEnumDef,
  McpModelDef,
  McpOperation,
  McpProcedureDef,
  McpTypeDef,
} from '../types.js'
import {
  getComponentDocument,
  getOperationDocument,
  knownDefinitions,
  sliceDocument,
  toCompactJSONSchema,
} from './json-schema.js'
import { renderSchema } from './schema-renderer.js'
import { OPERATION_SCHEMA_METHOD, type QuerySchemaFactory } from './validate.js'

/**
 * Cap on the `depth` arg for self-contained documents: each extra level
 * multiplies the document size (relation cycles re-expand every model's
 * filters), so deep bounded docs get huge — beyond this, the default
 * progressive (`$ref`-based) document is strictly better.
 */
const MAX_DOC_DEPTH = 5

const OPERATION_DOCS: Record<string, { description: string; example: unknown }> = {
  findMany: {
    description: 'Retrieve multiple records. Supports filtering (where), sorting (orderBy), pagination (skip/take), and field selection (select/include).',
    example: { where: { published: true }, orderBy: { createdAt: 'desc' }, take: 10, skip: 0 },
  },
  findUnique: {
    description: 'Retrieve a single record by unique field (e.g. id). Returns null if not found.',
    example: { where: { id: 'clxyz123' } },
  },
  findFirst: {
    description: 'Retrieve the first record matching the criteria. Returns null if not found.',
    example: { where: { email: { contains: '@example.com' } }, orderBy: { createdAt: 'desc' } },
  },
  create: {
    description: 'Create a new record. Provide field values in data.',
    example: { data: { title: 'Hello world', authorId: 'clxyz123' } },
  },
  createMany: {
    description: 'Create multiple records at once. Returns the count of created records.',
    example: { data: [{ title: 'Post 1' }, { title: 'Post 2' }] },
  },
  update: {
    description: 'Update an existing record identified by a unique field. Provide updated fields in data.',
    example: { where: { id: 'clxyz123' }, data: { title: 'Updated title' } },
  },
  updateMany: {
    description: 'Update all records matching the criteria. Returns the count of updated records.',
    example: { where: { published: false }, data: { published: true } },
  },
  upsert: {
    description: 'Update a record if it exists, create it otherwise. Requires where, create, and update.',
    example: { where: { email: 'alice@example.com' }, create: { email: 'alice@example.com', name: 'Alice' }, update: { name: 'Alice' } },
  },
  delete: {
    description: 'Delete a single record by unique field.',
    example: { where: { id: 'clxyz123' } },
  },
  deleteMany: {
    description: 'Delete all records matching the criteria. Returns the count of deleted records.',
    example: { where: { published: false } },
  },
  count: {
    description: 'Count records matching the criteria.',
    example: { where: { published: true } },
  },
  findUniqueOrThrow: {
    description: 'Like findUnique, but throws an error instead of returning null when no record is found.',
    example: { where: { id: 'clxyz123' } },
  },
  findFirstOrThrow: {
    description: 'Like findFirst, but throws an error instead of returning null when no record is found.',
    example: { where: { email: { contains: '@example.com' } } },
  },
  createManyAndReturn: {
    description: 'Like createMany, but returns the created records instead of just a count.',
    example: { data: [{ title: 'Post 1' }, { title: 'Post 2' }] },
  },
  updateManyAndReturn: {
    description: 'Like updateMany, but returns the updated records instead of just a count.',
    example: { where: { published: false }, data: { published: true } },
  },
  exists: {
    description: 'Returns true if at least one record matches the criteria, false otherwise.',
    example: { where: { email: 'alice@example.com' } },
  },
  aggregate: {
    description: 'Compute aggregations (_count, _avg, _sum, _min, _max) over records matching the criteria.',
    example: { where: { published: true }, _count: true, _avg: { views: true } },
  },
  groupBy: {
    description: 'Group records by one or more fields and aggregate within each group. Requires "by"; filter groups with "having".',
    example: { by: ['authorId'], _count: { _all: true }, having: { authorId: { _count: { gt: 1 } } } },
  },
}

/** Compact one-line-per-operation reference appended to the schema document. */
function renderOperationDocs(): string {
  const lines = Object.entries(OPERATION_DOCS).map(
    ([op, d]) => `  ${op}: ${d.description} e.g. ${JSON.stringify(d.example)}`,
  )
  return `// Operation arguments (for the \`execute\` tool):\n${lines.join('\n')}`
}

export function registerSchemaTool(
  server: McpServer,
  models: McpModelDef[],
  procedures: McpProcedureDef[] = [],
  factory?: QuerySchemaFactory,
  relationDepth?: number,
  enums: McpEnumDef[] = [],
  typeDefs: McpTypeDef[] = [],
): void {
  server.registerTool('schema', {
    description:
      'Returns the exposed schema as concise ZModel/Prisma-style text: enums, `type` declarations, ' +
      'model blocks with their fields and attributes ' +
      '(queried via the `execute` tool) and any custom procedures (invoked via the `procedure` tool), ' +
      'followed by a reference of operation arguments with examples. ' +
      'Call this first to understand what data you can query, what procedures you can invoke, and how to structure arguments. ' +
      'Pass a model name to retrieve schema for a single model only. ' +
      'Pass both model and operation to get the exact JSON Schema of the `execute` args for that operation: ' +
      'shared shapes are named `$defs` referenced by `$ref`; definitions that did not fit the response are listed in `pendingDefinitions` and can be fetched individually via `component`.',
    inputSchema: {
      model: z.string().optional().describe('Filter to a single model by name (PascalCase). Omit to return all models. Does not affect the returned procedures.'),
      operation: z.string().optional().describe('With model: return the exact JSON Schema of the `execute` args for this operation (e.g. "findMany").'),
      component: z.string().optional().describe('Fetch one named schema definition (a `$defs` name seen in a `$ref` or `pendingDefinitions` of a previous response, e.g. "UserWhereInput"). Takes precedence over the other arguments.'),
      depth: z.number().int().min(0).optional().describe(`With model and operation: return a SELF-CONTAINED schema with relations expanded only to this depth (max ${MAX_DOC_DEPTH}), instead of the default \`$ref\`-based document. \`execute\` accepts and validates deeper nesting than what is documented. Each extra level multiplies the response size.`),
    },
  }, async ({ model, operation, component, depth }) => {
    const validationDepth = relationDepth !== undefined && Number.isFinite(relationDepth)
      ? relationDepth
      : undefined

    if (component) {
      if (!factory) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Operation schemas are not available on this server.' }) }], isError: true }
      }
      const sliced = getComponentDocument(factory, models, component, validationDepth)
      if (!sliced) {
        const known = knownDefinitions(factory, validationDepth)
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: `Unknown definition "${component}". Use a $defs name from a previous schema response.`,
              ...(known.length > 0 ? { knownDefinitions: known } : {}),
            }),
          }],
          isError: true,
        }
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            component,
            schema: sliced.schema,
            ...(sliced.pending.length > 0
              ? { pendingDefinitions: sliced.pending, hint: 'Fetch any pending definition with {"component": "<name>"}.' }
              : {}),
          }),
        }],
      }
    }
    const filtered = model
      ? models.filter((m) => m.name === model)
      : models

    if (model && filtered.length === 0) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: `Unknown model "${model}". Available: ${models.map((m) => m.name).join(', ')}`,
          }),
        }],
        isError: true,
      }
    }

    if (operation) {
      const modelDef = model ? filtered[0] : undefined
      const method = OPERATION_SCHEMA_METHOD[operation as McpOperation]
      const error = !model
        ? '"operation" requires "model" to be set as well.'
        : !method
          ? `Unknown operation "${operation}". Available: ${Object.keys(OPERATION_SCHEMA_METHOD).join(', ')}`
          : !modelDef!.operations.includes(operation as McpOperation)
            ? `Operation "${operation}" not available on "${model}". Available: ${modelDef!.operations.join(', ')}`
            : !factory
              ? 'Operation schemas are not available on this server.'
              : undefined
      if (error) {
        return { content: [{ type: 'text', text: JSON.stringify({ error }) }], isError: true }
      }

      try {
        if (depth !== undefined) {
          // Self-contained document, bounded: capped by the validation depth
          // (documenting deeper than `execute` validates would advertise args
          // it rejects), then by MAX_DOC_DEPTH (size grows multiplicatively).
          const docDepth = Math.min(depth, validationDepth ?? MAX_DOC_DEPTH)
          const schema = factory![method](model!, { relationDepth: docDepth })
          const jsonSchema = toCompactJSONSchema(schema, factory!)
          return {
            content: [{ type: 'text', text: JSON.stringify({ model, operation, relationDepth: docDepth, argsSchema: jsonSchema }) }],
          }
        }

        // Default: progressive document at the validation depth (unlimited
        // unless the server bounds it) — small root plus budgeted `$defs`,
        // the rest fetchable one by one via `component`.
        const doc = getOperationDocument(factory!, method, model!, validationDepth)
        const { schema: argsSchema, pending } = sliceDocument(doc)
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              model,
              operation,
              relationDepth: validationDepth ?? 'unlimited',
              argsSchema,
              ...(pending.length > 0
                ? { pendingDefinitions: pending, hint: 'Fetch any pending definition with {"component": "<name>"}.' }
                : {}),
            }),
          }],
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Cannot build schema for "${operation}" on "${model}": ${message}` }) }],
          isError: true,
        }
      }
    }

    const text = `${renderSchema(filtered, procedures, enums, typeDefs)}\n\n${renderOperationDocs()}`
    return {
      content: [{ type: 'text', text }],
    }
  })
}
