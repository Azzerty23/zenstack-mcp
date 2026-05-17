import { z } from 'zod'
import type { McpModelDef, McpOperation } from '../types.js'

const whereObj = z.record(z.string(), z.unknown())
const dataObj = z.record(z.string(), z.unknown())
const orderByField = z.union([whereObj, z.array(whereObj)])

const ARG_STRUCT_SCHEMAS: Partial<Record<McpOperation, z.ZodTypeAny>> = {
  findUnique: z.object({ where: whereObj }).passthrough(),
  findFirst:  z.object({ where: whereObj.optional(), orderBy: orderByField.optional() }).passthrough(),
  findMany:   z.object({
    where:   whereObj.optional(),
    orderBy: orderByField.optional(),
    skip:    z.number().int().nonnegative().optional(),
    take:    z.number().int().optional(),
    cursor:  whereObj.optional(),
  }).passthrough(),
  create:     z.object({ data: dataObj }).passthrough(),
  createMany: z.object({ data: z.array(dataObj) }).passthrough(),
  update:     z.object({ where: whereObj, data: dataObj }).passthrough(),
  updateMany: z.object({ where: whereObj.optional(), data: dataObj }).passthrough(),
  upsert:     z.object({ where: whereObj, create: dataObj, update: dataObj }).passthrough(),
  delete:     z.object({ where: whereObj }).passthrough(),
  deleteMany: z.object({ where: whereObj.optional() }).passthrough(),
  count:      z.object({ where: whereObj.optional() }).passthrough(),
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
  zodFactory?: ZodFactory,
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

  const structSchema = ARG_STRUCT_SCHEMAS[operation as McpOperation]
  if (structSchema) {
    const structResult = structSchema.safeParse(args)
    if (!structResult.success) {
      errors.push(...formatIssues(structResult.error.issues as ZodIssue[]))
    }
  }

  if (zodFactory) {
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
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors }
}
