import type { McpModelDef, McpOperation } from "../types.js";

type ZodIssue = { message: string; path: Array<string | number> };

type ArgsSchema = {
  safeParse: (v: unknown) => {
    success: boolean;
    error?: { issues: ZodIssue[] };
  };
};

/**
 * Structural view of the ORM's `ZodSchemaFactory` (from
 * `createQuerySchemaFactory` in `@zenstackhq/orm`), limited to the methods we
 * call. Keeping it structural avoids threading the Schema generic through
 * every tool and keeps tests mockable.
 */
export type QuerySchemaFactory = {
  [M in (typeof OPERATION_SCHEMA_METHOD)[McpOperation]]: (
    model: string,
    options?: { relationDepth?: number },
  ) => ArgsSchema;
} & {
  makeProcedureArgsSchema: (procName: string) => ArgsSchema;
};

/**
 * Maps every CRUD operation to the factory method building its full-args
 * schema. The `*OrThrow` variants take the same args as their base operation
 * and have no dedicated factory method.
 */
export const OPERATION_SCHEMA_METHOD = {
  findUnique: "makeFindUniqueSchema",
  findUniqueOrThrow: "makeFindUniqueSchema",
  findFirst: "makeFindFirstSchema",
  findFirstOrThrow: "makeFindFirstSchema",
  findMany: "makeFindManySchema",
  exists: "makeExistsSchema",
  create: "makeCreateSchema",
  createMany: "makeCreateManySchema",
  createManyAndReturn: "makeCreateManyAndReturnSchema",
  update: "makeUpdateSchema",
  updateMany: "makeUpdateManySchema",
  updateManyAndReturn: "makeUpdateManyAndReturnSchema",
  upsert: "makeUpsertSchema",
  delete: "makeDeleteSchema",
  deleteMany: "makeDeleteManySchema",
  count: "makeCountSchema",
  aggregate: "makeAggregateSchema",
  groupBy: "makeGroupBySchema",
} as const satisfies Record<McpOperation, string>;

export type ValidationResult =
  | { valid: true }
  | { valid: false; errors: string[] };

export interface ValidateOptions {
  requireWhereForBulk?: boolean;
  /** Relation-nesting depth passed to the factory; omit for unlimited. */
  relationDepth?: number;
  /** Global cap on `take`; combined with the model's `limit` via `min`. */
  maxTake?: number;
}

function formatIssues(issues: ZodIssue[]): string[] {
  return issues.map((i) =>
    i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message,
  );
}

export function validateOperation(
  models: McpModelDef[],
  model: string,
  operation: string,
  args: Record<string, unknown>,
  factory: QuerySchemaFactory,
  options: ValidateOptions = {},
): ValidationResult {
  const modelDef = models.find((m) => m.name === model);
  if (!modelDef) {
    return {
      valid: false,
      errors: [
        `Unknown model "${model}". Available: ${models.map((m) => m.name).join(", ")}`,
      ],
    };
  }

  if (!modelDef.operations.includes(operation as McpOperation)) {
    return {
      valid: false,
      errors: [
        `Operation "${operation}" not available on "${model}". Available: ${modelDef.operations.join(", ")}`,
      ],
    };
  }

  const errors: string[] = [];

  if (
    options.requireWhereForBulk &&
    (operation === "deleteMany" ||
      operation === "updateMany" ||
      operation === "updateManyAndReturn")
  ) {
    const where = args.where;
    const isEmpty =
      !where ||
      (typeof where === "object" &&
        !Array.isArray(where) &&
        Object.keys(where as object).length === 0);
    if (isEmpty) {
      errors.push(
        `"where" must not be absent or empty for "${operation}" — set requireWhereForBulk: false to allow bulk operations without a filter`,
      );
    }
  }

  // Cap `take` at min(@@mcp(limit: N), maxTake) when the caller provides one.
  const caps = [modelDef.limit, options.maxTake].filter(
    (c): c is number => typeof c === "number",
  );
  if (caps.length > 0 && typeof args.take === "number") {
    const cap = Math.min(...caps);
    if (args.take > cap) {
      errors.push(`take: must not exceed ${cap} for "${model}"`);
    }
  }

  // Full-args validation via the ORM's own query schema (strict: unknown keys
  // are rejected; where/select/include/orderBy/cursor/data are all covered).
  const method = OPERATION_SCHEMA_METHOD[operation as McpOperation];
  const factoryOptions =
    options.relationDepth !== undefined && Number.isFinite(options.relationDepth)
      ? { relationDepth: options.relationDepth }
      : undefined;
  try {
    const schema = factory[method](model, factoryOptions);
    const result = schema.safeParse(args);
    if (!result.success && result.error) {
      errors.push(...formatIssues(result.error.issues));
    }
  } catch (err) {
    // Schema construction itself failed (e.g. a model without unique fields
    // for a unique operation) — surface it instead of skipping validation.
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`Cannot validate "${operation}" on "${model}": ${message}`);
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}
