import { z, type ZodTypeAny } from 'zod'
import type { McpFieldDef } from '../types.js'

// Cache keyed by "<modelName>:<schemaType>" — schemas are static per deployment
const cache = new Map<string, ZodTypeAny>()

function cached(key: string, build: () => ZodTypeAny): ZodTypeAny {
  let schema = cache.get(key)
  if (!schema) {
    schema = build()
    cache.set(key, schema)
  }
  return schema
}

// ─── Base type mapping ────────────────────────────────────────────────────────

function fieldTypeToZod(type: string, isList: boolean, optional: boolean): ZodTypeAny {
  let base: ZodTypeAny
  switch (type) {
    case 'String':   base = z.string(); break
    case 'Int':      base = z.number().int(); break
    case 'Float':    base = z.number(); break
    case 'BigInt':   base = z.bigint(); break
    case 'Decimal':  base = z.union([z.string(), z.number()]); break
    case 'Boolean':  base = z.boolean(); break
    case 'DateTime': base = z.union([z.string(), z.date()]); break
    case 'Json':     base = z.any(); break
    case 'Bytes':    base = z.instanceof(Uint8Array); break
    default:         base = z.any()
  }
  if (isList) base = z.array(base)
  return optional ? base.optional() : base
}

// ─── Prisma-style filter schemas ─────────────────────────────────────────────

function createStringFilter(): ZodTypeAny {
  const str = z.string()
  return z.union([
    str,
    z.object({
      equals:     str.optional(),
      not:        z.union([str, z.lazy(() => createStringFilter())]).optional(),
      in:         z.array(str).optional(),
      notIn:      z.array(str).optional(),
      contains:   str.optional(),
      startsWith: str.optional(),
      endsWith:   str.optional(),
      mode:       z.enum(['default', 'insensitive']).optional(),
    }).partial(),
  ]).optional()
}

function createNumericFilter(base: ZodTypeAny): ZodTypeAny {
  return z.union([
    base,
    z.object({
      equals: base.optional(),
      not:    z.union([base, z.lazy(() => createNumericFilter(base))]).optional(),
      in:     z.array(base).optional(),
      notIn:  z.array(base).optional(),
      lt:     base.optional(),
      lte:    base.optional(),
      gt:     base.optional(),
      gte:    base.optional(),
    }).partial(),
  ]).optional()
}

function createBooleanFilter(): ZodTypeAny {
  const bool = z.boolean()
  return z.union([
    bool,
    z.object({
      equals: bool.optional(),
      not:    z.union([bool, z.lazy(() => createBooleanFilter())]).optional(),
    }).partial(),
  ]).optional()
}

function createDateTimeFilter(): ZodTypeAny {
  const date = z.union([z.string(), z.date()])
  return z.union([
    date,
    z.object({
      equals: date.optional(),
      not:    z.union([date, z.lazy(() => createDateTimeFilter())]).optional(),
      in:     z.array(date).optional(),
      notIn:  z.array(date).optional(),
      lt:     date.optional(),
      lte:    date.optional(),
      gt:     date.optional(),
      gte:    date.optional(),
    }).partial(),
  ]).optional()
}

function fieldFilter(type: string, isList: boolean): ZodTypeAny {
  if (isList) return z.any().optional()
  switch (type) {
    case 'String':   return createStringFilter()
    case 'Int':      return createNumericFilter(z.number().int())
    case 'Float':    return createNumericFilter(z.number())
    case 'BigInt':   return createNumericFilter(z.bigint())
    case 'Decimal':  return createNumericFilter(z.union([z.string(), z.number()]))
    case 'Boolean':  return createBooleanFilter()
    case 'DateTime': return createDateTimeFilter()
    case 'Json':     return z.any().optional()
    case 'Bytes':    return z.instanceof(Uint8Array).optional()
    default:         return z.any().optional()
  }
}

// ─── Public schema builders ───────────────────────────────────────────────────

/** Prisma-style filter for all scalar fields + AND / OR / NOT */
export function buildWhereSchema(modelName: string, fields: McpFieldDef[]): ZodTypeAny {
  return cached(`${modelName}:where`, () => {
    const shape: Record<string, ZodTypeAny> = {}
    for (const f of fields) {
      if (!f.isRelation) shape[f.name] = fieldFilter(f.type, f.isList)
    }
    const base = z.object(shape).partial()
    return z.object({
      ...shape,
      AND: z.union([z.lazy(() => base), z.array(z.lazy(() => base))]).optional(),
      OR:  z.array(z.lazy(() => base)).optional(),
      NOT: z.union([z.lazy(() => base), z.array(z.lazy(() => base))]).optional(),
    }).partial().optional()
  })
}

/** Where clause restricted to id fields — used by findUnique */
export function buildWhereUniqueSchema(modelName: string, fields: McpFieldDef[]): ZodTypeAny {
  return cached(`${modelName}:whereUnique`, () => {
    const shape: Record<string, ZodTypeAny> = {}
    for (const f of fields) {
      if (f.isId || f.isUnique) shape[f.name] = fieldTypeToZod(f.type, f.isList, true)
    }
    return z.object(shape).partial().refine(
      (v) => Object.values(v).some((x) => x !== undefined),
      { message: 'At least one id field must be provided' },
    )
  })
}

/** orderBy: { field: 'asc' | 'desc' }[] or single object */
export function buildOrderBySchema(modelName: string, fields: McpFieldDef[]): ZodTypeAny {
  return cached(`${modelName}:orderBy`, () => {
    const shape: Record<string, ZodTypeAny> = {}
    const dir = z.enum(['asc', 'desc']).optional()
    for (const f of fields) {
      if (!f.isRelation) shape[f.name] = dir
    }
    const obj = z.object(shape).partial()
    return z.union([obj, z.array(obj)]).optional()
  })
}
