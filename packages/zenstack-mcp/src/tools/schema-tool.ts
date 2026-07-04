import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpModelDef, McpOperation, McpProcedureDef } from '../types.js'
import { renderSchema } from './schema-renderer.js'
import { OPERATION_SCHEMA_METHOD, type QuerySchemaFactory } from './validate.js'

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
): void {
  server.registerTool('schema', {
    description:
      'Returns the exposed schema as concise ZModel/Prisma-style text: model blocks with their fields ' +
      '(queried via the `execute` tool) and any custom procedures (invoked via the `procedure` tool), ' +
      'followed by a reference of operation arguments with examples. ' +
      'Call this first to understand what data you can query, what procedures you can invoke, and how to structure arguments. ' +
      'Pass a model name to retrieve schema for a single model only. ' +
      'Pass both model and operation to get the exact JSON Schema of the `execute` args for that operation.',
    inputSchema: {
      model: z.string().optional().describe('Filter to a single model by name (PascalCase). Omit to return all models. Does not affect the returned procedures.'),
      operation: z.string().optional().describe('With model: return the exact JSON Schema of the `execute` args for this operation (e.g. "findMany").'),
    },
  }, async ({ model, operation }) => {
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
        const opts = relationDepth !== undefined && Number.isFinite(relationDepth)
          ? { relationDepth }
          : undefined
        const schema = factory![method](model!, opts)
        // `unrepresentable: 'any'` maps JSON-Schema-less types (Date, custom
        // scalars like Decimal/Bytes) to `{}` instead of throwing.
        const jsonSchema = z.toJSONSchema(schema as unknown as z.ZodType, { io: 'input', unrepresentable: 'any' })
        return {
          content: [{ type: 'text', text: JSON.stringify({ model, operation, argsSchema: jsonSchema }) }],
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Cannot build schema for "${operation}" on "${model}": ${message}` }) }],
          isError: true,
        }
      }
    }

    const text = `${renderSchema(filtered, procedures)}\n\n${renderOperationDocs()}`
    return {
      content: [{ type: 'text', text }],
    }
  })
}
