import { z } from 'zod'
import type { McpModelDef, McpOperation } from '../types.js'
import {
  buildWhereSchema,
  buildWhereUniqueSchema,
  buildOrderBySchema,
} from './schema-generator.js'

const anyObj = z.record(z.string(), z.unknown())
const dataObj = z.record(z.string(), z.unknown())

const ARG_STRUCT_SCHEMAS: Partial<Record<McpOperation, z.ZodTypeAny>> = {
  findUnique: z.object({ where: anyObj }).passthrough(),
  findFirst:  z.object({ where: anyObj.optional() }).passthrough(),
  findMany:   z.object({
    where:  anyObj.optional(),
    skip:   z.number().int().nonnegative().optional(),
    take:   z.number().int().optional(),
    cursor: anyObj.optional(),
  }).passthrough(),
  create:     z.object({ data: dataObj }).passthrough(),
  createMany: z.object({ data: z.array(dataObj) }).passthrough(),
  update:     z.object({ where: anyObj, data: dataObj }).passthrough(),
  updateMany: z.object({ where: anyObj.optional(), data: dataObj }).passthrough(),
  upsert:     z.object({ where: anyObj, create: dataObj, update: dataObj }).passthrough(),
  delete:     z.object({ where: anyObj }).passthrough(),
  deleteMany: z.object({ where: anyObj.optional() }).passthrough(),
  count:      z.object({ where: anyObj.optional() }).passthrough(),
}

type ZodIssue = { message: string; path: Array<string | number> }

type ModelSchema = { safeParse: (v: unknown) => { success: boolean; error?: { issues: ZodIssue[] } } }

function formatIssues(issues: ZodIssue[], prefix?: string): string[] {
  return issues.map((i) => {
    const path = i.path.length > 0 ? i.path.join('.') : undefined
    const location = [prefix, path].filter(Boolean).join('.')
    return location ? `${location}: ${i.message}` : i.message
  })
}

function validateData(schema: ModelSchema, data: unknown, prefix: string, errors: string[]): void {
  const result = schema.safeParse(data)
  if (!result.success && result.error) {
    errors.push(...formatIssues(result.error.issues as ZodIssue[], prefix))
  }
}

export type ZodFactory = {
  makeModelSchema: (model: string, opts?: { optionality: string }) => ModelSchema
}

export type ValidationResult = { valid: true } | { valid: false; errors: string[] }

export function validateOperation(
  models: McpModelDef[],
  model: string,
  operation: string,
  args: Record<string, unknown>,
  zodFactory: ZodFactory,
  requireWhereForBulk?: boolean,
): ValidationResult {
  const errors: string[] = []

  const modelDef = models.find((m) => m.name === model)
  if (!modelDef) {
    return { valid: false, errors: [`Unknown model "${model}". Available: ${models.map((m) => m.name).join(', ')}`] }
  }

  if (!modelDef.operations.includes(operation as McpOperation)) {
    return { valid: false, errors: [`Operation "${operation}" not available on "${model}". Available: ${modelDef.operations.join(', ')}`] }
  }

  if (requireWhereForBulk && (operation === 'deleteMany' || operation === 'updateMany')) {
    const where = args.where
    const isEmpty = !where || (typeof where === 'object' && !Array.isArray(where) && Object.keys(where as object).length === 0)
    if (isEmpty) {
      errors.push(`"where" must not be absent or empty for "${operation}" — set requireWhereForBulk: false to allow bulk operations without a filter`)
    }
  }

  // Structural shape validation (correct keys, primitive types)
  const structSchema = ARG_STRUCT_SCHEMAS[operation as McpOperation]
  if (structSchema) {
    const structResult = structSchema.safeParse(args)
    if (!structResult.success) {
      errors.push(...formatIssues(structResult.error.issues as ZodIssue[]))
    }
  }

  const { fields } = modelDef

  // Field-level where validation
  switch (operation as McpOperation) {
    case 'findUnique':
    case 'update':
    case 'upsert':
    case 'delete':
      if ('where' in args && args.where !== undefined) {
        validateData(buildWhereUniqueSchema(model, fields) as ModelSchema, args.where, 'where', errors)
      }
      break
    case 'findFirst':
    case 'findMany':
    case 'updateMany':
    case 'deleteMany':
    case 'count':
      if ('where' in args && args.where !== undefined) {
        validateData(buildWhereSchema(model, fields) as ModelSchema, args.where, 'where', errors)
      }
      break
  }

  // Field-level orderBy validation (findFirst / findMany)
  if ((operation === 'findFirst' || operation === 'findMany') && 'orderBy' in args && args.orderBy !== undefined) {
    validateData(buildOrderBySchema(model, fields) as ModelSchema, args.orderBy, 'orderBy', errors)
  }

  // Field-level cursor validation (findFirst / findMany)
  if ((operation === 'findFirst' || operation === 'findMany') && 'cursor' in args && args.cursor !== undefined) {
    validateData(buildWhereUniqueSchema(model, fields) as ModelSchema, args.cursor, 'cursor', errors)
  }

  // Field-level data validation
  try {
    switch (operation as McpOperation) {
      case 'create':
        if ('data' in args) {
          validateData(zodFactory.makeModelSchema(model, { optionality: 'defaults' }), args.data, 'data', errors)
        }
        break
      case 'createMany':
        if (Array.isArray(args.data)) {
          const schema = zodFactory.makeModelSchema(model, { optionality: 'defaults' })
          args.data.forEach((item: unknown, i: number) => validateData(schema, item, `data[${i}]`, errors))
        }
        break
      case 'update':
      case 'updateMany':
        if ('data' in args) {
          validateData(zodFactory.makeModelSchema(model, { optionality: 'all' }), args.data, 'data', errors)
        }
        break
      case 'upsert':
        if ('create' in args) {
          validateData(zodFactory.makeModelSchema(model, { optionality: 'defaults' }), args.create, 'create', errors)
        }
        if ('update' in args) {
          validateData(zodFactory.makeModelSchema(model, { optionality: 'all' }), args.update, 'update', errors)
        }
        break
    }
  } catch {
    // makeModelSchema may not support all model names at type level — skip
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors }
}
