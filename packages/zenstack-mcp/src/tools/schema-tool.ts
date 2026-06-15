import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpModelDef } from '../types.js'

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
}

export function registerSchemaTool(server: McpServer, models: McpModelDef[]): void {
  server.registerTool('schema', {
    description:
      'Returns exposed models with their fields and available operations, plus operation documentation with examples. ' +
      'Call this first to understand what data you can query and how to structure arguments. ' +
      'Pass a model name to retrieve schema for a single model only.',
    inputSchema: {
      model: z.string().optional().describe('Filter to a single model by name (PascalCase). Omit to return all models.'),
    },
  }, async ({ model }) => {
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

    return {
      content: [{ type: 'text', text: JSON.stringify({ models: filtered, operations: OPERATION_DOCS }, null, 2) }],
    }
  })
}
